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
        assert.equal(Object.hasOwn(body.variables, "id"), false);
        assert.doesNotMatch(body.query, /\$id\b/);
        assert.deepEqual(body.variables.startedAt, { year: 2026, month: 9, day: 29 });
        assert.deepEqual(body.variables.completedAt, { year: 2026, month: 9, day: 29 });
        assert.match(body.query, /\$startedAt: FuzzyDateInput!/);
        assert.match(body.query, /completedAt: \$completedAt/);
        remote = {
          id: 9,
          progress: body.variables.progress,
          status: body.variables.status,
          startedAt: body.variables.startedAt,
          completedAt: body.variables.completedAt,
        };
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

test("saving an existing AniList entry retains its list entry ID", async () => {
  const client = new AniListClient(
    "token",
    new JsonHttpClient(
      "AniList",
      mockFetch((_url, init) => {
        const body = JSON.parse(String(init.body));
        assert.match(body.query, /\$id: Int!/);
        assert.match(body.query, /SaveMediaListEntry\(id: \$id,/);
        assert.deepEqual(body.variables, { id: 9, mediaId: 42, progress: 2, status: "CURRENT" });
        return Response.json({
          data: { SaveMediaListEntry: { id: 9, progress: 2, status: "CURRENT" } },
        });
      }),
    ),
  );
  const saved = await client.save(
    media({ mediaListEntry: { id: 9, progress: 1, status: "CURRENT" } }),
    2,
    "CURRENT",
  );
  assert.equal(saved.progress, 2);
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

test("watch dates respect split mappings, deduplicate dubs, and handle out-of-order viewing", () => {
  const collected = collectProgress(
    [
      episode(12, { watchedAt: "2020-01-01T12:00:00Z" }),
      episode(13, { watchedAt: "2024-06-01T12:00:00Z" }),
      episode(13, { id: "DUB", watchedAt: "2025-08-01T12:00:00Z" }),
      episode(14, { watchedAt: "2024-06-10T12:00:00Z" }),
      episode(15, { watchedAt: "2024-06-05T12:00:00Z" }),
      episode(16, { fullyWatched: false, playhead: 10, watchedAt: "2025-09-01T12:00:00Z" }),
    ],
    [{ ...mapping, from: 13, to: 16, offset: 12 }],
    0.9,
  );
  const plan = planProgress(collected.groups[0]!, media({ episodes: 3 }));
  assert.deepEqual(plan.dates, {
    startedAt: { year: 2024, month: 6, day: 1 },
    completedAt: { year: 2024, month: 6, day: 10 },
  });
});

test("incomplete or invalid timestamp history never invents start/finish dates", () => {
  const makeGroup = (items: ReturnType<typeof episode>[]) =>
    collectProgress(items, [mapping], 0.9).groups[0]!;
  const completed = media({
    episodes: 3,
    mediaListEntry: { id: 9, progress: 3, status: "COMPLETED" },
  });
  assert.deepEqual(planProgress(makeGroup([episode(2), episode(3)]), completed).dates, {});
  for (const watchedAt of [null, "invalid"]) {
    const plan = planProgress(
      makeGroup([episode(1), episode(2, { watchedAt }), episode(3)]),
      completed,
    );
    assert.ok(plan.dates.startedAt);
    assert.equal(plan.dates.completedAt, undefined);
  }
  assert.deepEqual(planProgress(makeGroup([episode(1, { watchedAt: null })]), media()).dates, {});
  assert.equal(
    planProgress(makeGroup([episode(1), episode(3)]), completed).dates.completedAt,
    undefined,
  );
  const unknown = planProgress(makeGroup([episode(1), episode(2)]), media({ episodes: null }));
  assert.ok(unknown.dates.startedAt);
  assert.equal(unknown.dates.completedAt, undefined);
  const overflow = planProgress(makeGroup([episode(1), episode(4)]), completed);
  assert.equal(overflow.action, "skip");
  assert.deepEqual(overflow.dates, {});
});

test("dates replace existing values without changing preserved progress/status", () => {
  const group = collectProgress([episode(1), episode(2), episode(3)], [mapping], 0.9).groups[0]!;
  for (const status of ["COMPLETED", "REPEATING", "PAUSED", "DROPPED", "CURRENT"] as const) {
    const plan = planProgress(
      group,
      media({
        episodes: 3,
        mediaListEntry: {
          id: 9,
          progress: 3,
          status,
          startedAt: { year: 2026, month: 9, day: 30 },
          completedAt: { year: 2026, month: 9, day: 30 },
        },
      }),
    );
    assert.equal(plan.action, "update");
    assert.equal(plan.progress, 3);
    assert.equal(plan.status, status);
    assert.deepEqual(plan.dates.startedAt, { year: 2026, month: 9, day: 29 });
    assert.equal(Boolean(plan.dates.completedAt), status === "COMPLETED");
  }
});

test("date-only backfills preview, apply, and converge for already completed entries", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(1), episode(2)]);
  store.setMapping(mapping);
  let remote: ListEntry = {
    id: 9,
    progress: 2,
    status: "COMPLETED",
    startedAt: { year: 2026, month: 9, day: 30 },
    completedAt: { year: 2026, month: 9, day: 30 },
  };
  let writes = 0;
  const client = new AniListClient(
    "token",
    new JsonHttpClient(
      "AniList",
      mockFetch((_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.query.includes("Viewer"))
          return Response.json({ data: { Viewer: { id: 7, name: "tester" } } });
        if (body.query.includes("SaveMediaListEntry")) {
          writes++;
          assert.equal(body.variables.progress, 2);
          assert.equal(body.variables.status, "COMPLETED");
          remote = {
            ...remote,
            startedAt: body.variables.startedAt,
            completedAt: body.variables.completedAt,
          };
          return Response.json({ data: { SaveMediaListEntry: remote } });
        }
        return Response.json({ data: { Media: media({ episodes: 2, mediaListEntry: remote }) } });
      }),
    ),
  );
  const preview = await syncAniList(store, client, { dryRun: true, threshold: 0.9 });
  assert.equal(preview.plans[0]?.action, "update");
  assert.equal(writes, 0);
  await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  const repeat = await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.equal(repeat.plans[0]?.action, "skip");
  assert.equal(writes, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sync_log").get()?.n, 1);
});

test("unconfirmed watch dates fail without recording a successful sync", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(1)]);
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
          return Response.json({
            data: {
              SaveMediaListEntry: {
                id: 9,
                progress: 1,
                status: "CURRENT",
                startedAt: { year: 2026, month: 9, day: 30 },
              },
            },
          });
        return Response.json({ data: { Media: media() } });
      }),
    ),
  );
  await assert.rejects(
    syncAniList(store, client, { dryRun: false, threshold: 0.9 }),
    /confirm.*watch dates/,
  );
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sync_log").get()?.n, 0);
});
