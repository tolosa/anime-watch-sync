import assert from "node:assert/strict";
import { test } from "node:test";
import { CrunchyrollClient, isWatched, normalizeEntry } from "../src/crunchyroll.ts";
import { HttpError, JsonHttpClient, retryDelay } from "../src/http.ts";
import { episode, mockFetch, rawEpisode } from "./helpers.ts";

const config = {
  baseUrl: "https://www.crunchyroll.com",
  accountId: "account",
  locale: "en-US",
};

const tokens = {
  async getAccessToken() {
    return "secret";
  },
};

test("normalizes nested episode metadata and converts playhead seconds to duration milliseconds", () => {
  const item = normalizeEntry(rawEpisode(2, { fully_watched: false, playhead: 1296 }));
  assert.equal(item.episodeNumber, 2);
  assert.equal(item.seasonId, "SEASON");
  assert.equal(item.watchedAt, "2026-09-29T12:00:00.000Z");
  assert.equal(isWatched(item, 0.9), true);
  assert.equal(isWatched({ ...item, playhead: 100 }, 0.9), false);
  assert.equal(isWatched({ ...item, durationMs: null }, 0.9), false);
  assert.equal(isWatched({ ...item, durationMs: 0 }, 0.9), false);
  assert.equal(isWatched(episode(1, { durationMs: null, playhead: 0 }), 0.9), true);
});

test("retains unavailable metadata, movies, and fractional specials without guessing", () => {
  const missing = normalizeEntry(rawEpisode(1, { panel: null, date_played: "invalid" }));
  assert.equal(missing.seasonId, null);
  assert.equal(missing.watchedAt, null);
  assert.equal(JSON.parse(missing.raw).panel, null);
  assert.equal(normalizeEntry(rawEpisode(0.5)).episodeNumber, 0.5);
  const movie = normalizeEntry({
    id: "MOVIE",
    fully_watched: true,
    panel: {
      type: "movie",
      title: "A movie",
      movie_metadata: { duration_ms: 5000 },
    },
  });
  assert.equal(movie.seasonId, "movie:MOVIE");
  assert.equal(movie.episodeNumber, 1);
});

test("paginates from page 1, respects next_page over total, and never follows external URLs", async () => {
  const urls: URL[] = [];
  const http = new JsonHttpClient(
    "Crunchyroll",
    mockFetch((input, init) => {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer secret");
      const url = new URL(input);
      urls.push(url);
      return Response.json(
        url.searchParams.get("page") === "1"
          ? {
              data: [rawEpisode(1)],
              total: 1,
              meta: { next_page: "https://untrusted.example/page2?page=opaque%2Bcursor%2F2%3D" },
            }
          : { data: [rawEpisode(2)], total: 999, meta: { next_page: "" } },
      );
    }),
  );
  const pages = await Array.fromAsync(new CrunchyrollClient(config, tokens, http).history());
  assert.equal(pages.length, 2);
  assert.equal(urls[0]?.pathname, "/content/v2/account/watch-history");
  assert.equal(urls[0]?.searchParams.get("page_size"), "100");
  assert.equal(urls[1]?.searchParams.get("page"), "opaque+cursor/2=");
  assert.ok(urls.every((url) => url.origin === config.baseUrl));
});

test("uses total across short pages and ends on an empty history", async () => {
  let calls = 0;
  const http = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => Response.json({ data: [rawEpisode(++calls)], total: 2 })),
  );
  assert.equal(
    (await Array.fromAsync(new CrunchyrollClient(config, tokens, http).history())).length,
    2,
  );
  const empty = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => Response.json({ data: [], total: 0 })),
  );
  assert.deepEqual(
    await Array.fromAsync(new CrunchyrollClient(config, tokens, empty).history()),
    [],
  );
});

test("follows relative cursor links and rejects missing or repeated cursors", async () => {
  const requested: string[] = [];
  const http = new JsonHttpClient(
    "Crunchyroll",
    mockFetch((input) => {
      const page = new URL(input).searchParams.get("page")!;
      requested.push(page);
      return Response.json(
        page === "1"
          ? {
              data: [rawEpisode(1)],
              total: 1,
              meta: { next_page: "?page=next-cursor&page_size=100" },
            }
          : { data: [rawEpisode(2)], total: 1, meta: { next_page: "" } },
      );
    }),
  );
  assert.equal(
    (await Array.fromAsync(new CrunchyrollClient(config, tokens, http).history())).length,
    2,
  );
  assert.deepEqual(requested, ["1", "next-cursor"]);

  const missing = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() =>
      Response.json({
        data: [rawEpisode(1)],
        meta: { next_page: "/watch-history?locale=en-US" },
      }),
    ),
  );
  await assert.rejects(
    Array.fromAsync(new CrunchyrollClient(config, tokens, missing).history()),
    /missing its page cursor/,
  );

  let requests = 0;
  const repeated = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => {
      requests++;
      return Response.json({ data: [rawEpisode(requests)], meta: { next_page: "?page=1" } });
    }),
  );
  await assert.rejects(
    Array.fromAsync(new CrunchyrollClient(config, tokens, repeated).history()),
    /repeated a pagination cursor/,
  );
  assert.equal(requests, 1);
});

