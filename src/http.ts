import { setTimeout as sleep } from "node:timers/promises";

// Both native fetch and impit implement the response subset this client needs.
export type HttpResponse = Pick<Response, "status" | "ok" | "headers" | "json"> & {
  body: Pick<ReadableStream, "cancel"> | null;
};
export type Fetch = (url: string | URL, init?: RequestInit) => Promise<HttpResponse>;
export type Sleep = (ms: number) => Promise<unknown>;

export class HttpError extends Error {
  readonly status: number;
  readonly reason: "http" | "cloudflare-challenge";
  constructor(status: number, service: string, reason: "http" | "cloudflare-challenge" = "http") {
    const hint =
      reason === "cloudflare-challenge"
        ? "Cloudflare returned a browser challenge instead of an API response. This Node HTTP client cannot complete that challenge; refreshing the API token alone will not resolve it."
        : status === 401
          ? service === "Crunchyroll"
            ? "Session expired or invalid; run pnpm dev auth login."
            : "Access token expired or invalid; replace it in .env."
          : status === 403
            ? "Access denied. For Crunchyroll, verify your session/profile; a browser challenge may block this internal API."
            : status === 429
              ? "Rate limit reached. Try again after the server cooldown."
              : "The service request failed. Try again later.";
    super(`${service}: HTTP ${status}. ${hint}`);
    this.status = status;
    this.reason = reason;
  }
}

export function retryDelay(headers: Headers, now = Date.now()): number {
  const retry = headers.get("retry-after");
  if (retry !== null) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  return reset > 0 ? Math.max(0, reset * 1000 - now) : 60_000;
}

/** Sequential client with timeouts, bounded retries, and optional request pacing. */
export class JsonHttpClient {
  private nextRequestAt = 0;
  private readonly service: string;
  private readonly fetcher: Fetch;
  private readonly wait: Sleep;
  private readonly intervalMs: number;

  constructor(service: string, fetcher: Fetch = fetch, wait: Sleep = sleep, intervalMs = 0) {
    this.service = service;
    this.fetcher = fetcher;
    this.wait = wait;
    this.intervalMs = intervalMs;
  }

  async request(url: string | URL, init: RequestInit = {}, retrySafe = true): Promise<unknown> {
    return (await this.requestWithHeaders(url, init, retrySafe)).data;
  }

  async requestWithHeaders(
    url: string | URL,
    init: RequestInit = {},
    retrySafe = true,
  ): Promise<{ data: unknown; headers: Headers }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const delay = this.nextRequestAt - Date.now();
      if (delay > 0) await this.wait(delay);
      let response: HttpResponse;
      try {
        response = await this.fetcher(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        if (retrySafe && attempt < 3) {
          await this.wait(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(
          `${this.service}: network request failed or timed out. Check your connection and retry.`,
        );
      }
      this.nextRequestAt = Date.now() + this.intervalMs;
      // Cloudflare explicitly identifies challenge responses with this header.
      // Inspect metadata only: never expose response bodies or session credentials.
      if (response.headers.get("cf-mitigated") === "challenge") {
        await response.body?.cancel();
        throw new HttpError(response.status, this.service, "cloudflare-challenge");
      }
      if (response.status === 429 && attempt < 3) {
        const delayMs = retryDelay(response.headers);
        await response.body?.cancel();
        // Avoid effectively hanging on a malformed or very long server cooldown.
        if (delayMs > 300_000) throw new HttpError(429, this.service);
        await this.wait(delayMs);
        continue;
      }
      if (retrySafe && response.status >= 500 && attempt < 3) {
        await response.body?.cancel();
        await this.wait(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(response.status, this.service);
      }
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        this.nextRequestAt = Math.max(
          this.nextRequestAt,
          Date.now() + Math.min(300_000, retryDelay(response.headers)),
        );
      }
      try {
        return { data: await response.json(), headers: response.headers };
      } catch {
        throw new Error(
          `${this.service}: expected JSON but received an invalid response (possibly a browser challenge).`,
        );
      }
    }
    throw new Error(`${this.service}: retry limit reached.`);
  }
}
