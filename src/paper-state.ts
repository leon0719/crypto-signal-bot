// 紙上交易帳的持久化:以 JSON 檔記錄所有部位(未結+已結)與起始權益。
// 沿用 state.ts 的原子寫檔(tmp→rename)。fail-soft:讀不到/壞掉都當空帳。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PaperPosition } from "./paper.js";

export interface PaperLedger {
  startEquity: number;
  positions: PaperPosition[];
  updatedAt?: string;
}

export async function readLedger(path: string, startEquity: number): Promise<PaperLedger> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PaperLedger>;
    return {
      startEquity: parsed.startEquity ?? startEquity,
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
    };
  } catch {
    return { startEquity, positions: [] };
  }
}

export async function writeLedger(path: string, ledger: PaperLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}
