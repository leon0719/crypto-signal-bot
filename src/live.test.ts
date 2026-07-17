import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Opportunity } from "./detect.js";
import {
  barOpenOf,
  executeLive,
  floorToStep,
  type LiveConfig,
  type LiveIo,
  planOrder,
  reconcileLedger,
  roundToStep,
} from "./live.js";
import { readLiveLedger, writeControlState, writeLiveLedger } from "./live-state.js";
import type { OkxInstrument } from "./okx.js";

const INST: OkxInstrument = {
  instId: "BTC-USDT-SWAP",
  ctVal: 0.01,
  lotSz: "0.1",
  minSz: "0.1",
  tickSz: "0.1",
};

const opp = (over: Partial<Opportunity> = {}): Opportunity => ({
  symbol: "BTCUSDT",
  dir: "SHORT",
  entry: 65000,
  stop: 67000, // 2×ATR=2000 → ATR=1000,atrPct≈1.54 → 槓桿 3x(risk.ts)
  target: 62000,
  score: -5,
  regime: "趨勢",
  adx: 30,
  htf1d: -3,
  oi: -1,
  ...over,
});

describe("步長取整", () => {
  it("floorToStep 依步長向下取整並保留位數", () => {
    expect(floorToStep(1.2345, "0.1")).toBe("1.2");
    expect(floorToStep(7, "1")).toBe("7");
    expect(floorToStep(0.29999999, "0.001")).toBe("0.299");
  });
  it("roundToStep 四捨五入到步長", () => {
    expect(roundToStep(64999.96, "0.1")).toBe("65000.0");
    expect(roundToStep(0.123456, "0.0001")).toBe("0.1235");
  });
});

describe("barOpenOf", () => {
  it("對齊週期開盤時間", () => {
    const fourH = 4 * 3_600_000;
    expect(barOpenOf(fourH * 10 + 123456, fourH)).toBe(fourH * 10);
  });
});

describe("planOrder", () => {
  it("風險 1%:數量 = 權益×1% ÷ 停損距離,換成合約張數", () => {
    // 權益 2000 → 風險 20 USDT;停損距離 2000 → 0.01 BTC → ctVal 0.01 → 1 張
    const plan = planOrder(opp(), 2000, INST, 0.01);
    if ("skip" in plan) throw new Error(plan.skip);
    expect(plan.contracts).toBe("1.0");
    expect(plan.side).toBe("sell"); // SHORT → sell
    expect(plan.leverage).toBe(3);
    expect(plan.tpPx).toBe("62000.0"); // target
    expect(plan.slPx).toBe("67000.0"); // stop
    expect(plan.notional).toBeCloseTo(1 * 0.01 * 65000);
    expect(plan.margin).toBeCloseTo(plan.notional / 3);
  });

  it("LONG → buy", () => {
    const plan = planOrder(opp({ dir: "LONG", stop: 63000, target: 68000 }), 2000, INST, 0.01);
    if ("skip" in plan) throw new Error(plan.skip);
    expect(plan.side).toBe("buy");
  });

  it("低於最小下單量 → skip", () => {
    // 權益 100 → 風險 1 USDT;距離 2000 → 0.0005 BTC = 0.05 張 < minSz 0.1
    const plan = planOrder(opp(), 100, INST, 0.01);
    expect("skip" in plan && plan.skip).toContain("最小下單量");
  });

  it("停損距離為 0 → skip(fail-closed)", () => {
    const plan = planOrder(opp({ stop: 65000 }), 2000, INST, 0.01);
    expect("skip" in plan).toBe(true);
  });
});

afterEach(() => {
  mock.restore();
});

