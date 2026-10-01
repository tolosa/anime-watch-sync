import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ListEntry } from "../src/anilist.ts";
import { AniListClient } from "../src/anilist.ts";
import { buildSeasonMappings, Store } from "../src/database.ts";
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

test("existing SQLite mappings migrate additively and retain their legacy shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "anime-sync-migration-"));
  const path = join(dir, "history.sqlite");
  try {
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE mappings (
        season_id TEXT NOT NULL, media_id INTEGER NOT NULL CHECK(media_id > 0),
        episode_from INTEGER NOT NULL CHECK(episode_from > 0), episode_to INTEGER,
        episode_offset INTEGER NOT NULL,
        PRIMARY KEY (season_id, episode_from),
        CHECK(episode_to IS NULL OR episode_to >= episode_from),
        CHECK(episode_from - episode_offset > 0)
      ) STRICT;
      INSERT INTO mappings VALUES ('SEASON', 42, 1, NULL, 0);`);
    } finally {
      db.close();
    }
    {
      using store = new Store(path);
      assert.deepEqual(store.mappings(), [mapping]);
      assert.equal(store.db.prepare("SELECT mode FROM mappings").get()?.mode, "legacy");
      assert.equal(
        planProgress(
          collectProgress([episode(1), episode(3)], store.mappings(), 0.9).groups[0]!,
          media(),
        ).progress,
        2,
      );
      store.upsertHistory([episode()]);
      store.bindSource("account", "profile");
      store.setSeasonMapping("SEASON", 43);
    }
    using reopened = new Store(path);
    assert.deepEqual(reopened.mappings(), [{ ...mapping, mediaId: 43, mode: "count" }]);
    assert.equal(reopened.history().length, 1);
    reopened.bindSource("account", "profile");
    assert.throws(() => reopened.bindSource("other", "profile"), /different/);
    reopened.setMapping(mapping);
    assert.deepEqual(reopened.mappings(), [mapping]);
    assert.equal(reopened.db.prepare("SELECT mode FROM mappings").get()?.mode, "legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("season mappings validate and replace all legacy ranges transactionally", () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(), episode(1, { id: "OTHER", seasonId: "OTHER" })]);
  const ranges = [
    { ...mapping, to: 12 },
    { ...mapping, from: 13, to: 24, mediaId: 43, offset: 12 },
  ];
  for (const range of ranges) store.setMapping(range);
  store.setMapping({ ...mapping, seasonId: "OTHER" });
  const before = store.mappings();
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.setSeasonMapping("SEASON", id), /Invalid mapping/);
    assert.deepEqual(store.mappings(), before);
  }
  assert.throws(() => store.setSeasonMapping("UNKNOWN", 44), /Unknown season/);
  assert.deepEqual(store.mappings(), before);
  store.db.exec(`CREATE TRIGGER fail_count BEFORE INSERT ON mappings
    WHEN NEW.mode = 'count' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() => store.setSeasonMapping("SEASON", 44), /injected failure/);
  assert.deepEqual(store.mappings(), before);
  store.db.exec("DROP TRIGGER fail_count");
  store.setSeasonMapping("SEASON", 44);
  store.setSeasonMapping("SEASON", 45);
  assert.deepEqual(store.mappings(), [
    { ...mapping, seasonId: "OTHER" },
    { ...mapping, mediaId: 45, mode: "count" },
  ]);
  assert.equal(store.removeMapping("SEASON"), 1);
  assert.equal(store.removeMapping("SEASON"), 0);
  for (const range of ranges) store.setMapping(range);
  assert.equal(store.removeMapping("SEASON", 13), 1);
  store.setMapping(ranges[1]!);
  assert.equal(store.removeMapping("SEASON"), 2);
  assert.deepEqual(store.mappings(), [{ ...mapping, seasonId: "OTHER" }]);
});

