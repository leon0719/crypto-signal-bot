// 依波動度(ATR 佔價格百分比)給出建議槓桿(1x–5x,階梯式)。
// 每筆固定風險 1% 下,槓桿只影響保證金占用與理論強平價——
// 波動大的幣壓低槓桿讓強平價離得夠遠,波動小的幣可提高保證金效率。
// 門檻值本身屬於較低風險檔(atrPct === 1 → 5x)。

export function suggestLeverage(atr: number, price: number): number {
  if (!Number.isFinite(atr) || !Number.isFinite(price) || atr <= 0 || price <= 0) return 1;
  const pct = (atr / price) * 100;
  if (pct <= 1) return 5;
  if (pct <= 1.5) return 4;
  if (pct <= 2) return 3;
  if (pct <= 3) return 2;
  return 1;
}
