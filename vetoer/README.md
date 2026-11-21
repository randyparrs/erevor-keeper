# erevor-vetoer

Cloudflare Worker that holds `GuardianReceiver`'s vetoer key. It runs apart from the relayer (GitHub Actions), with
its own secrets and RPCs, so one compromised platform cannot both propose a VOID and let it through.

Every minute (Cron Trigger) it reads the `VerdictProposed` events with verdict VOID from the last `LOOKBACK_MINUTES`
plus the veto delay. For each one still pending it reads the round from the lens and the review stored by the
erevor-guardian contract on GenLayer (`get_review`, latest FINALIZED state), and calls `vetoVerdict` unless the review
is VOID and has exactly the recorded asset, timestamps, prices and outcome. Every decision is one JSON log line.

`GET /health` returns 200 while passes run without errors, and 503 when the last pass is more than 10 minutes old, the
last pass failed, or a veto happened in the last hour. Point an external monitor at it (cron-job.org, every 5
minutes, with failure notifications on).

## Configuration

| Name | Kind | Value |
|---|---|---|
| `VETOER_PRIVATE_KEY` | secret | the vetoer key (checked against `VETOER_ADDRESS` and `GuardianReceiver.vetoer()` every pass) |
| `ARB_RPC_URL` | secret | Arbitrum Sepolia RPC |
| `GL_NODE` | secret | GenLayer Bradbury node |
| `RECEIVER_ADDRESS`, `LENS_ADDRESS`, `GUARDIAN_GL_ADDRESS`, `VETOER_ADDRESS`, `LOOKBACK_MINUTES` | vars | `wrangler.toml` |
| `HEALTH` | KV namespace | last pass state, written at most every 5 minutes unless it changes |

## Test and deploy

```bash
npm ci
```

```bash
npm test
```

With `npx --yes wrangler@4` from this folder: `kv namespace create HEALTH` (put the id in `wrangler.toml`),
`secret put VETOER_PRIVATE_KEY`, `secret put ARB_RPC_URL`, `secret put GL_NODE`, then `deploy`.

For mainnet the vetoer key is generated inside the Worker's environment and never passes through GitHub or a shared
machine, and the relayer and the vetoer always live on different platforms.