test("ordered count mappings roundtrip, reorder, and reopen with an open final slice", () => {
  const dir = mkdtempSync(join(tmpdir(), "anime-sync-ordered-"));
  const targets = [
    { id: 99, episodes: 12 },
    { id: 42, episodes: 6 },
  ];
  const expected = [
    { ...mapping, mediaId: 99, to: 12, mode: "count" },
    { ...mapping, from: 13, offset: 12, mode: "count" },
  ];
  try {
    assert.deepEqual(buildSeasonMappings("SEASON", targets), expected);
    {
      using store = new Store(join(dir, "history.sqlite"));
      store.upsertHistory([episode()]);
      store.setSeasonMappings("SEASON", targets);
      assert.deepEqual(store.mappings(), expected);
    }
    using reopened = new Store(join(dir, "history.sqlite"));
    assert.deepEqual(reopened.mappings(), expected);
    reopened.setSeasonMappings("SEASON", [...targets].reverse());
    assert.deepEqual(reopened.mappings(), [
      { ...mapping, to: 6, mode: "count" },
      { ...mapping, mediaId: 99, from: 7, offset: 6, mode: "count" },
    ]);
    reopened.setSeasonMapping("SEASON", 43);
    assert.deepEqual(reopened.mappings(), [{ ...mapping, mediaId: 43, mode: "count" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordered count targets reject invalid lists and unsafe accumulated ranges without replacement", () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  store.setSeasonMappings("SEASON", [
    { id: 42, episodes: 12 },
    { id: 43, episodes: null },
  ]);
  const before = store.mappings();
  const invalid: { id: number; episodes: number | null }[][] = [
    [],
    [
      { id: 42, episodes: 12 },
      { id: 42, episodes: 12 },
    ],
    [
      { id: 42, episodes: null },
      { id: 43, episodes: 12 },
    ],
    [
      { id: 42, episodes: Number.MAX_SAFE_INTEGER },
      { id: 43, episodes: null },
    ],
    [
      { id: 42, episodes: Number.MAX_SAFE_INTEGER - 1 },
      { id: 43, episodes: 2 },
    ],
    [
      { id: 42, episodes: Number.MAX_SAFE_INTEGER - 2 },
      { id: 43, episodes: 3 },
      { id: 44, episodes: null },
    ],
  ];
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push([{ id: value, episodes: null }], [{ id: 42, episodes: value }]);
  }
  for (const targets of invalid) {
    assert.throws(() => buildSeasonMappings("SEASON", targets), /Invalid mapping/);
    assert.throws(() => store.setSeasonMappings("SEASON", targets), /Invalid mapping/);
    assert.deepEqual(store.mappings(), before);
  }
  assert.throws(() => buildSeasonMappings("", [{ id: 42, episodes: null }]), /Invalid mapping/);
  assert.throws(
    () => store.setSeasonMappings("UNKNOWN", [{ id: 42, episodes: null }]),
    /Unknown season/,
  );
  assert.deepEqual(store.mappings(), before);
  assert.deepEqual(buildSeasonMappings("SEASON", [{ id: 42, episodes: 12 }]), [
    { ...mapping, mode: "count" },
  ]);
  assert.equal(
    buildSeasonMappings("SEASON", [
      { id: 42, episodes: Number.MAX_SAFE_INTEGER - 1 },
      { id: Number.MAX_SAFE_INTEGER, episodes: 1 },
    ])[1]?.from,
    Number.MAX_SAFE_INTEGER,
  );
  assert.throws(() => store.setMapping({ ...before[1]!, offset: 11 }), /Invalid mapping/);
  assert.deepEqual(store.mappings(), before);
});

test("a failed later count mapping insert rolls back the entire season replacement", () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(), episode(1, { id: "OTHER", seasonId: "OTHER" })]);
  store.setMapping(mapping);
  store.setSeasonMapping("OTHER", 99);
  const before = store.mappings();
  store.db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON mappings
    WHEN NEW.media_id = 43 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(
    () =>
      store.setSeasonMappings("SEASON", [
        { id: 42, episodes: 12 },
        { id: 43, episodes: null },
      ]),
    /injected failure/,
  );
  assert.deepEqual(store.mappings(), before);
  store.db.exec("DROP TRIGGER fail_second");
  store.setSeasonMappings("SEASON", [
    { id: 42, episodes: 12 },
    { id: 43, episodes: null },
  ]);
  assert.deepEqual(store.mappings(), [
    { ...mapping, seasonId: "OTHER", mediaId: 99, mode: "count" },
    { ...mapping, to: 12, mode: "count" },
    { ...mapping, mediaId: 43, from: 13, offset: 12, mode: "count" },
  ]);
});

