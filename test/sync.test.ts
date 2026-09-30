import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ListEntry } from "../src/anilist.ts";
import { AniListClient } from "../src/anilist.ts";
import { Store } from "../src/database.ts";
import { JsonHttpClient } from "../src/http.ts";
import { collectProgress, planProgress, syncAniList } from "../src/sync.ts";
import { episode, mapping, media, mockFetch } from "./helpers.ts";

test("SQLite persists idempotent imports and retains completed progress during rewatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "anime-sync-"));
  try {
    {
      using store = new Store(join(dir, "history.sqlite"));
      store.upsertHistory([episode()]);
      store.upsertHistory([
        episode(1, { fullyWatched: false, playhead: 10, watchedAt: "2026-09-30T12:00:00.000Z" }),
      ]);
      assert.equal(store.history().length, 1);
      assert.equal(store.history()[0]?.fullyWatched, true);
      assert.equal(store.history()[0]?.playhead, 1400);
      assert.equal(store.history()[0]?.watchedAt, "2026-09-30T12:00:00.000Z");
    }
    using reopened = new Store(join(dir, "history.sqlite"));
    assert.equal(reopened.history()[0]?.id, "EP1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed page transaction rolls back every item on that page", () => {
  using store = new Store(":memory:");
  assert.throws(() =>
    store.upsertHistory([episode(1), episode(2, { raw: null as unknown as string })]),
  );
  assert.equal(store.history().length, 0);
});

test("database rejects source/profile and target account changes", () => {
  using store = new Store(":memory:");
  store.bindSource("one", "profile1");
  store.bindSource("one", "profile1");
  assert.throws(() => store.bindSource("two", "profile1"), /different/);
  assert.throws(() => store.bindSource("one", "profile2"), /different/);
  store.bindTarget(1, true);
  assert.throws(() => store.bindTarget(2, false), /different/);
});

test("mapping ranges support split cours, replacement, and reject overlap or invalid offsets", () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  store.setMapping({ ...mapping, to: 12 });
  store.setMapping({ ...mapping, from: 13, to: 24, mediaId: 43, offset: 12 });
  assert.throws(() => store.setMapping({ ...mapping, from: 10, to: 14 }), /overlaps/);
  assert.throws(() => store.setMapping({ ...mapping, offset: 1 }), /Invalid mapping/);
  assert.throws(() => store.setMapping({ ...mapping, seasonId: "UNKNOWN" }), /Unknown season/);
  store.setMapping({ ...mapping, to: 12, mediaId: 44 });
  assert.equal(store.mappings().length, 2);
  assert.equal(store.mappings()[0]?.mediaId, 44);
  assert.equal(store.removeMapping("SEASON", 13), 1);
});

test("deduplicates dubs, applies offsets, and skips partial/unmapped/fractional episodes", () => {
  const result = collectProgress(
    [
      episode(13),
      episode(13, { id: "DUB" }),
      episode(14),
      episode(15, { fullyWatched: false, playhead: 10 }),
      episode(12),
      episode(0.5),
      episode(1, { seasonId: null }),
    ],
    [{ ...mapping, from: 13, to: 24, offset: 12 }],
    0.9,
  );
  assert.deepEqual([...result.groups[0]!.episodes], [1, 2]);
  assert.equal(result.unmapped, 1);
  assert.equal(result.unnumbered, 2);
});

test("only advances consecutive episodes and completes at the known episode count", () => {
  const group = { mediaId: 42, episodes: new Set([1, 2, 4]) };
  assert.equal(planProgress(group, media()).progress, 2);
  const plan = planProgress({ ...group, episodes: new Set([1, 2, 3]) }, media({ episodes: 3 }));
  assert.equal(plan.action, "update");
  assert.equal(plan.status, "COMPLETED");
  assert.equal(
    planProgress({ ...group, episodes: new Set([1, 2, 3]) }, media({ episodes: null })).status,
    "CURRENT",
  );
  assert.match(
    planProgress({ ...group, episodes: new Set([3]) }, media()).reason,
    /Missing watched episode 1/,
  );
});

test("honors remote progress, detects mapping overflow, and preserves manually chosen statuses", () => {
  const group = { mediaId: 42, episodes: new Set([5, 6]) };
  const current = media({ mediaListEntry: { id: 9, progress: 4, status: "CURRENT" } });
  assert.equal(planProgress(group, current).progress, 6);
  assert.equal(planProgress({ ...group, episodes: new Set([1, 2]) }, current).progress, 4);
  assert.match(planProgress({ ...group, episodes: new Set([1, 20]) }, current).reason, /exceeds/);
  for (const status of ["COMPLETED", "REPEATING", "PAUSED", "DROPPED"] as const) {
    assert.equal(
      planProgress(group, media({ mediaListEntry: { id: 9, progress: 4, status } })).action,
      "skip",
    );
  }
});

test("preview sends no mutations; apply writes and logs once; reruns consult live AniList progress", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(1), episode(2), episode(3)]);
  store.setMapping(mapping);
  let remote: ListEntry | null = null;
  let mutations = 0;
  const http = new JsonHttpClient(
    "AniList",
    mockFetch((url, init) => {
      assert.equal(url, "https://graphql.anilist.co");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer token");
      const body = JSON.parse(String(init.body));
      if (body.query.includes("Viewer"))
        return Response.json({ data: { Viewer: { id: 7, name: "tester" } } });
      if (body.query.includes("SaveMediaListEntry")) {
        mutations++;
        assert.equal(body.variables.progress, 3);
        assert.equal(body.variables.mediaId, 42);
        assert.equal(body.variables.status, "COMPLETED");
        assert.equal(body.variables.id, null);
        remote = { id: 9, progress: body.variables.progress, status: body.variables.status };
        return Response.json({ data: { SaveMediaListEntry: remote } });
      }
      return Response.json({ data: { Media: media({ episodes: 3, mediaListEntry: remote }) } });
    }),
  );
  const client = new AniListClient("token", http);
  const preview = await syncAniList(store, client, { dryRun: true, threshold: 0.9 });
  assert.equal(preview.plans[0]?.progress, 3);
  assert.equal(mutations, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM metadata").get()?.n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sync_log").get()?.n, 0);
  await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.equal(mutations, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sync_log").get()?.n, 1);
});

test("failed GraphQL mutations do not produce a successful sync log", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  store.setMapping(mapping);
  const client = new AniListClient(
    "token",
    new JsonHttpClient(
      "AniList",
      mockFetch((_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.query.includes("Viewer"))
          return Response.json({ data: { Viewer: { id: 7, name: "tester" } } });
        if (body.query.includes("SaveMediaListEntry"))
          return Response.json({ data: null, errors: [{ message: "secret" }] });
        return Response.json({ data: { Media: media() } });
      }),
    ),
  );
  await assert.rejects(
    syncAniList(store, client, { dryRun: false, threshold: 0.9 }),
    /GraphQL errors/,
  );
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sync_log").get()?.n, 0);
});