test("rejects malformed responses and repeated pages instead of silently importing nothing", async () => {
  const malformed = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => Response.json({ error: "changed" })),
  );
  await assert.rejects(
    Array.fromAsync(new CrunchyrollClient(config, tokens, malformed).history()),
    /unexpected shape/,
  );
  const repeated = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => Response.json({ data: [rawEpisode()], total: 100 })),
  );
  await assert.rejects(
    Array.fromAsync(new CrunchyrollClient(config, tokens, repeated).history()),
    /repeated/,
  );
});

test("retries 429 using Retry-After and retries transient read failures", async () => {
  const delays: number[] = [];
  let calls = 0;
  const http = new JsonHttpClient(
    "Service",
    mockFetch(() => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "Retry-After": "2" } });
      if (calls === 2) return new Response("", { status: 503 });
      return Response.json({ ok: true });
    }),
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.deepEqual(await http.request("https://example.com"), { ok: true });
  assert.deepEqual(delays, [2000, 2000]);
  assert.equal(
    retryDelay(
      new Headers({ "Retry-After": "Tue, 29 Sep 2026 12:00:02 GMT" }),
      Date.parse("2026-09-29T12:00:00Z"),
    ),
    2000,
  );
});

test("does not retry uncertain writes, expose error bodies, or endlessly retry rate limits", async () => {
  let calls = 0;
  const http = new JsonHttpClient(
    "AniList",
    mockFetch(() => {
      calls++;
      return new Response("secret-token", { status: 500 });
    }),
  );
  await assert.rejects(http.request("https://example.com", { method: "POST" }, false), /HTTP 500/);
  assert.equal(calls, 1);
  const denied = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => new Response("secret-token", { status: 401 })),
  );
  await assert.rejects(
    denied.request("https://example.com"),
    (error: unknown) =>
      error instanceof HttpError && error.status === 401 && !error.message.includes("secret-token"),
  );
  calls = 0;
  const limited = new JsonHttpClient(
    "AniList",
    mockFetch(() => {
      calls++;
      return new Response("", { status: 429, headers: { "Retry-After": "0" } });
    }),
    async () => {},
  );
  await assert.rejects(limited.request("https://example.com"), /429/);
  assert.equal(calls, 4);
});

test("identifies Cloudflare challenges without leaking response bodies or retrying", async () => {
  let calls = 0;
  const http = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => {
      calls++;
      return new Response("<html>secret-session-data</html>", {
        status: 403,
        headers: { server: "cloudflare", "cf-mitigated": "challenge", "content-type": "text/html" },
      });
    }),
  );
  await assert.rejects(
    http.request("https://www.crunchyroll.com"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 403 &&
      error.reason === "cloudflare-challenge" &&
      error.message.includes("browser challenge") &&
      !error.message.includes("secret-session-data"),
  );
  assert.equal(calls, 1);
});

test("does not label every Cloudflare-served 403 as a challenge", async () => {
  const http = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() =>
      Response.json({ error: "forbidden" }, { status: 403, headers: { server: "cloudflare" } }),
    ),
  );
  await assert.rejects(
    http.request("https://www.crunchyroll.com"),
    (error: unknown) => error instanceof HttpError && error.reason === "http",
  );
});

test("a missing session stops history requests before contacting Crunchyroll", async () => {
  let calls = 0;
  const http = new JsonHttpClient(
    "Crunchyroll",
    mockFetch(() => {
      calls++;
      return Response.json({ data: [] });
    }),
  );
  const client = new CrunchyrollClient(
    config,
    {
      async getAccessToken() {
        throw new Error("No Crunchyroll session saved. Run pnpm dev auth login.");
      },
    },
    http,
  );
  await assert.rejects(Array.fromAsync(client.history()), /auth login/);
  assert.equal(calls, 0);
});