test("count mappings allocate sorted watched ordinals but retain source episode identities", () => {
  const mappings = buildSeasonMappings("SEASON", [
    { id: 99, episodes: 12 },
    { id: 42, episodes: 12 },
  ]);
  const items = Array.from({ length: 14 }, (_, i) => episode(101 + i * 10));
  const result = collectProgress(
    [
      ...items.reverse(),
      episode(101, { id: "DUB" }),
      episode(102, { fullyWatched: false, playhead: 1 }),
      episode(0),
      episode(101.5),
      episode(-1),
    ],
    [...mappings].reverse(),
    0.9,
  );
  assert.deepEqual(
    result.groups.map((group) => [group.mediaId, [...group.episodes]]),
    [
      [99, Array.from({ length: 12 }, (_, i) => 101 + i * 10)],
      [42, [221, 231]],
    ],
  );
  assert.equal(result.unmapped, 0);
  assert.equal(result.unnumbered, 3);
  assert.equal(planProgress(result.groups[0]!, media({ id: 99 })).status, "COMPLETED");
  assert.equal(planProgress(result.groups[1]!, media()).progress, 2);
});

test("three count selections leave empty later slices absent until new imports fill them", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(100), episode(300), episode(500)]);
  store.setSeasonMappings("SEASON", [
    { id: 42, episodes: 2 },
    { id: 43, episodes: 2 },
    { id: 44, episodes: null },
  ]);
  assert.deepEqual(store.mappings(), [
    { ...mapping, to: 2, mode: "count" },
    { ...mapping, mediaId: 43, from: 3, to: 4, offset: 2, mode: "count" },
    { ...mapping, mediaId: 44, from: 5, offset: 4, mode: "count" },
  ]);
  const fetched: number[] = [];
  const client: Pick<AniListClient, "viewer" | "media" | "save"> = {
    viewer: async () => ({ id: 7, name: "tester" }),
    media: async (id) => {
      fetched.push(id);
      return media({ id, episodes: id === 44 ? null : 2 });
    },
    save: async () => {
      throw new Error("preview must not save");
    },
  };
  const preview = await syncAniList(store, client, { dryRun: true, threshold: 0.9 });
  assert.deepEqual(fetched, [42, 43]);
  assert.deepEqual(
    preview.plans.map((plan) => [plan.mediaId, plan.progress]),
    [
      [42, 2],
      [43, 1],
    ],
  );
  store.upsertHistory([episode(700), episode(900), episode(1100)]);
  const next = await syncAniList(store, client, { dryRun: true, threshold: 0.9 });
  assert.deepEqual(
    next.plans.map((plan) => [plan.mediaId, plan.progress, plan.status]),
    [
      [42, 2, "COMPLETED"],
      [43, 2, "COMPLETED"],
      [44, 2, "CURRENT"],
    ],
  );
  assert.equal(next.plans[2]?.dates.completedAt, undefined);
});

