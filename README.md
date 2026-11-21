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

## Guardian workflows

Disputed rounds are reviewed by the erevor-guardian intelligent contract on GenLayer Bradbury and the verdict is
applied on Arbitrum Sepolia through `GuardianReceiver` (see the Erevor repository for the trust model). Two more
workflows run `node dist/src/guardian/index.js <role>`, each triggered by cron-job.org through `workflow_dispatch`,
with GitHub's schedule as a backup:

| Workflow | Minutes | Role |
|---|---|---|
| `guardian-vigilante.yml` | 1, 6, ..., 56 | after each close, applies the guardian rule to the exchange data and disputes the round if it says VOID; it has no veto power |
| `guardian-relayer.yml` | 2, 7, ..., 57 | for each round still Disputed, requests the GenLayer review if none is FINALIZED, waits for it and proposes the verdict to `GuardianReceiver`; executes pending VOIDs once their veto delay has passed |

| Secret or variable | Value |
|---|---|
| `RELAYER_PRIVATE_KEY` (secret) | Relayer wallet: the guardian contract's `reviewer` and `GuardianReceiver`'s relayer. GEN on Bradbury and Arbitrum Sepolia ETH. |
| `VIGILANTE_PRIVATE_KEY` (secret) | Opens disputes; no role. Arbitrum Sepolia ETH; mints its bond from the testnet token faucet. |
| `GUARDIAN_RPC_FALLBACK_URL` (secret) | Fallback Arbitrum Sepolia RPC (Chainstack). Never the vetoer Worker's provider. |
| `GUARDIAN_RECEIVER_ADDRESS` (variable) | `GuardianReceiver` on Arbitrum Sepolia. |
| `GUARDIAN_GL_ADDRESS` (variable) | erevor-guardian on GenLayer Bradbury. |

No `eth_getLogs`: the roles compute the round ids of every market locally (`roundId = keccak256(abi.encode(marketId,
start))`, starts aligned to the interval) for the rounds closed in their window (vigilante 10 minutes, relayer 6.5
hours) and read them with Multicall3 at the latest block: `getRound` on the lens, then `getConfig` (vigilante) or
`GuardianReceiver.pendingVoid` for the disputed ones (relayer). Only state reads, which any RPC plan serves.

RPC: the public Arbitrum Sepolia RPC is the primary. Each call is retried twice with backoff (`rpc retry`), then sent
to the fallback, Chainstack (`rpc fallback used`, a warning with the method and the reason), then fails the pass with
code 1. `guardian-rpc-check.yml` (manual) runs the reads of a relayer pass on each endpoint on its own and logs which
one passed, never the URLs.

Each pass logs one summary line (`relayer pass`, `vigilante pass`) and fails on any error line, such as
`REVIEW_NOT_FINAL` or a dispute close to its timeout without a verdict. Locally the roles read `.env.guardian`.

## Vetoer (Cloudflare Worker)

`GuardianReceiver`'s vetoer does not run on GitHub: it is the `erevor-vetoer` Cloudflare Worker in `vetoer/`, with its
own secrets (`VETOER_PRIVATE_KEY`, `ARB_RPC_URL`, `GL_NODE`), so an account compromise on one platform cannot both
propose and let through a VOID. A Cron Trigger runs it every minute: it finds the disputed rounds of the last 6.5
hours and their pending VOIDs the same way, with Multicall3 and no logs, checks each pending VOID against the review
stored on GenLayer (`get_review`, latest FINALIZED state) and vetoes it unless a VOID review with exactly the recorded
asset, timestamps, prices and outcome backs it. Its RPC is PublicNode, a provider the relayer and the vigilante never
use. Each decision is logged (Workers Logs). `GET /health` answers 503 when passes stop for 10 minutes, a pass fails,
or a veto happened in the last hour; an external monitor (cron-job.org with failure notifications) checks it.

```bash
cd vetoer && npm ci && npm test
```

Deploy (from `vetoer/`, with `npx --yes wrangler@4`): create the KV namespace (`kv namespace create HEALTH`) and put
its id in `wrangler.toml`, set the three secrets with `secret put`, then `deploy`. After a contract change, run
`npm run build` at the root and `npm run sync-abi` in `vetoer/`.

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
