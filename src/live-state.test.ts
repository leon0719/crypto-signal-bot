import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LivePosition,
  readControlState,
  readLiveLedger,
  writeControlState,
  writeLiveLedger,
} from "./live-state.js";

const pos = (over: Partial<LivePosition> = {}): LivePosition => ({
  key: "BTCUSDT:SHORT:1700000000000",
  symbol: "BTCUSDT",
  instId: "BTC-USDT-SWAP",
  dir: "SHORT",
  contracts: "1.5",
  entry: 65000,
  stop: 67000,
  target: 62000,
  leverage: 3,
  mode: "dry",
  ordId: null,
  openedAt: "2026-07-17T00:00:00.000Z",
  status: "OPEN",
  ...over,
});

describe("live-state", () => {
  it("ledger 讀不到檔回空帳;寫入後可讀回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-"));
    const p = join(dir, "ledger.json");
    expect((await readLiveLedger(p)).positions).toEqual([]);
    await writeLiveLedger(p, { positions: [pos()] });
    const back = await readLiveLedger(p);
    expect(back.positions.length).toBe(1);
    expect(back.positions[0].instId).toBe("BTC-USDT-SWAP");
    await rm(dir, { recursive: true });
  });

  it("控制檔不存在 → enabled:false(fail-closed);寫入後可讀回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-"));
    const p = join(dir, "control.json");
    expect((await readControlState(p)).enabled).toBe(false);
    await writeControlState(p, { enabled: true });
    expect((await readControlState(p)).enabled).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("控制檔內容損壞 → enabled:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-"));
    const p = join(dir, "control.json");
    await Bun.write(p, "not json");
    expect((await readControlState(p)).enabled).toBe(false);
    await rm(dir, { recursive: true });
  });
});
