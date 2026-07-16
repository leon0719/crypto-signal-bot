// 並行紙上交易策略設定:純資料。策略間唯一變因是週期,A/B 結論才乾淨。
// 幣種清單(scan.ts SYMBOLS)與風險參數(paper.ts defaultPaperConfig)兩策略共用。
export interface Strategy {
  name: string; // 顯示於成績單標題與 log
  interval: string; // 掃描週期
  htf: string; // 大週期確認
  statePath: string; // 去重狀態檔
  ledgerPath: string; // 紙上交易帳本
  pushSignals: boolean; // 是否推新機會訊號到 Slack
  channelEnv: string; // 成績單使用的 Slack channel 環境變數名
  baseline: string; // 樣本足夠時成績單顯示的基準註解
}

export const STRATEGIES: Strategy[] = [
  {
    name: "4h",
    interval: "4h",
    htf: "1d",
    statePath: "./data/signal-state.json",
    ledgerPath: "./data/paper-ledger.json",
    pushSignals: true,
    channelEnv: "SLACK_CHANNEL_ID",
    baseline: "基準:回測 4h avgR ≈ +0.10;明顯低於此值才代表策略在當前市場失效。",
  },
  {
    name: "1h",
    interval: "1h",
    htf: "4h",
    statePath: "./data/signal-state-1h.json",
    ledgerPath: "./data/paper-ledger-1h.json",
    pushSignals: false,
    channelEnv: "SLACK_CHANNEL_ID_1H",
    baseline: "基準:回測 1h avgR ≈ +0.05;明顯低於此值才代表策略在當前市場失效。",
  },
];

export function strategyByName(name: string): Strategy {
  const s = STRATEGIES.find((x) => x.name === name);
  if (!s) {
    const names = STRATEGIES.map((x) => x.name).join(", ");
    throw new Error(`未知策略:${name}(可用:${names})`);
  }
  return s;
}

// "1h"/"4h"/"1d" → 毫秒。供 PaperConfig.intervalMs 對齊進場棒。
export function intervalMsOf(interval: string): number {
  const unit = interval[interval.length - 1];
  const n = Number(interval.slice(0, -1)) || 1;
  const per: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = per[unit];
  if (!ms) throw new Error(`不支援的週期:${interval}`);
  return n * ms;
}
