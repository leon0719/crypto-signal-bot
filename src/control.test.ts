import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDeps, handleCommand, parseCommand, pollOnce } from "./control.js";
import {
  readControlState,
  readLiveLedger,
  writeControlState,
  writeLiveLedger,
} from "./live-state.js";

afterEach(() => {
  mock.restore();
});

async function makeDeps(mode: "dry" | "real" = "real") {
  const dir = await mkdtemp(join(tmpdir(), "ctl-"));
  const posts: string[] = [];
  const deps: ControlDeps = {
    cfg: {
      mode,
      riskPct: 0.01,
      maxPositions: 4,
      ledgerPath: join(dir, "ledger.json"),
      controlPath: join(dir, "control.json"),
      intervalMs: 4 * 3_600_000,
    },
    creds: { apiKey: "k", secret: "s", passphrase: "p" },
    post: async (t) => {
      posts.push(t);
    },
    runReport: mock(async () => {}),
    nextScanText: () => "2026-07-17T08:02:00Z",
    slackToken: "xoxb-test",
    channel: "C123",
  };
  return { dir, deps, posts };
}

describe("parseCommand", () => {
  it("完全比對(含 trim);其他文字回 null", () => {
    expect(parseCommand(" 啟動自動下單 ")).toBe("start");
    expect(parseCommand("停止自動下單")).toBe("stop");
    expect(parseCommand("緊急平倉")).toBe("panic");
    expect(parseCommand("狀態")).toBe("status");
    expect(parseCommand("餘額")).toBe("balance");
    expect(parseCommand("倉位")).toBe("positions");
    expect(parseCommand("成績")).toBe("report");
    expect(parseCommand("指令")).toBe("help");
    expect(parseCommand("啟動")).toBeNull();
    expect(parseCommand("BTCUSDT 4h")).toBeNull();
  });
});

