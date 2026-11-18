// Resilient JSON-RPC provider: exponential backoff with jitter on rate limits and transient failures, bounded by a
// deadline (the execution window), and an optional fallback endpoint used only after the primary exhausted its
// retries. Counts every HTTP request so the keeper can report RPC calls per boundary.

export interface RpcEvent {
  type: "retry" | "fallback";
  endpoint: "primary" | "fallback";
  method: string;
  attempt: number;
  delayMs?: number;
  reason: string;
}

export interface RpcProviderOptions {
  primaryUrl: string;
  fallbackUrl?: string;
  timeoutMs: number;
  /** Retries per endpoint after the first attempt. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Retry budget when no deadline is set (startup, tools). */
  defaultBudgetMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onEvent?: (e: RpcEvent) => void;
}

/** JSON-RPC error returned by a node (for example an execution revert). Never retried. */
export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** Retryable failure: HTTP 429, rate limit JSON-RPC error, 5xx, network error or timeout. */
export class TransientRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientRpcError";
  }
}

/** The endpoint cannot serve this request at all (for example archive data on a free plan): go to the fallback. */
export class UnsupportedRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRpcError";
  }
}

const RATE_LIMIT_CODES = new Set([429, -32005, -32029, -32090]);

export function isUnsupportedError(message: string | undefined): boolean {
  return /not available on your (current )?plan|archive.*not available|method not (found|supported|available)/i.test(message ?? "");
}

export function isRateLimitError(code: number | undefined, message: string | undefined): boolean {
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return true;
  return /rate.?limit|too many requests|capacity exceeded/i.test(message ?? "");
}

/** Exponential backoff with equal jitter: half fixed, half random. */
export function backoffWithJitter(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (random() * exp) / 2);
}

export class RpcProvider {
  private deadline: number | undefined;
  private requests = 0;
  private nextId = 1;
  private readonly o: Required<Omit<RpcProviderOptions, "fallbackUrl" | "onEvent">> &
    Pick<RpcProviderOptions, "fallbackUrl" | "onEvent">;

  constructor(options: RpcProviderOptions) {
    this.o = {
      maxRetries: 4,
      baseDelayMs: 250,
      maxDelayMs: 4000,
      defaultBudgetMs: 30_000,
      fetchFn: fetch,
      sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      now: Date.now,
      ...options,
    };
  }

  /** Retries never wait past this timestamp (ms). Undefined restores the default budget. */
  setDeadline(deadlineMs: number | undefined): void {
    this.deadline = deadlineMs;
  }

  /** HTTP requests sent since the last reset. */
  get requestCount(): number {
    return this.requests;
  }

  resetRequestCount(): void {
    this.requests = 0;
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const deadline = this.deadline ?? this.o.now() + this.o.defaultBudgetMs;
    let lastError: unknown;
    const endpoints: ["primary" | "fallback", string][] = [["primary", this.o.primaryUrl]];
    if (this.o.fallbackUrl) endpoints.push(["fallback", this.o.fallbackUrl]);

    for (const [label, url] of endpoints) {
      if (label === "fallback") {
        if (this.o.now() >= deadline) break;
        this.o.onEvent?.({ type: "fallback", endpoint: label, method, attempt: 0, reason: describe(lastError) });
      }
      for (let attempt = 1; attempt <= this.o.maxRetries + 1; attempt++) {
        try {
          return await this.send(url, method, params);
        } catch (err) {
          if (err instanceof UnsupportedRpcError) {
            lastError = err;
            break; // no point retrying the same endpoint
          }
          if (!(err instanceof TransientRpcError)) throw err;
          lastError = err;
          if (attempt > this.o.maxRetries) break;
          const delay = backoffWithJitter(attempt, this.o.baseDelayMs, this.o.maxDelayMs, this.o.random);
          if (this.o.now() + delay >= deadline) break;
          this.o.onEvent?.({ type: "retry", endpoint: label, method, attempt, delayMs: delay, reason: err.message });
          await this.o.sleepFn(delay);
        }
      }
    }
    throw lastError ?? new TransientRpcError("RPC unavailable");
  }

  private async send(url: string, method: string, params: unknown): Promise<unknown> {
    this.requests++;
    let res: Response;
    try {
      res = await this.o.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: params ?? [] }),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (err) {
      throw new TransientRpcError(`network: ${describe(err)}`);
    }
    if (res.status === 429) throw new TransientRpcError("HTTP 429 rate limited");
    if (res.status >= 500) throw new TransientRpcError(`HTTP ${res.status}`);
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TransientRpcError(`HTTP ${res.status} with a non JSON body`);
    }
    if (body.error) {
      const { code, message, data } = body.error;
      if (isRateLimitError(code, message)) throw new TransientRpcError(`rate limited: ${message ?? code}`);
      if (isUnsupportedError(message)) throw new UnsupportedRpcError(`unsupported by this endpoint: ${message}`);
      throw new JsonRpcError(code ?? -32603, message ?? "JSON-RPC error", data);
    }
    if (!res.ok) throw new TransientRpcError(`HTTP ${res.status}`);
    return body.result;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
