// 實盤下單:訊號 → 護欄 → 部位計算 → OKX 下單 → 記帳/通報。
// 部位規則與紙上一致:每筆風險 = 權益 × riskPct(命中初始停損),槓桿依 ATR 動態(risk.ts)。
import type { Opportunity } from "./detect.js";
import {
  type LiveLedger,
  type LivePosition,
  readControlState,
  readLiveLedger,
  withFileLock,
  writeLiveLedger,
} from "./live-state.js";
import {
  fetchInstrument,
  fetchPositions,
  fetchUsdtBalance,
  instIdOf,
  type OkxCreds,
  type OkxInstrument,
  placeMarketWithTpSl,
  setLeverage,
} from "./okx.js";
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
  // 槓桿看波動度本身(ATR),不由停損距離反推——停損倍數 cfg.stopATR 一改,反推就錯。
  const leverage = suggestLeverage(o.atr, o.entry);
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

export interface LiveConfig {
  mode: "dry" | "real";
  riskPct: number;
  maxPositions: number;
  ledgerPath: string;
  controlPath: string;
  intervalMs: number;
}

export interface LiveIo {
  creds: OkxCreds;
  notify(text: string): Promise<void>;
  lastPrice(symbol: string): Promise<number | null>; // dry 對帳用(現貨/合約現價)
  now(): number;
}

// 由環境變數組實盤設定。LIVE_MODE 只認 "real",其餘一律 dry(fail-closed)。
export function liveConfigFromEnv(intervalMs: number): LiveConfig {
  return {
    mode: process.env.LIVE_MODE === "real" ? "real" : "dry",
    riskPct: 0.01,
    maxPositions: Number(process.env.LIVE_MAX_POSITIONS ?? 4),
    ledgerPath: process.env.LIVE_LEDGER_PATH ?? "./data/live-ledger.json",
    controlPath: process.env.LIVE_CONTROL_PATH ?? "./data/live-control.json",
    intervalMs,
  };
}

// 對帳:把「交易所端已出場」的 OPEN 部位標記 CLOSED,騰出倉位額度。
// real:以 OKX 實際倉位為準;dry:以現價是否觸及 stop/target 模擬。回傳被關閉的 key。
export async function reconcileLedger(
  ledger: LiveLedger,
  cfg: LiveConfig,
  io: LiveIo,
): Promise<string[]> {
  const closed: string[] = [];
  const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
  if (opens.length === 0) return closed;

  if (cfg.mode === "real") {
    const live = new Set((await fetchPositions(io.creds)).map((p) => p.instId));
    for (const p of opens) {
      if (!live.has(p.instId)) {
        p.status = "CLOSED";
        p.closedAt = new Date(io.now()).toISOString();
        p.closeReason = "交易所端已出場(TP/SL 或手動)";
        closed.push(p.key);
      }
    }
  } else {
    for (const p of opens) {
      const px = await io.lastPrice(p.symbol);
      if (px == null) continue; // 取不到價就下輪再說
      const hitStop = p.dir === "SHORT" ? px >= p.stop : px <= p.stop;
      const hitTarget = p.dir === "SHORT" ? px <= p.target : px >= p.target;
      if (hitStop || hitTarget) {
        p.status = "CLOSED";
        p.closedAt = new Date(io.now()).toISOString();
        p.closeReason = hitStop ? "【模擬】觸及停損" : "【模擬】達標";
        closed.push(p.key);
      }
    }
  }
  return closed;
}

const fmtUsdt = (n: number) => `${n.toFixed(1)} USDT`;