test("the final count slice accepts future imports beyond its selected total and caps to live totals", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(100), episode(200), episode(300)]);
  store.setSeasonMappings("SEASON", [
    { id: 42, episodes: 2 },
    { id: 43, episodes: 2 },
  ]);
  let liveTotal = 4;
  const remotes = new Map<number, ListEntry>();
  let writes = 0;
  const client: Pick<AniListClient, "viewer" | "media" | "save"> = {
    viewer: async () => ({ id: 7, name: "tester" }),
    media: async (id) =>
      media({ id, episodes: id === 42 ? 2 : liveTotal, mediaListEntry: remotes.get(id) ?? null }),
    save: async (item, progress, status, dates) => {
      writes++;
      const saved: ListEntry = { id: item.id, progress, status, ...dates };
      remotes.set(item.id, saved);
      return saved;
    },
  };
  await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.equal(remotes.get(43)?.progress, 1);
  store.upsertHistory([episode(400), episode(500)]);
  const partial = await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.equal(partial.plans[1]?.progress, 3);
  assert.equal(partial.plans[1]?.status, "CURRENT");
  liveTotal = 5;
  store.upsertHistory([episode(600), episode(700), episode(800), episode(900)]);
  const complete = await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.equal(complete.plans[1]?.progress, 5);
  assert.equal(complete.plans[1]?.status, "COMPLETED");
  assert.equal(complete.unmapped, 0);
  const repeat = await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.ok(repeat.plans.every((plan) => plan.action === "skip"));
  assert.equal(writes, 4);
});

test("count slice dates keep earliest and latest duplicate viewings within their own slice", () => {
  const groups = collectProgress(
    [
      episode(100, { watchedAt: "2024-06-10T12:00:00Z" }),
      episode(300, { watchedAt: "2024-06-01T12:00:00Z" }),
      episode(300, { id: "REWATCH1", watchedAt: "2024-06-20T12:00:00Z" }),
      episode(500, { watchedAt: "2024-07-10T12:00:00Z" }),
      episode(500, { id: "REWATCH2", watchedAt: "2024-07-25T12:00:00Z" }),
      episode(700, { watchedAt: "2024-07-01T12:00:00Z" }),
      episode(900, { fullyWatched: false, playhead: 1, watchedAt: "2025-01-01T12:00:00Z" }),
    ],
    buildSeasonMappings("SEASON", [
      { id: 42, episodes: 2 },
      { id: 43, episodes: 2 },
    ]),
    0.9,
  ).groups;
  assert.equal(groups[0]?.watchedAt?.get(300), Date.parse("2024-06-01T12:00:00Z"));
  assert.equal(groups[0]?.latestWatchedAt, Date.parse("2024-06-20T12:00:00Z"));
  assert.equal(groups[1]?.watchedAt?.get(500), Date.parse("2024-07-10T12:00:00Z"));
  assert.equal(groups[1]?.latestWatchedAt, Date.parse("2024-07-25T12:00:00Z"));
  assert.deepEqual(planProgress(groups[0]!, media({ episodes: 2 })).dates, {
    startedAt: { year: 2024, month: 6, day: 1 },
    completedAt: { year: 2024, month: 6, day: 20 },
  });
  assert.deepEqual(planProgress(groups[1]!, media({ id: 43, episodes: 2 })).dates, {
    startedAt: { year: 2024, month: 7, day: 1 },
    completedAt: { year: 2024, month: 7, day: 25 },
  });
});

test("ordered count editions with different source numbering remain distinct without adding remote baselines", () => {
  const targets = [
    { id: 42, episodes: 2 },
    { id: 43, episodes: 4 },
  ];
  const groups = collectProgress(
    [
      ...[100, 300, 500, 700, 900].map((n) => episode(n, { watchedAt: null })),
      ...[1, 3, 5, 7].map((n) => episode(n, { seasonId: "DUB", watchedAt: null })),
      episode(3, { id: "DUPLICATE", seasonId: "DUB", watchedAt: null }),
    ],
    [...buildSeasonMappings("SEASON", targets), ...buildSeasonMappings("DUB", targets)],
    0.9,
  ).groups;
  assert.deepEqual(
    groups.map((group) => [group.mediaId, [...group.episodes]]),
    [
      [42, [100, 300, 1, 3]],
      [43, [500, 700, 900, 5, 7]],
    ],
  );
  for (const previous of [1, 5]) {
    const plan = planProgress(
      groups[1]!,
      media({
        id: 43,
        episodes: 4,
        mediaListEntry: { id: 9, progress: previous, status: "CURRENT" },
      }),
    );
    assert.equal(plan.progress, Math.max(previous, 4));
    assert.equal(plan.action, previous === 1 ? "update" : "skip");
  }
  const legacy = { ...mapping, seasonId: "LEGACY", mediaId: 43 };
  const mixed = collectProgress(
    [episode(100), episode(300), episode(500), episode(1, { seasonId: "LEGACY" })],
    [...buildSeasonMappings("SEASON", targets), legacy],
    0.9,
  );
  assert.deepEqual(mixed.groups.find((group) => group.mediaId === 43)?.episodes, new Set([1, 500]));
});

