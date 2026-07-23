import { describe, expect, test } from "bun:test";
import { buildBubble, buildFlexMessage } from "./format.js";
import { build, defaultConfig, evalAt } from "./signal.js";
import {
  type AnalyzeCommand,
  Direction,
  type HtfInfo,
  type Kline,
  type OiInfo,
  type Result,
} from "./types.js";

// 造一段穩定上升趨勢,讓末根產生明確做多訊號。
function uptrend(n: number): Kline[] {
  const out: Kline[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1.01;
    const close = price;
    out.push({
      openTime: i * 3600_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1000 + i,
    });
  }
  return out;
}

const meta: AnalyzeCommand = {
  help: false,
  symbol: "BTCUSDT",
  interval: "4h",
  market: "futures",
  leverage: 1,
};

function longSetup(): { ind: ReturnType<typeof build>; res: Result } {
  const cfg = { ...defaultConfig(), volumeFilter: false };
  const ind = build(uptrend(300), cfg);
  const res = evalAt(ind, ind.klines.length - 1);
  if (!res) throw new Error("測試資料應產生有效訊號");
  return { ind, res };
}

// buildFlexMessage 必回 flex 訊息,收斂型別以便讀 altText/contents。
function asFlex(m: ReturnType<typeof buildFlexMessage>): { altText: string; contents: unknown } {
  return m as unknown as { altText: string; contents: unknown };
}

describe("buildFlexMessage 大週期確認", () => {
  test("大週期一致 → 維持做多(方向、altText)", () => {
    const { ind, res } = longSetup();
    expect(res.direction).toBe(Direction.Long);
    const htf: HtfInfo = { interval: "1d", score: 40, conflict: false };
    const msg = asFlex(buildFlexMessage(meta, ind, res, htf));
    expect(msg.altText).toContain("做多");
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("方向一致 ✓");
    // 出場指引:移動停損(走動前推 23 季驗證,距離 = cfg.stopATR×ATR)。
    expect(blob).toContain("移動停損");
    expect(blob).toContain("波段高點 − 2×ATR");
  });

  test("有即時價 → 卡片顯示即時價 + 標註訊號依收盤價", () => {
    const { ind, res } = longSetup();
    const htf: HtfInfo = { interval: "1d", score: 40, conflict: false };
    const live = res.price * 1.05; // 即時價與收盤價不同
    const msg = asFlex(buildFlexMessage(meta, ind, res, htf, undefined, live));
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("即時價");
    expect(blob).toContain("訊號依 4h 收盤");
  });

  test("無即時價(null)→ 退回收盤價、標籤為「價格」", () => {
    const { ind, res } = longSetup();
    const htf: HtfInfo = { interval: "1d", score: 40, conflict: false };
    const msg = asFlex(buildFlexMessage(meta, ind, res, htf, undefined, null));
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("價格");
    expect(blob).not.toContain("即時價");
  });

  test("大週期牴觸 → 整張卡降級觀望(標題與 altText 不再顯示做多)", () => {
    const { ind, res } = longSetup();
    const htf: HtfInfo = { interval: "1d", score: -40, conflict: true };
    const msg = asFlex(buildFlexMessage(meta, ind, res, htf));
    // altText 與標題方向都應為觀望,而非做多。
    expect(msg.altText).toContain("觀望");
    expect(msg.altText).not.toContain("做多");
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("觀望");
    expect(blob).toContain("方向牴觸 ✗");
    expect(blob).toContain("不建議逆勢進場");
    // 衝突時不應再出現交易規劃。
    expect(blob).not.toContain("交易規劃");
  });
});

describe("buildFlexMessage OI 確認", () => {
  test("OI 同向 → 維持做多 + 顯示資金同向", () => {
    const { ind, res } = longSetup();
    const oi: OiInfo = { dir: 1, conflict: false };
    const msg = asFlex(buildFlexMessage(meta, ind, res, undefined, oi));
    expect(msg.altText).toContain("做多");
    expect(JSON.stringify(msg.contents)).toContain("資金同向 ✓");
  });

  test("OI 反向 → 整張卡降級觀望", () => {
    const { ind, res } = longSetup();
    expect(res.direction).toBe(Direction.Long);
    const oi: OiInfo = { dir: -1, conflict: true }; // OI 往反向擴張
    const msg = asFlex(buildFlexMessage(meta, ind, res, undefined, oi));
    expect(msg.altText).toContain("觀望");
    expect(msg.altText).not.toContain("做多");
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("資金反向 ✗");
    expect(blob).toContain("OI");
    expect(blob).not.toContain("交易規劃");
  });
});

describe("卡片顯示支撐/壓力", () => {
  test("res.sr 存在時 bubble JSON 含支撐/壓力文字", () => {
    const kl = uptrend(80);
    const ind = build(kl, { ...defaultConfig(), srFilter: true });
    const res = evalAt(ind, kl.length - 1);
    if (!res) throw new Error("res 應存在");
    const bubble = buildBubble(meta, ind, res);
    expect(JSON.stringify(bubble)).toContain("支撐/壓力");
  });
});

describe("建議槓桿列(ATR 動態)", () => {
  test("期貨卡片含建議槓桿列", () => {
    const { ind, res } = longSetup();
    const msg = buildFlexMessage(meta, ind, res);
    const s = JSON.stringify(msg);
    expect(s).toContain("建議槓桿");
    expect(s).toContain("ATR 波動");
  });

  test("spot 卡片不顯示建議槓桿", () => {
    const { ind, res } = longSetup();
    const msg = buildFlexMessage({ ...meta, market: "spot" }, ind, res);
    expect(JSON.stringify(msg)).not.toContain("建議槓桿");
  });

  test("使用者自帶槓桿時,槓桿試算列與建議槓桿列並存", () => {
    const { ind, res } = longSetup();
    const msg = buildFlexMessage({ ...meta, leverage: 10 }, ind, res);
    const s = JSON.stringify(msg);
    expect(s).toContain("⚡ 槓桿 10×");
    expect(s).toContain("建議槓桿");
  });
});
