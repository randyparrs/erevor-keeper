import { loadConfig } from "./config.js";
import { Keeper, describeError } from "./keeper.js";
import { errorCount, log, setLogLevel } from "./log.js";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const keeper = new Keeper(cfg);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("info", "shutdown requested, finishing current boundary", { signal });
      keeper.shutdown();
    });
  }

  await keeper.preflight();
  log("info", "keeper started", { once });
  await keeper.run(once);
  // A single CI pass fails (so the workflow run is marked failed and GitHub notifies) when anything was logged as an
  // error, for example MISSED_WITH_BETS or a missed boundary.
  if (once && errorCount() > 0) {
    log("error", "pass finished with errors", { errors: errorCount() });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log("error", "fatal", describeError(err));
  process.exit(1);
});
