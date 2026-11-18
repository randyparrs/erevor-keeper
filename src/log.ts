export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Structured JSON line logger. One object per line on stdout, ready for journald, Docker or a log shipper. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  process.stdout.write(line + "\n");
}