describe("handleCommand", () => {
  it("start/stop 切換開關並持久化", async () => {
    const { dir, deps } = await makeDeps();
    const on = await handleCommand("start", deps);
    expect(on).toContain("✅");
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(true);
    const off = await handleCommand("stop", deps);
    expect(off).toContain("🛑");
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    await rm(dir, { recursive: true });
  });

  it("balance 回權益/可用/未實現", async () => {
    const { dir, deps } = await makeDeps();
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            code: "0",
            msg: "",
            data: [{ details: [{ ccy: "USDT", eq: "2100.5", availBal: "1800", upl: "15.2" }] }],
          }),
        ),
    ) as unknown as typeof fetch;
    const text = await handleCommand("balance", deps);
    expect(text).toContain("2100.5");
    expect(text).toContain("1800");
    await rm(dir, { recursive: true });
  });

  it("panic:關開關+平掉 ledger 內 real OPEN 倉(不碰非自動倉)", async () => {
    const { dir, deps } = await makeDeps("real");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
    const closeCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        closeCalls.push(String(init?.body));
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      if (url.includes("/account/positions")) {
        // 對帳:交易所倉位方向與帳本(SHORT)一致 → pos < 0
        return new Response(
          JSON.stringify({
            code: "0",
            msg: "",
            data: [
              {
                instId: "BTC-USDT-SWAP",
                pos: "-1",
                avgPx: "65000",
                markPx: "65000",
                upl: "0",
                uplRatio: "0",
                lever: "3",
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    expect(closeCalls.length).toBe(1);
    expect(text).toContain("BTC");
    await rm(dir, { recursive: true });
  });

  it("panic:單筆平倉失敗 → 該筆保持 OPEN、其他筆照平、回報請手動處理", async () => {
    const { dir, deps } = await makeDeps("real");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    const { readLiveLedger: readLedger } = await import("./live-state.js");
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
          ordId: "y",
          openedAt: "",
          status: "OPEN",
        },
      ],
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        const body = JSON.parse(String(init?.body)) as { instId: string };
        if (body.instId === "BTC-USDT-SWAP") {
          return new Response(JSON.stringify({ code: "51010", msg: "平倉失敗", data: [] }));
        }
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      if (url.includes("/account/positions")) {
        return new Response(
          JSON.stringify({
            code: "0",
            msg: "",
            data: [
              {
                instId: "BTC-USDT-SWAP",
                pos: "-1",
                avgPx: "65000",
                markPx: "65000",
                upl: "0",
                uplRatio: "0",
                lever: "3",
              },
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
          }),
        );
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect(text).toContain("請手動處理");
    const ledger = await readLedger(deps.cfg.ledgerPath);
    const btc = ledger.positions.find((p) => p.symbol === "BTCUSDT");
    const eth = ledger.positions.find((p) => p.symbol === "ETHUSDT");
    expect(btc?.status).toBe("OPEN"); // 失敗的保持 OPEN
    expect(eth?.status).toBe("CLOSED"); // 成功的照平
    await rm(dir, { recursive: true });
  });

  it("I3:交易所端已無倉位 → 對帳標 CLOSED,不呼叫 closePosition", async () => {
    const { dir, deps } = await makeDeps("real");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
    const closeCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        closeCalls.push(String(init?.body));
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      if (url.includes("/account/positions")) {
        return new Response(JSON.stringify({ code: "0", msg: "", data: [] })); // 交易所已空倉
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect(closeCalls.length).toBe(0);
    const ledger = await readLiveLedger(deps.cfg.ledgerPath);
    expect(ledger.positions[0].status).toBe("CLOSED");
    expect(ledger.positions[0].closeReason).toContain("已出場");
    expect(text).toContain("BTCUSDT");
    await rm(dir, { recursive: true });
  });

  it("I3:交易所倉位方向與帳本不符 → 不平倉、保持 OPEN、提示疑似手動倉", async () => {
    const { dir, deps } = await makeDeps("real");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
    const closeCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        closeCalls.push(String(init?.body));
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      if (url.includes("/account/positions")) {
        // 帳本是 SHORT,但交易所是多倉 → 方向不符
        return new Response(
          JSON.stringify({
            code: "0",
            msg: "",
            data: [
              {
                instId: "BTC-USDT-SWAP",
                pos: "1",
                avgPx: "65000",
                markPx: "65000",
                upl: "0",
                uplRatio: "0",
                lever: "3",
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect(closeCalls.length).toBe(0);
    const ledger = await readLiveLedger(deps.cfg.ledgerPath);
    expect(ledger.positions[0].status).toBe("OPEN");
    expect(text).toContain("疑似手動倉");
    await rm(dir, { recursive: true });
  });

  it("I3:對帳(fetchPositions)失敗 → 中止整個平倉流程,不執行任何平倉", async () => {
    const { dir, deps } = await makeDeps("real");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
    const closeCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        closeCalls.push(String(init?.body));
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      if (url.includes("/account/positions")) {
        return new Response(JSON.stringify({ code: "50000", msg: "服務異常", data: [] }));
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect(closeCalls.length).toBe(0);
    const ledger = await readLiveLedger(deps.cfg.ledgerPath);
    expect(ledger.positions[0].status).toBe("OPEN"); // 未變動
    expect(text).toContain("對帳失敗");
    await rm(dir, { recursive: true });
  });

  it("I4:cfg.mode 為 dry 但帳本有 real OPEN → panic 仍發出真實平倉", async () => {
    const { dir, deps } = await makeDeps("dry");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
    const closeCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        closeCalls.push(String(init?.body));
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      if (url.includes("/account/positions")) {
        return new Response(
          JSON.stringify({
            code: "0",
            msg: "",
            data: [
              {
                instId: "BTC-USDT-SWAP",
                pos: "-1",
                avgPx: "65000",
                markPx: "65000",
                upl: "0",
                uplRatio: "0",
                lever: "3",
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect(closeCalls.length).toBe(1);
    const ledger = await readLiveLedger(deps.cfg.ledgerPath);
    expect(ledger.positions[0].status).toBe("CLOSED");
    expect(ledger.positions[0].closeReason).toBe("緊急平倉");
    expect(text).toContain("BTCUSDT");
    await rm(dir, { recursive: true });
  });

  it("I4:狀態查詢在 dry 模式下提示帳本仍有 real 倉位", async () => {
    const { dir, deps } = await makeDeps("dry");
    await writeLiveLedger(deps.cfg.ledgerPath, {
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
    const text = await handleCommand("status", deps);
    expect(text).toContain("⚠️");
    expect(text).toContain("1 筆 real 倉位");
    await rm(dir, { recursive: true });
  });

  it("status 回開關/模式/倉位數/下次掃描", async () => {
    const { dir, deps } = await makeDeps("dry");
    const text = await handleCommand("status", deps);
    expect(text).toContain("dry");
    expect(text).toContain("關閉");
    expect(text).toContain("2026-07-17T08:02:00Z");
    await rm(dir, { recursive: true });
  });

  it("report 觸發 runReport", async () => {
    const { dir, deps } = await makeDeps();
    await handleCommand("report", deps);
    expect((deps.runReport as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    await rm(dir, { recursive: true });
  });
});

describe("pollOnce", () => {
  it("讀新訊息、忽略 bot 訊息、依時序處理、回新 lastTs", async () => {
    const { dir, deps, posts } = await makeDeps();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "1700000002.000", text: "停止自動下單", user: "U1" },
              { ts: "1700000001.500", text: "我是機器人", bot_id: "B1" },
              { ts: "1700000001.000", text: "啟動自動下單", user: "U1" },
            ],
          }),
        );
      }
      // chat.postMessage(回覆)
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const newTs = await pollOnce(deps, "1700000000.000");
    expect(newTs).toBe("1700000002.000");
    // 先啟動後停止 → 最終關閉
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    expect(posts.length).toBe(2); // 兩個指令各回覆一次
    await rm(dir, { recursive: true });
  });

  it("I2:回覆失敗只記 log,lastTs 仍前進且後續訊息繼續處理(開關狀態仍被更新)", async () => {
    const { dir, deps } = await makeDeps();
    deps.post = async () => {
      throw new Error("Slack 回覆失敗");
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "1700000001.000", text: "啟動自動下單", user: "U1" },
              { ts: "1700000002.000", text: "停止自動下單", user: "U1" },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const newTs = await pollOnce(deps, "1700000000.000"); // 不應拋出
    expect(newTs).toBe("1700000002.000");
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    await rm(dir, { recursive: true });
  });

  it("無新訊息:lastTs 不變、不回覆", async () => {
    const { dir, deps, posts } = await makeDeps();
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ ok: true, messages: [] })),
    ) as unknown as typeof fetch;
    const newTs = await pollOnce(deps, "1700000000.000");
    expect(newTs).toBe("1700000000.000");
    expect(posts.length).toBe(0);
    await rm(dir, { recursive: true });
  });
});