// OKX API stub:依 URL 分路;記錄下單 body。
function stubOkxApi(overrides: Partial<Record<string, unknown>> = {}) {
  const orders: unknown[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (data: unknown) => new Response(JSON.stringify({ code: "0", msg: "", data }));
    if (url.includes("/account/balance")) {
      return reply(
        overrides.balance ?? [
          { details: [{ ccy: "USDT", eq: "2000", availBal: "2000", upl: "0" }] },
        ],
      );
    }
    if (url.includes("/public/instruments")) {
      return reply([
        { instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" },
      ]);
    }
    if (url.includes("/account/set-leverage")) return reply([{}]);
    if (url.includes("/trade/order")) {
      orders.push(init?.body ? JSON.parse(String(init.body)) : null);
      return reply([{ ordId: "ord-1", sCode: "0", sMsg: "" }]);
    }
    if (url.includes("/account/positions")) return reply(overrides.positions ?? []);
    return new Response(JSON.stringify({ code: "1", msg: `無路由 ${url}`, data: [] }));
  }) as unknown as typeof fetch;
  return orders;
}

async function makeEnv(mode: "dry" | "real", enabled: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "live-exec-"));
  const cfg: LiveConfig = {
    mode,
    riskPct: 0.01,
    maxPositions: 4,
    ledgerPath: join(dir, "ledger.json"),
    controlPath: join(dir, "control.json"),
    intervalMs: 4 * 3_600_000,
  };
  await writeControlState(cfg.controlPath, { enabled });
  const notes: string[] = [];
  const io: LiveIo = {
    creds: { apiKey: "k", secret: "s", passphrase: "p" },
    notify: async (t) => {
      notes.push(t);
    },
    lastPrice: async () => null,
    now: () => 4 * 3_600_000 * 1000, // 固定時間,冪等鍵可預測
  };
  return { dir, cfg, io, notes };
}

