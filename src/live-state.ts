// 實盤下單的持久化:帳本(live ledger)與自動下單開關(control state)。
// 兩者都是 JSON 檔,沿用 paper-state 的原子寫檔(tmp→rename)。
// 開關 fail-closed:讀不到/壞掉一律視為「關閉」;帳本 fail-soft:讀不到當空帳。
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LivePosition {
  key: string; // 冪等鍵:symbol:dir:barOpenTime
  symbol: string;
  instId: string;
  dir: "LONG" | "SHORT";
  contracts: string; // 合約張數(字串,依 lotSz 位數)
  entry: number;
  stop: number;
  target: number;
  leverage: number;
  mode: "dry" | "real";
  ordId: string | null; // dry 模式為 null
  openedAt: string;
  status: "OPEN" | "CLOSED";
  closedAt?: string;
  closeReason?: string;
}

export interface LiveLedger {
  positions: LivePosition[];
  updatedAt?: string;
}

export interface ControlState {
  enabled: boolean;
  updatedAt?: string;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readLiveLedger(path: string): Promise<LiveLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LiveLedger>;
    return { positions: Array.isArray(parsed.positions) ? parsed.positions : [] };
  } catch {
    return { positions: [] };
  }
}

export async function writeLiveLedger(path: string, ledger: LiveLedger): Promise<void> {
  await writeJsonAtomic(path, { ...ledger, updatedAt: new Date().toISOString() });
}

export async function readControlState(path: string): Promise<ControlState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ControlState>;
    return { enabled: parsed.enabled === true };
  } catch {
    return { enabled: false };
  }
}

export async function writeControlState(path: string, state: ControlState): Promise<void> {
  await writeJsonAtomic(path, { ...state, updatedAt: new Date().toISOString() });
}

// 跨行程檔案鎖:以 mkdir 原子性搶鎖(EEXIST = 別人持有)。逾時 staleMs 視為死鎖殘留,接管。
// 用於序列化 live ledger 的讀-改-寫(排程器的緊急平倉與 detect 子行程可能同時操作)。
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: { retryMs?: number; timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lockDir = `${path}.lock`;
  const retryMs = opts.retryMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir); // recursive:false → 已存在時拋 EEXIST,即原子搶鎖
      break;
    } catch {
      // 鎖被持有:檢查是否為死鎖殘留(超過 staleMs 未釋放則接管)
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {} // 鎖剛好被釋放,下一輪重試
      if (Date.now() > deadline) throw new Error(`取得檔案鎖逾時:${lockDir}`);
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
