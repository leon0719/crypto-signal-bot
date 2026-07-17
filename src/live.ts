// 實盤下單:訊號 → 護欄 → 部位計算 → OKX 下單 → 記帳/通報。
// 部位規則與紙上一致:每筆風險 = 權益 × riskPct(2×ATR 停損),槓桿依 ATR 動態(risk.ts)。
import type { Opportunity } from "./detect.js";
import type { OkxInstrument } from "./okx.js";
import { suggestLeverage } from "./risk.js";

// 依字串步長向下取整,回傳與步長同小數位數的字串(避免浮點誤差與科學記號)。
export function floorToStep(value: number, step: string): string {
  const dec = (step.split(".")[1] ?? "").length;
  const n = Math.floor(value / Number(step) + 1e-9) * Number(step);
  return n.toFixed(dec);
}

// 四捨五入到步長(TP/SL 觸發價貼齊 tickSz 用)。
export function roundToStep(value: number, step: string): string {
  const dec = (step.split(".")[1] ?? "").length;
  const n = Math.round(value / Number(step)) * Number(step);
  return n.toFixed(dec);
}

// 目前所屬 K 棒的開盤時間(冪等鍵用:同一根棒只下一次單)。
export function barOpenOf(now: number, intervalMs: number): number {
  return Math.floor(now / intervalMs) * intervalMs;
}

export interface OrderPlan {
  instId: string;
  side: "buy" | "sell";
  contracts: string;
  leverage: number;
  notional: number; // 名目價值(USDT)
  margin: number; // 佔用保證金 = notional / leverage
  tpPx: string;
  slPx: string;
}

// 由機會與帳戶權益算出下單計畫;不可下單時回 {skip: 原因}。純函式,好測。
export function planOrder(
  o: Opportunity,
  equity: number,
  inst: OkxInstrument,
  riskPct: number,
): OrderPlan | { skip: string } {
  const stopDist = Math.abs(o.entry - o.stop);
  if (!(stopDist > 0) || !(equity > 0)) return { skip: "停損距離或權益無效" };
  const riskAmount = equity * riskPct;
  const qtyCoin = riskAmount / stopDist;
  const contracts = floorToStep(qtyCoin / inst.ctVal, inst.lotSz);
  if (Number(contracts) < Number(inst.minSz)) {
    return {
      skip: `張數 ${contracts} 低於最小下單量 ${inst.minSz}(風險額 ${riskAmount.toFixed(1)} USDT 太小)`,
    };
  }
  const leverage = suggestLeverage(stopDist / 2, o.entry); // 停損距離 = 2×ATR
  const notional = Number(contracts) * inst.ctVal * o.entry;
  return {
    instId: inst.instId,
    side: o.dir === "SHORT" ? "sell" : "buy",
    contracts,
    leverage,
    notional,
    margin: notional / leverage,
    tpPx: roundToStep(o.target, inst.tickSz),
    slPx: roundToStep(o.stop, inst.tickSz),
  };
}