describe("executeLive", () => {
  it("開關關閉:不打 API、不下單", async () => {
    const { dir, cfg, io } = await makeEnv("real", false);
    const orders = stubOkxApi();
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(0);
    expect(orders.length).toBe(0);
    await rm(dir, { recursive: true });
  });

  it("real 模式:下單、寫帳、通報", async () => {
    const { dir, cfg, io, notes } = await makeEnv("real", true);
    const orders = stubOkxApi();
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(1);
    expect(orders.length).toBe(1);
    const ledger = await readLiveLedger(cfg.ledgerPath);
    expect(ledger.positions[0].mode).toBe("real");
    expect(ledger.positions[0].ordId).toBe("ord-1");
    expect(notes.some((t) => t.includes("BTCUSDT"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("dry 模式:不打下單 API,但寫帳(mode:dry)並通報【模擬】", async () => {
    const { dir, cfg, io, notes } = await makeEnv("dry", true);
    const orders = stubOkxApi();
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(1);
    expect(orders.length).toBe(0); // 不打 /trade/order
    const ledger = await readLiveLedger(cfg.ledgerPath);
    expect(ledger.positions[0].mode).toBe("dry");
    expect(ledger.positions[0].ordId).toBeNull();
    expect(notes.some((t) => t.includes("【模擬】"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("冪等:同一根棒同訊號跑兩次只下一次單", async () => {
    const { dir, cfg, io } = await makeEnv("real", true);
    const orders = stubOkxApi();
    await executeLive([opp()], cfg, io);
    const res2 = await executeLive([opp()], cfg, io);
    expect(res2.opened).toBe(0);
    expect(orders.length).toBe(1);
    await rm(dir, { recursive: true });
  });

  it("倉位上限:OPEN 達上限後跳過新訊號", async () => {
    const { dir, cfg, io } = await makeEnv("real", true);
    cfg.maxPositions = 1;
    stubOkxApi({
      positions: [
        {
          instId: "ETH-USDT-SWAP",
          pos: "1",
          avgPx: "3000",
          markPx: "3000",
          upl: "0",
          uplRatio: "0",
          lever: "3",
        },
      ],
    });
    await writeLiveLedger(cfg.ledgerPath, {
      positions: [
        {
          key: "ETHUSDT:LONG:0",
          symbol: "ETHUSDT",
          instId: "ETH-USDT-SWAP",
          dir: "LONG",
          contracts: "1",
          entry: 3000,
          stop: 2900,
          target: 3200,
          leverage: 3,
          mode: "real",
          ordId: "x",
          openedAt: "",
          status: "OPEN",
        },
      ],
    });
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(0);
    expect(res.skipped.some((s) => s.includes("上限"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("餘額查詢失敗:整輪中止並告警(fail-closed)", async () => {
    const { dir, cfg, io, notes } = await makeEnv("real", true);
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/account/positions")) {
        return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
      }
      return new Response(JSON.stringify({ code: "50000", msg: "服務異常", data: [] }));
    }) as unknown as typeof fetch;
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(0);
    expect(notes.some((t) => t.includes("告警") || t.includes("失敗"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("單筆失敗:告警後繼續下一筆(失敗不拖垮整輪)", async () => {
    const { dir, cfg, io, notes } = await makeEnv("real", true);
    const orders: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const reply = (data: unknown) => new Response(JSON.stringify({ code: "0", msg: "", data }));
      if (url.includes("/account/balance"))
        return reply([{ details: [{ ccy: "USDT", eq: "2000", availBal: "2000", upl: "0" }] }]);
      if (url.includes("/public/instruments")) {
        // ETH 規格查詢回業務錯誤(不重試);BTC 正常
        if (url.includes("ETH-USDT-SWAP"))
          return new Response(JSON.stringify({ code: "51001", msg: "合約不存在", data: [] }));
        return reply([
          { instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" },
        ]);
      }
      if (url.includes("/account/set-leverage")) return reply([{}]);
      if (url.includes("/trade/order")) {
        orders.push(init?.body ? JSON.parse(String(init.body)) : null);
        return reply([{ ordId: "ord-1", sCode: "0", sMsg: "" }]);
      }
      if (url.includes("/account/positions")) return reply([]);
      return new Response(JSON.stringify({ code: "1", msg: `無路由 ${url}`, data: [] }));
    }) as unknown as typeof fetch;

    const ethOpp = opp({ symbol: "ETHUSDT", entry: 3000, stop: 3100, target: 2850 });
    const res = await executeLive([ethOpp, opp()], cfg, io);
    expect(res.opened).toBe(1); // ETH 失敗,BTC 照下
    expect(orders.length).toBe(1);
    expect(res.skipped.some((s) => s.includes("ETHUSDT"))).toBe(true);
    expect(notes.some((t) => t.includes("🚨") && t.includes("ETHUSDT"))).toBe(true);
    await rm(dir, { recursive: true });
  });
});

describe("reconcileLedger", () => {
  it("real:交易所已無倉位 → 標 CLOSED", async () => {
    const { dir, cfg, io } = await makeEnv("real", true);
    stubOkxApi({ positions: [] }); // 交易所空倉
    await writeLiveLedger(cfg.ledgerPath, {
      positions: [
        {
          key: "BTCUSDT:SHORT:0",
          symbol: "BTCUSDT",
          instId: "BTC-USDT-SWAP",
          dir: "SHORT",
          contracts: "1",
          entry: 65000,
          stop: 67000,
          target: 62000,
          leverage: 3,
          mode: "real",
          ordId: "x",
          openedAt: "",
          status: "OPEN",
        },
      ],
    });
    const ledger = await readLiveLedger(cfg.ledgerPath);
    const closed = await reconcileLedger(ledger, cfg, io);
    expect(closed).toEqual(["BTCUSDT:SHORT:0"]);
    expect(ledger.positions[0].status).toBe("CLOSED");
    await rm(dir, { recursive: true });
  });

  it("dry:現價觸及停損 → 標 CLOSED(模擬)", async () => {
    const { dir, cfg, io } = await makeEnv("dry", true);
    io.lastPrice = async () => 67500; // SHORT 停損 67000 已觸及
    await writeLiveLedger(cfg.ledgerPath, {
      positions: [
        {
          key: "BTCUSDT:SHORT:0",
          symbol: "BTCUSDT",
          instId: "BTC-USDT-SWAP",
          dir: "SHORT",
          contracts: "1",
          entry: 65000,
          stop: 67000,
          target: 62000,
          leverage: 3,
          mode: "dry",
          ordId: null,
          openedAt: "",
          status: "OPEN",
        },
      ],
    });
    const ledger = await readLiveLedger(cfg.ledgerPath);
    const closed = await reconcileLedger(ledger, cfg, io);
    expect(closed.length).toBe(1);
    expect(ledger.positions[0].closeReason).toContain("模擬");
    await rm(dir, { recursive: true });
  });
});
