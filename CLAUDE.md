# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun install` — install deps (run once; commit `bun.lock`).
- `bun run dev` — local Worker at http://localhost:8787 (wrangler dev). Needs `.dev.vars` (copy `.dev.vars.example`).
- `bun test` — all tests. Single file: `bun test src/suggest.test.js`. By name: `bun test -t "找不到"`.
- `bun run check` / `npx biome check --write .` — lint + format (Biome). Run before committing.
- `bunx wrangler deploy` — deploy from local. `bunx wrangler deploy --dry-run` — verify the bundle without shipping.
- Secrets (set once, persist across deploys): `bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN` and `bunx wrangler secret put LINE_CHANNEL_SECRET`.

## Conventions

- **Plain JS ESM, zero runtime dependencies** — indicators and LINE/OKX clients are hand-written against Web platform APIs (`fetch`, `crypto.subtle`, `btoa`) available in the Workers runtime. Do not add npm runtime deps without reason.
- Comments and all user-facing strings are **繁體中文**.
- This is a JS port of the sibling Go CLI `../crypto-signal`. The indicator math (`ta.js`) and scoring (`signal.js`) mirror that implementation 1:1 — keep them in sync conceptually; don't "optimize" them into divergence.

## Architecture

A single Cloudflare Worker that turns LINE text messages into crypto technical-analysis cards. No database, no LLM, no frontend. One inbound message → one analysis → one reply.

### Request pipeline (`src/index.js`)

`fetch` handler only. Flow: `GET *` → health check; `POST /webhook` → `verifySignature` (HMAC-SHA256 of the **raw** body vs `x-line-signature`, see `line.js`) → parse events → for each text message, `handleText()` then `replyMessages()` with the reply token. The reply runs inside `ctx.waitUntil()` so the webhook returns 200 immediately (LINE requires a fast response). There is intentionally **no `scheduled()` handler, KV, or cron** — a price-alert feature was prototyped then removed (`wrangler.jsonc` keeps `"crons": []` to clear any stale schedule).

### Analysis flow (`src/analyze.js` is the orchestrator)

`handleText(text)` → `parseCommand` (`command.js`, returns `{help}` or `{symbol, interval, market, leverage}`; symbols get `USDT` appended, default futures/1h) → `fetchKlines` (`okx.js`) → `build` then `evalAt` (`signal.js`) → `buildFlexMessage` (`format.js`). Funding rate is fetched **concurrently** with klines (fire the promise before `await`-ing klines) to save a round-trip. Returns an **array of LINE message objects** (not a string) — flex on success, text on help/error.

### Key cross-file contracts

- **Indicator arrays are NaN-padded and index-aligned** (`ta.js`): every indicator returns an array the same length as the input; leading positions are `NaN` until enough data exists. `signal.evalAt(ind, i)` reads index `i` from each and bails (returns `null`) if any required value is `NaN`. `signal.minBars(cfg)` is the minimum candle count for the last bar to be evaluable — used to produce the "資料不足" message.
- **ADX regime switch** (`signal.js`): when `cfg.regimeSwitch`, ADX reweights the two indicator families — trending markets amplify trend-following (EMA/MACD/OBV) and suppress mean-reversion (RSI/Stoch/BB), and vice versa for ranging. This is why component weights in the output vary.
- **Typed OKX errors** (`okx.js`): `okxGet()` wraps all OKX calls; an OKX error code throws `OkxError` with `.notFound` (code 51001 = instrument doesn't exist). `analyze.js` branches on `err.notFound` (never on error strings) to trigger fuzzy suggestions.
- **Fuzzy symbol suggestions** (`suggest.js`): on `notFound`, `suggestSymbols` ranks the exchange's available USDT bases (prefix > user-typo-prefix > substring > same-first-letter edit-distance; different-first-letter is discarded as noise). The instrument list is cached per isolate (`okx.js` `fetchUsdtBases`, 10-min TTL) and only fetched on the error path.
- **Quick replies** use LINE `message` actions whose `text` re-enters `handleText` (e.g. an interval button sends `"BTCUSDT 4h"`), preserving market/leverage via `marketSuffix`. Built through the single `quickReply(pairs)` helper in `format.js`.

### Testing model

`bun:test`, no miniflare/wrangler runtime. Tests stub `globalThis.fetch` with `mock()` (route by URL substring — `/market/candles`, `/funding-rate`, `/public/instruments`) and `mock.restore()` in `afterEach`. `verifySignature` is tested by signing a body with the same HMAC then asserting round-trip.

## Deployment

Push to GitHub → Cloudflare Workers Builds auto-deploys. **The Workers Build "Root directory" must be set to this folder** if it lives in a monorepo — otherwise the deployed Worker throws `error 1101 / "Callback returned incorrect type; expected 'Promise'"` on every request (the entry isn't resolved as a module). Build command: empty; Deploy command: `npx wrangler deploy`. Local `bunx wrangler deploy` always produces a correct bundle and is the fallback.