test("count mappings retain gaps and high numbers and deduplicate only matching episode identities", () => {
  const result = collectProgress(
    [
      episode(105),
      episode(101),
      episode(101, { id: "DUPLICATE" }),
      episode(110, { fullyWatched: false, playhead: 1296 }),
      episode(120, { fullyWatched: false, playhead: 1295 }),
      episode(50, { id: "DUB50", seasonId: "DUB" }),
      episode(90, { id: "DUB90", seasonId: "DUB" }),
      episode(0),
      episode(-1),
      episode(1.5),
      episode(1, { episodeNumber: null }),
      episode(1, { seasonId: null }),
      episode(1, { seasonId: "UNMAPPED" }),
    ],
    [
      { ...mapping, mode: "count" },
      { ...mapping, seasonId: "DUB", mode: "count" },
    ],
    0.9,
  );
  assert.equal(result.groups.length, 1);
  const group = result.groups[0]!;
  assert.equal("mode" in group, false);
  assert.deepEqual(group.episodes, new Set([101, 105, 110, 50, 90]));
  assert.equal(result.unmapped, 1);
  assert.equal(result.unnumbered, 5);
  assert.equal(planProgress(group, media()).progress, 5);
  assert.equal(planProgress(group, media({ episodes: null })).progress, 5);
  const partials = collectProgress(
    [episode(100, { fullyWatched: false, playhead: 10 })],
    [{ ...mapping, mode: "count" }],
    0.9,
  );
  assert.deepEqual(partials.groups, []);
});

test("count progress caps to AniList totals, is not added to remote progress, and never decreases", () => {
  const group = collectProgress(
    [episode(101), episode(103), episode(105), episode(107)],
    [{ ...mapping, mode: "count" }],
    0.9,
  ).groups[0]!;
  const capped = planProgress(group, media({ episodes: 3 }));
  assert.equal(capped.progress, 3);
  assert.equal(capped.status, "COMPLETED");
  assert.equal(capped.action, "update");
  assert.doesNotMatch(capped.reason, /exceeds/);
  assert.ok(capped.dates.completedAt);
  for (const episodes of [3, 12, null]) {
    for (const previous of [0, 2, 4, 8]) {
      const plan = planProgress(
        group,
        media({
          episodes,
          mediaListEntry: { id: 9, progress: previous, status: "CURRENT" },
        }),
      );
      assert.equal(plan.progress, Math.max(previous, Math.min(4, episodes ?? Infinity)));
    }
  }
  for (const status of ["COMPLETED", "REPEATING", "PAUSED", "DROPPED"] as const) {
    for (const episodes of [3, 12]) {
      const plan = planProgress(
        group,
        media({ episodes, mediaListEntry: { id: 9, progress: 2, status } }),
      );
      assert.equal(plan.progress, 2);
      assert.equal(plan.status, status);
      assert.equal(Boolean(plan.dates.completedAt), status === "COMPLETED" && episodes === 3);
    }
  }
});

