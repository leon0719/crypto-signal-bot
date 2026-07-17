// 實盤下單的持久化:帳本(live ledger)與自動下單開關(control state)。
// 兩者都是 JSON 檔,沿用 paper-state 的原子寫檔(tmp→rename)。
// 開關 fail-closed:讀不到/壞掉一律視為「關閉」;帳本 fail-soft:讀不到當空帳。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
