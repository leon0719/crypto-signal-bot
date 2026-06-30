# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun install` — install deps (run once; commit `bun.lock`).
- `bun run dev` — local Worker at http://localhost:8787 (wrangler dev). Needs `.dev.vars` (copy `.dev.vars.example`).
- `bun test` — all tests. Single file: `bun test src/suggest.test.ts`. By name: `bun test -t "找不到"`.
- `bun run check` — gate before committing: `biome check .` + `tsc --noEmit`. (`bun run type-check` for tsc only.)
- `bunx wrangler deploy` — deploy from local. `bunx wrangler deploy --dry-run` — verify the bundle without shipping.
- `bun run richmenu <token> <image.png>` — one-time LINE rich-menu setup (`scripts/setup-richmenu.ts`).
- Secrets (set once, persist across deploys): `bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN` and `bunx wrangler secret put LINE_CHANNEL_SECRET`.

## Conventions

- **TypeScript + ESM, zero runtime dependencies** — indicators and LINE/Bybit clients are hand-written against Web platform APIs (`fetch`, `crypto.subtle`, `btoa`) available in the Workers runtime. Do not add npm runtime deps without reason. Shared types live in `src/types.ts`; imports use `.js` specifiers (TS `verbatimModuleSyntax`).
- Comments and all user-facing strings are **繁體中文**.
- The indicator math lives in `ta.ts` (pure, NaN-padded index-aligned arrays) and the scoring in `signal.ts` (weighted trend/mean-reversion families with an ADX regime switch). This is a self-contained TypeScript project — change them freely when the analysis can be improved; there is no external implementation to keep in sync with.

## Architecture

A single Cloudflare Worker that turns LINE text messages into crypto technical-analysis cards. No database, no LLM, no frontend. One inbound message → one analysis → one reply.

### Request pipeline (`src/index.js`)

`fetch` handler only. Flow: `GET *` → health check; `POST /webhook` → `verifySignature` (HMAC-SHA256 of the **raw** body vs `x-line-signature`, see `line.js`) → parse events → for each text message, `handleText()` then `replyMessages()` with the reply token. The reply runs inside `ctx.waitUntil()` so the webhook returns 200 immediately (LINE requires a fast response). There is intentionally **no `scheduled()` handler, KV, or cron** — a price-alert feature was prototyped then removed (`wrangler.jsonc` keeps `"crons": []` to clear any stale schedule).

### Analysis flow (`src/analyze.ts` is the orchestrator)

`handleText(text)` → `parseCommand` (`command.ts`, returns a `Command` union: `{help}` or `{help: false, symbol, interval, market, leverage}`; symbols get `USDT` appended, default futures/4h) → `fetchKlines` (`bybit.ts`) → `build` then `evalAt` (`signal.ts`) → `buildFlexMessage` (`format.ts`). Returns an **array of LINE message objects** (not a string) — flex on success, text on help/error.

Three independent fetches run **concurrently** in `handleSingle`: the **higher-timeframe (MTF) score**, the **live price**, and the **OI (open-interest) trend** (`oi.ts` `evalOiDir`), all overlapping the main klines fetch. `HTF_MAP` maps each interval to a confirming larger one; if the big timeframe's score opposes the signal direction, the card downgrades to 觀望. The card shows **one bubble** per request (no carousel / multi mode).

### Key cross-file contracts

- **Indicator arrays are NaN-padded and index-aligned** (`ta.js`): every indicator returns an array the same length as the input; leading positions are `NaN` until enough data exists. `signal.evalAt(ind, i)` reads index `i` from each and bails (returns `null`) if any required value is `NaN`. `signal.minBars(cfg)` is the minimum candle count for the last bar to be evaluable — used to produce the "資料不足" message.
- **ADX regime switch** (`signal.js`): when `cfg.regimeSwitch`, ADX reweights the two indicator families — trending markets amplify trend-following (EMA/MACD/OBV) and suppress mean-reversion (RSI/Stoch/BB), and vice versa for ranging. This is why component weights in the output vary.
- **MTF + OI confirmation → 觀望 downgrade** (`oi.ts`, `format.ts`): two independent confirms can force the card to neutral. `format.ts` `computeEffectiveDir` returns 觀望 when **either** `htf.conflict` (big timeframe opposes) **or** `oi.conflict` is set. The OI rule is the backtest-validated "non-opposing" filter (`oi.ts` `oiDirSeries`: OI-EMA-expansion × price momentum → −1/0/+1; conflict only when OI **actively** opposes the signal). `evalOiDir` is fail-soft — any fetch error / unsupported interval returns `null` and the card simply omits OI. Deep-history backtest lives in `scripts/oi-backtest.ts`.
- **Typed Bybit errors** (`bybit.ts`): `bybitGet()` wraps all Bybit calls; a Bybit business error (`retCode !== 0`) throws `BybitError` with `.notFound` (retCode 10001 = `params error: symbol invalid`, i.e. instrument doesn't exist). `analyze.ts` branches on `err.notFound` (never on error strings) to trigger fuzzy suggestions.
- **Fuzzy symbol suggestions** (`suggest.js`): on `notFound`, `suggestSymbols` ranks the exchange's available USDT bases (prefix > user-typo-prefix > substring > same-first-letter edit-distance; different-first-letter is discarded as noise). The instrument list is cached per isolate (`bybit.ts` `fetchUsdtBases`, 10-min TTL) and only fetched on the error path.
- **Quick replies** use LINE `message` actions whose `text` re-enters `handleText` (e.g. an interval button sends `"BTCUSDT 4h"`), preserving market/leverage via `marketSuffix`. Built through the single `quickReply(pairs)` helper in `format.js`.

### Testing model

`bun:test`, no miniflare/wrangler runtime. Tests stub `globalThis.fetch` with `mock()` (route by URL substring — `/market/kline`, `/market/tickers`, `/instruments-info`, `/message/reply`, `/chat/loading/start`) and `mock.restore()` in `afterEach`. `index.test.ts` is the end-to-end check: it signs a body (via `sign()` re-exported from `line.test.ts`), calls `worker.fetch` with a fake `ExecutionContext` that collects `waitUntil` promises, then `await`s them and asserts a reply was POSTed. `bun test` and `tsc --noEmit` both run in CI (`.github/workflows/ci.yml`).

## Deployment

Push to GitHub → Cloudflare Workers Builds auto-deploys. **The Workers Build "Root directory" must be set to this folder** if it lives in a monorepo — otherwise the deployed Worker throws `error 1101 / "Callback returned incorrect type; expected 'Promise'"` on every request (the entry isn't resolved as a module). Build command: empty; Deploy command: `npx wrangler deploy`. Local `bunx wrangler deploy` always produces a correct bundle and is the fallback.
