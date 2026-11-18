# erevor-keeper

Keeper for the Erevor UP/DOWN price prediction market on Elysium (chain 99801, HYPE as gas).

Every 5 minutes, on UTC boundaries, the market needs one transaction that locks the rounds starting now and closes
the rounds that started one interval ago. This keeper:

1. reads the whole boundary with a single Multicall3 call (market states, open rounds, chain clock);
2. decides what to do (idle mode): it executes markets with rounds holding bets at every boundary, and when nothing
   has bets it only executes every 30 minutes to keep the price reference fresh;
3. fetches Hyperliquid perp oracle prices, pushes them to the price source and calls `executeBoundary`;
4. retries with backoff inside the execution window and falls back to a second RPC if the first one is down;
5. logs JSON lines, including runner punctuality and `MISSED_WITH_BETS` when a round with bets was not executed in
   time (those rounds are voided and fully refundable on chain).

## Running on GitHub Actions

`.github/workflows/keeper.yml` runs one pass per boundary (`node dist/src/index.js --once`). It is triggered by an
external scheduler (for example cron-job.org) calling the `workflow_dispatch` API at minutes 3, 8, ..., 58, two
minutes before each boundary. Repository secrets:

| Secret | Value |
|---|---|
| `KEEPER_PRIVATE_KEY` | Keeper hot wallet (0x prefixed). Needs the operator and price pusher roles; holds HYPE for gas only. |
| `RPC_URL` | Dedicated Elysium RPC endpoint. |

## Running locally

Requirements: Node.js 20.12 or newer.

```bash
npm ci
npm test
cp .env.example .env
npm run once
```

`npm start` runs the long-lived loop instead of a single pass. `DRY_RUN=true` simulates without sending.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | required | Dedicated RPC (mandatory on mainnet) |
| `RPC_FALLBACK_URL` | none | Used only after `RPC_URL` failed all retries |
| `CHAIN_ID` | required | 99801 on Elysium testnet |
| `KEEPER_PRIVATE_KEY` | required | Keeper wallet |
| `MARKET_ADDRESS` | required | PredictionMarket contract |
| `PUSH_PRICES` | true | Push prices to the keeper fed price source before executing |
| `HL_INFO_URL` | Hyperliquid mainnet | Price feed |
| `HL_PRICE_FIELD` | oraclePx | Perp price field (only perps are eligible) |
| `IDLE_MODE` | true | Skip empty boundaries |
| `IDLE_REFRESH_SECONDS` | 1800 | Refresh interval when idle (multiple of 300) |
| `MIN_BALANCE_HYPE` | 0.1 | Low balance warning threshold |
| `TRIGGER_LEAD_SECONDS` | 120 | Nominal trigger lead used in punctuality logs |
| `DRY_RUN` | false | Simulate only |
| `LOG_LEVEL` | info | debug, info, warn, error |

## Log messages

| `msg` | Meaning |
|---|---|
| `runner timing` | Runner start, keeper ready time, `leadSeconds` before the boundary (negative when late), `startDelaySeconds` |
| `boundary executed` | Transaction included; `inclusionDelaySeconds` after the boundary, rounds locked and closed |
| `boundary skipped (idle): no rounds with bets` | Nothing to settle, no transaction sent |
| `boundary done` | One per boundary: mode, executed, markets with bets, RPC calls |
| `MISSED_WITH_BETS` | A round with bets was not executed in its window |
| `price rejected by circuit breaker`, `price rebased: ...` | Circuit breaker events |
| `rpc retry`, `rpc fallback used: ...` | RPC rate limits or failures |
| `low keeper balance: top up HYPE for gas` | Balance under `MIN_BALANCE_HYPE` |
