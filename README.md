# erevor-keeper

Keeper for the Erevor UP/DOWN price prediction market on Arbitrum Sepolia (chain 421614), settled with Pyth.

`executeBoundary` is permissionless: this keeper is a convenience, not a trusted party. Its wallet holds **no role**
and only pays gas and Pyth fees. Prices are signed by Pyth and checked on chain; for every asset the market only
accepts the first Pyth update published at or after the boundary, so the keeper cannot choose a price. If the keeper
stops, anyone can execute; rounds nobody executes in time are voided and fully refundable.

Every 5 minute UTC boundary the keeper:

1. opens the Pyth Hermes stream a few seconds before the boundary and keeps, for each asset, the first update with
   `publish_time >= boundary` (and `prev_publish_time < boundary`, the only update the contract accepts). It never
   uses the historical timestamp endpoint. A stream failure is retried inside the execution window and logged; an
   asset whose first update was missed is reported and its markets are not sent;
2. reads the whole boundary with a single Multicall3 call through `PredictionMarketLens` (market states, open rounds,
   chain clock);
3. decides what to do (idle mode): it executes markets with rounds holding bets at every boundary, and when nothing
   has bets it only executes every 30 minutes to keep the price reference fresh;
4. calls `executeBoundary(marketIds, priceUpdateData)` with the captured updates and the exact Pyth fee (the market
   parses each asset in its own Pyth call and returns any excess);
5. retries with backoff inside the execution window and falls back to a second RPC if the first one is down;
6. logs JSON lines, including runner punctuality and `MISSED_WITH_BETS`. A single pass (`--once`) that logged any
   error exits with code 1, so the GitHub Actions run fails and GitHub notifies by email.

## Running on GitHub Actions

`.github/workflows/keeper.yml` runs one pass per boundary (`node dist/src/index.js --once`). It is triggered by an
external scheduler (cron-job.org) calling the `workflow_dispatch` API at minutes 3, 8, ..., 58, two minutes before
each boundary. Repository secrets:

| Secret | Value |
|---|---|
| `KEEPER_PRIVATE_KEY` | Keeper hot wallet (0x prefixed). No role; holds Arbitrum Sepolia ETH for gas and Pyth fees. |
| `PYTH_API_KEY` | Pyth Terminal API key for Hermes. The feeds it can read depend on its Pyth plan. |

`.github/workflows/ci.yml` runs `npm test` on every push.

## Running locally

Requirements: Node.js 20.12 or newer.

```bash
npm ci
```

```bash
npm test
```

```bash
cp .env.example .env
```

Put the Pyth API key in `.env.pyth` (one line, `PYTH_API_KEY=...`; the file is ignored by git), then:

```bash
npm run once
```

`npm start` runs the long-lived loop instead of a single pass. `DRY_RUN=true` captures and simulates without sending.
After a contract change, regenerate the minimal ABI with `node scripts/sync-abi.mjs <EREVOR out folder>`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | required | Arbitrum Sepolia RPC |
| `RPC_FALLBACK_URL` | none | Used only after `RPC_URL` failed all retries |
| `CHAIN_ID` | required | 421614 |
| `KEEPER_PRIVATE_KEY` | required | Keeper wallet, no role |
| `MARKET_ADDRESS` | required | PredictionMarket |
| `LENS_ADDRESS` | required | PredictionMarketLens |
| `PYTH_API_KEY` | required | Hermes API key (`.env.pyth` or a secret) |
| `HERMES_URL` | https://hermes.pyth.network | Hermes base URL |
| `FEED_IDS` | built in | `SYMBOL:0xid` overrides of the Pyth feed ids |
| `STREAM_LEAD_MS` | 5000 | How long before the boundary the stream is opened |
| `IDLE_MODE` | true | Skip empty boundaries |
| `IDLE_REFRESH_SECONDS` | 1800 | Refresh interval when idle (multiple of 300) |
| `MIN_BALANCE` | 0.01 | Low balance warning threshold (ETH) |
| `TRIGGER_LEAD_SECONDS` | 120 | Nominal trigger lead used in punctuality logs |
| `DRY_RUN` | false | Simulate only |
| `LOG_LEVEL` | info | debug, info, warn, error |

## Log messages

| `msg` | Meaning |
|---|---|
| `runner timing` | Runner start, keeper ready time, `leadSeconds` before the boundary (negative when late), `startDelaySeconds` |
| `PYTH_KEY_INVALID_OR_EXPIRED` | Hermes answered 401 or 403: the key is missing, expired, invalid or not entitled to a feed. The capture stops at once and the run fails; renew the `PYTH_API_KEY` secret |
| `hermes stream failed, reconnecting inside the window` | Stream error with the reason; the keeper reconnects while the window allows |
| `no usable Pyth update for asset, its markets are not executed` | The first update after the boundary was not captured (reason given) |
| `boundary executed` | Transaction included; captured publish times, Pyth fee, rounds locked and closed |
| `boundary skipped (idle): no rounds with bets` | Nothing to settle, no transaction sent |
| `boundary done` | One per boundary: mode, executed, markets with bets, RPC calls |
| `MISSED_WITH_BETS` | A round with bets was not executed in its window (the run fails) |
| `price rejected by circuit breaker`, `price rejected: Pyth confidence too wide`, `price rebased: ...` | Price filters |
| `rpc retry`, `rpc fallback used: ...` | RPC rate limits or failures |
| `low keeper balance: top up ETH for gas and Pyth fees` | Balance under `MIN_BALANCE` |

## License

MIT, see [LICENSE](LICENSE).