test("count dates use actual timestamp bounds across ordinals and duplicate viewings", () => {
  const group = collectProgress(
    [
      episode(100, { watchedAt: "2024-06-10T12:00:00Z" }),
      episode(300, { watchedAt: "2024-06-01T12:00:00Z" }),
      episode(300, { id: "REWATCH", watchedAt: "2024-06-15T12:00:00Z" }),
      episode(400, { watchedAt: "2024-06-05T12:00:00Z" }),
      episode(100, { id: "DUB", seasonId: "DUB", watchedAt: "2024-06-20T12:00:00Z" }),
      episode(500, { fullyWatched: false, playhead: 1, watchedAt: "2025-01-01T12:00:00Z" }),
    ],
    [
      { ...mapping, mode: "count" },
      { ...mapping, seasonId: "DUB", mode: "count" },
    ],
    0.9,
  ).groups[0]!;
  for (const episodes of [2, 3]) {
    assert.deepEqual(planProgress(group, media({ episodes })).dates, {
      startedAt: { year: 2024, month: 6, day: 1 },
      completedAt: { year: 2024, month: 6, day: 20 },
    });
  }
  assert.equal(planProgress(group, media({ episodes: null })).dates.completedAt, undefined);
});

test("count dates do not fabricate missing timestamps or infer completion from remote progress", () => {
  const makeGroup = (items: ReturnType<typeof episode>[]) =>
    collectProgress(items, [{ ...mapping, mode: "count" }], 0.9).groups[0]!;
  for (const watchedAt of [null, "invalid"]) {
    const missing = makeGroup([episode(100, { watchedAt }), episode(200, { watchedAt })]);
    const plan = planProgress(missing, media({ episodes: 2 }));
    assert.equal(plan.progress, 2);
    assert.deepEqual(plan.dates, {});
    for (const items of [
      [episode(100, { watchedAt }), episode(200)],
      [episode(100), episode(200, { watchedAt })],
      [episode(100), episode(200), episode(300, { watchedAt })],
    ]) {
      const dates = planProgress(makeGroup(items), media({ episodes: 2 })).dates;
      assert.deepEqual(dates.startedAt, { year: 2026, month: 9, day: 29 });
      assert.equal(dates.completedAt, undefined);
    }
  }
  const completed = media({
    episodes: 3,
    mediaListEntry: { id: 9, progress: 3, status: "COMPLETED" },
  });
  assert.equal(planProgress(makeGroup([episode(100)]), completed).dates.completedAt, undefined);
});

test("One Piece-like arcs union legacy/count mappings and overlapping editions independent of order", () => {
  const items = [
    episode(61, { watchedAt: "2024-06-10T12:00:00Z" }),
    episode(63, { watchedAt: "2024-06-05T12:00:00Z" }),
    episode(60, { watchedAt: "2020-01-01T12:00:00Z" }),
    episode(64, { watchedAt: "2030-01-01T12:00:00Z" }),
    episode(161, { seasonId: "OFFSET", watchedAt: "2024-06-01T12:00:00Z" }),
    episode(163, { seasonId: "OFFSET", watchedAt: "2024-06-15T12:00:00Z" }),
    episode(61, { seasonId: "EDITION", watchedAt: null }),
    episode(63, { seasonId: "EDITION", watchedAt: "2024-07-25T12:00:00Z" }),
    episode(65, { seasonId: "EDITION", watchedAt: "2024-06-20T12:00:00Z" }),
    episode(101, { seasonId: "NEXT_ARC", watchedAt: "2024-07-01T12:00:00Z" }),
    episode(103, { seasonId: "NEXT_ARC", watchedAt: "2024-07-10T12:00:00Z" }),
  ];
  const mappings = [
    { ...mapping, from: 61, to: 63 },
    { ...mapping, seasonId: "OFFSET", from: 161, to: 163, offset: 100 },
    { ...mapping, seasonId: "EDITION", mode: "count" as const },
    { ...mapping, seasonId: "NEXT_ARC", mode: "count" as const },
  ];
  for (const history of [items, [...items].reverse()]) {
    for (const orderedMappings of [mappings, [...mappings].reverse()]) {
      const result = collectProgress(history, orderedMappings, 0.9);
      assert.equal(result.groups.length, 1);
      assert.equal(result.unmapped, 2);
      assert.equal(result.unnumbered, 0);
      const group = result.groups[0]!;
      assert.equal("mode" in group, false);
      assert.deepEqual(group.episodes, new Set([61, 63, 65, 101, 103]));
      assert.deepEqual(
        group.watchedAt,
        new Map([
          [61, Date.parse("2024-06-01T12:00:00Z")],
          [63, Date.parse("2024-06-05T12:00:00Z")],
          [65, Date.parse("2024-06-20T12:00:00Z")],
          [101, Date.parse("2024-07-01T12:00:00Z")],
          [103, Date.parse("2024-07-10T12:00:00Z")],
        ]),
      );
      assert.equal(group.latestWatchedAt, Date.parse("2024-07-25T12:00:00Z"));
      const plan = planProgress(group, media({ episodes: 5 }));
      assert.equal(plan.progress, 5);
      assert.equal(plan.status, "COMPLETED");
      assert.equal(plan.action, "update");
      assert.deepEqual(plan.dates, {
        startedAt: { year: 2024, month: 6, day: 1 },
        completedAt: { year: 2024, month: 7, day: 25 },
      });
    }
  }
});