// 主流程:開關 → 對帳 → 護欄 → 下單 → 記帳/通報。單筆失敗告警後續下一筆;
// 餘額查詢失敗中止整輪(fail-closed)。
export async function executeLive(
  news: Opportunity[],
  cfg: LiveConfig,
  io: LiveIo,
): Promise<{ opened: number; skipped: string[] }> {
  const skipped: string[] = [];
  // Slack 通報失敗不可拖累帳本(見 C1):notify 一律 best-effort,錯誤只記 log。
  const notify = (text: string) =>
    io.notify(text).catch((e) => console.error(`[實盤] Slack 通報失敗:${(e as Error).message}`));
  const control = await readControlState(cfg.controlPath);
  if (!control.enabled) return { opened: 0, skipped: ["自動下單未啟動"] };

  return withFileLock(cfg.ledgerPath, async () => {
    const ledger = await readLiveLedger(cfg.ledgerPath);
    const reconciled = await reconcileLedger(ledger, cfg, io).catch((e) => {
      skipped.push(`對帳失敗:${(e as Error).message}`);
      return [] as string[];
    });
    if (reconciled.length > 0) await writeLiveLedger(cfg.ledgerPath, ledger);
    if (news.length === 0) return { opened: 0, skipped };

    let equity: number;
    try {
      equity = (await fetchUsdtBalance(io.creds)).equity;
    } catch (e) {
      await notify(`🚨 [實盤] 餘額查詢失敗,本輪全部放棄:${(e as Error).message}`);
      return { opened: 0, skipped: ["餘額查詢失敗"] };
    }

    let opened = 0;
    const tagOf = (o: Opportunity) => `${o.symbol} ${o.dir === "SHORT" ? "做空" : "做多"}`;
    for (const o of news) {
      const key = `${o.symbol}:${o.dir}:${barOpenOf(io.now(), cfg.intervalMs)}`;
      const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
      if (ledger.positions.some((p) => p.key === key)) {
        skipped.push(`${tagOf(o)}:本棒已下過單(冪等)`);
        continue;
      }
      if (opens.some((p) => p.symbol === o.symbol)) {
        skipped.push(`${tagOf(o)}:已有同幣自動倉位`);
        continue;
      }
      if (opens.length >= cfg.maxPositions) {
        skipped.push(`${tagOf(o)}:自動倉位已達上限 ${cfg.maxPositions}`);
        continue;
      }

      try {
        const inst = await fetchInstrument(io.creds, instIdOf(o.symbol));
        const plan = planOrder(o, equity, inst, cfg.riskPct);
        if ("skip" in plan) {
          skipped.push(`${tagOf(o)}:${plan.skip}`);
          await notify(`⚠️ [實盤] 放棄 ${tagOf(o)}:${plan.skip}`);
          continue;
        }
        let ordId: string | null = null;
        if (cfg.mode === "real") {
          await setLeverage(io.creds, plan.instId, plan.leverage);
          ordId = await placeMarketWithTpSl(io.creds, {
            instId: plan.instId,
            side: plan.side,
            sz: plan.contracts,
            tpPx: plan.tpPx,
            slPx: plan.slPx,
          });
        }
        const pos: LivePosition = {
          key,
          symbol: o.symbol,
          instId: plan.instId,
          dir: o.dir,
          contracts: plan.contracts,
          entry: o.entry,
          stop: o.stop,
          target: o.target,
          leverage: plan.leverage,
          mode: cfg.mode,
          ordId,
          openedAt: new Date(io.now()).toISOString(),
          status: "OPEN",
        };
        ledger.positions.push(pos);
        opened++;
        // 帳本立即落盤(見 C1):即使後續 notify 失敗,真單也已記帳,不會漏記。
        await writeLiveLedger(cfg.ledgerPath, ledger);
        const prefix = cfg.mode === "dry" ? "【模擬】" : "";
        await notify(
          `${o.dir === "SHORT" ? "🔴" : "🟢"} ${prefix}[實盤] ${tagOf(o)} ${plan.contracts} 張(${plan.leverage}x)\n` +
            `   進場 ~${o.entry} ｜ 停損 ${plan.slPx} ｜ 目標 ${plan.tpPx}\n` +
            `   名目 ${fmtUsdt(plan.notional)} ｜ 保證金 ${fmtUsdt(plan.margin)}${ordId ? ` ｜ 單號 ${ordId}` : ""}`,
        );
      } catch (e) {
        skipped.push(`${tagOf(o)}:下單失敗 ${(e as Error).message}`);
        await notify(`🚨 [實盤] ${tagOf(o)} 下單失敗:${(e as Error).message}`);
      }
    }
    await writeLiveLedger(cfg.ledgerPath, ledger);
    return { opened, skipped };
  });
}
