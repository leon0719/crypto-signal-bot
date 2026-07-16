// 排程計算(純函式):給定現在時間,算出下一個「UTC 指定小時 + 指定分鐘」的執行時點。
// 用於常駐排程器對齊 4h 收棒後 N 分。與 K 棒收盤對齊,故用 UTC。

// 回傳嚴格晚於 now 的下一個執行時點:UTC 小時屬於 hours、分鐘為 minute、秒為 0。
export function nextRunTime(now: Date, hours: number[], minute: number): Date {
  const t = new Date(now.getTime());
  t.setUTCMinutes(minute, 0, 0);
  // 逐時前進(最多兩天保險),直到嚴格晚於 now 且落在指定小時。
  for (let i = 0; i < 48; i++) {
    if (t.getTime() > now.getTime() && hours.includes(t.getUTCHours())) return t;
    t.setUTCHours(t.getUTCHours() + 1);
    t.setUTCMinutes(minute, 0, 0);
  }
  return t; // 理論上不會到這(hours 非空時 48 小時內必有解)
}

// 每天 UTC 00 那輪掃描後推紙上交易成績單(2026-07-16 由每週一改為每日)。
export function shouldPushReport(now: Date): boolean {
  return now.getUTCHours() === 0;
}