test("count sync previews, applies a capped count, and converges without adding a remote baseline", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(101), episode(103), episode(105)]);
  store.setSeasonMapping("SEASON", 42);
  let remote: ListEntry = { id: 9, progress: 1, status: "CURRENT" };
  let writes = 0;
  const client: Pick<AniListClient, "viewer" | "media" | "save"> = {
    viewer: async () => ({ id: 7, name: "tester" }),
    media: async () => media({ episodes: 2, mediaListEntry: remote }),
    save: async (_media, progress, status, dates) => {
      writes++;
      remote = { ...remote, progress, status, ...dates };
      return remote;
    },
  };
  const preview = await syncAniList(store, client, { dryRun: true, threshold: 0.9 });
  assert.equal(preview.plans[0]?.progress, 2);
  assert.equal(writes, 0);
  await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  const repeat = await syncAniList(store, client, { dryRun: false, threshold: 0.9 });
  assert.equal(repeat.plans[0]?.action, "skip");
  assert.equal(remote.progress, 2);
  assert.equal(remote.status, "COMPLETED");
  assert.equal(writes, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sync_log").get()?.n, 1);
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

test("counts unique episodes despite gaps and completes at the known episode count", () => {
  const group = { mediaId: 42, episodes: new Set([1, 2, 4]) };
  assert.equal(planProgress(group, media()).progress, 3);
  const plan = planProgress(group, media({ episodes: 3 }));
  assert.equal(plan.action, "update");
  assert.equal(plan.status, "COMPLETED");
  assert.equal(planProgress(group, media({ episodes: null })).status, "CURRENT");
  assert.equal(planProgress({ ...group, episodes: new Set([300]) }, media()).progress, 1);
});

test("honors remote progress, accepts high episode numbers, and preserves manually chosen statuses", () => {
  const group = { mediaId: 42, episodes: new Set([5, 6]) };
  const current = media({ mediaListEntry: { id: 9, progress: 4, status: "CURRENT" } });
  assert.equal(planProgress(group, current).progress, 4);
  assert.equal(planProgress({ ...group, episodes: new Set([1, 2]) }, current).progress, 4);
  const high = planProgress(
    { ...group, episodes: new Set([100, 200, 300]) },
    media({ episodes: 2 }),
  );
  assert.equal(high.progress, 2);
  assert.equal(high.status, "COMPLETED");
  assert.equal(high.action, "update");
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
    completedAt: { year: 2025, month: 8, day: 1 },
  });
});

test("incomplete or invalid timestamp history never invents start/finish dates", () => {
  const makeGroup = (items: ReturnType<typeof episode>[]) =>
    collectProgress(items, [mapping], 0.9).groups[0]!;
  const completed = media({
    episodes: 3,
    mediaListEntry: { id: 9, progress: 3, status: "COMPLETED" },
  });
  assert.deepEqual(planProgress(makeGroup([episode(2), episode(3)]), completed).dates, {
    startedAt: { year: 2026, month: 9, day: 29 },
  });
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
  const gapped = planProgress(makeGroup([episode(1), episode(4)]), completed);
  assert.equal(gapped.action, "update");
  assert.deepEqual(gapped.dates, { startedAt: { year: 2026, month: 9, day: 29 } });
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
