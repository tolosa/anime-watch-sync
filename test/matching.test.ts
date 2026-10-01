import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Media } from "../src/anilist.ts";
import { Store } from "../src/database.ts";
import { mapInteractively } from "../src/interactive-map.ts";
import { localSeasons, matchingCandidates } from "../src/matching.ts";
import { collectProgress, planProgress, syncAniList } from "../src/sync.ts";
import { type MappingPrompt, TerminalPrompt } from "../src/terminal.ts";
import { episode, mapping, media } from "./helpers.ts";

const countMapping = { ...mapping, mode: "count" as const };

function scriptedPrompt(answers: (string | null)[], beforeRead?: (question: string) => void) {
  const output: string[] = [];
  const prompt: MappingPrompt = {
    write: (message) => {
      output.push(message);
    },
    read: async (question) => {
      output.push(question);
      beforeRead?.(question);
      assert.ok(answers.length, `Unexpected question: ${question}`);
      return answers.shift()!;
    },
  };
  return { prompt, output };
}

function clientFor(results: Media[] = [media()]) {
  const searches: string[] = [];
  const reads: number[] = [];
  return {
    searches,
    reads,
    async search(query: string) {
      searches.push(query);
      return results;
    },
    async media(id: number) {
      reads.push(id);
      return results.find((m) => m.id === id) ?? media({ id });
    },
  };
}

test("derives searches from season metadata, strips dubs, preserves arcs, and handles movies/missing titles", () => {
  const seasons = localSeasons(
    [
      episode(13, { seasonTitle: "Season 2 (English Dub)" }),
      episode(13, { id: "DUPLICATE", seasonTitle: "" }),
      episode(13.5),
      episode(1, {
        id: "ARC",
        seasonId: "ARC",
        seasonTitle: "Test Anime (Final Arc) (Spanish Dub)",
      }),
      episode(1, {
        id: "MOVIE",
        seasonId: "movie:MOVIE",
        seasonTitle: "",
        seriesTitle: "",
        episodeTitle: "A Movie",
      }),
      episode(1, {
        id: "MISSING",
        seasonId: "MISSING",
        seasonTitle: "",
        seriesTitle: "",
        episodeTitle: "Episode title is not a series",
      }),
      episode(2, { id: "NO_SEASON", seasonId: null }),
    ],
    [mapping],
  );
  assert.equal(seasons.length, 4);
  assert.deepEqual(seasons.find((s) => s.id === "SEASON")?.queries, [
    "Test Anime Season 2",
    "Test Anime",
  ]);
  assert.deepEqual(seasons.find((s) => s.id === "SEASON")?.episodes, [13]);
  assert.equal(seasons.find((s) => s.id === "SEASON")?.watchedCount, 1);
  assert.deepEqual(seasons.find((s) => s.id === "SEASON")?.mappings, [mapping]);
  assert.equal(seasons.find((s) => s.id === "ARC")?.queries[0], "Test Anime (Final Arc)");
  assert.deepEqual(seasons.find((s) => s.id === "movie:MOVIE")?.queries, ["A Movie"]);
  assert.deepEqual(seasons.find((s) => s.id === "MISSING")?.queries, []);
});

test("watched counts deduplicate episode numbers and exclude partial or non-positive-integer episodes", () => {
  const history = [
    episode(13),
    episode(13, { id: "DUB" }),
    episode(24),
    episode(25, { fullyWatched: false, playhead: 100 }),
    episode(26, { fullyWatched: false, durationMs: 1_000_000, playhead: 850 }),
    episode(27, { fullyWatched: false, durationMs: 1_000_000, playhead: 900 }),
    episode(28, { fullyWatched: false, durationMs: null }),
    episode(29, { fullyWatched: false, durationMs: 0 }),
    episode(0),
    episode(-1),
    episode(13.5),
    episode(1, { id: "UNNUMBERED", episodeNumber: null }),
    episode(1, { id: "UNSAFE", episodeNumber: Number.MAX_SAFE_INTEGER + 1 }),
    episode(1, { id: "NO_SEASON", seasonId: null }),
  ];
  assert.equal(localSeasons(history, [])[0]?.watchedCount, 3);
  assert.equal(localSeasons(history, [], 0.8)[0]?.watchedCount, 4);
  assert.equal(localSeasons(history, [], 1)[0]?.watchedCount, 2);
});

test("merges title searches and ranks the relevant season using English or romaji titles", async () => {
  const first = media({ id: 1, title: { english: "Test Anime Season 1", romaji: null } });
  const second = media({
    id: 2,
    title: { english: "Different English Title", romaji: "Test Anime 2nd Season" },
  });
  const queries: string[] = [];
  const result = await matchingCandidates(
    {
      search: async (query) => {
        queries.push(query);
        return query === "Test Anime Season 2"
          ? [first, second]
          : [second, first, media({ id: 3 })];
      },
    },
    ["Test Anime Season 2", "Test Anime"],
  );
  assert.deepEqual(queries, ["Test Anime Season 2", "Test Anime"]);
  assert.deepEqual(
    result.map((m) => m.id),
    [2, 1, 3],
  );
});

test("interactive selection validates the chosen media and saves only after review", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  const client = clientFor([
    media({ id: 41, title: { english: "Unrelated", romaji: null } }),
    media(),
  ]);
  const { prompt, output } = scriptedPrompt(["99", "1", ""], () =>
    assert.deepEqual(
      store.mappings().map((m) => ({ ...m })),
      [],
    ),
  );
  await mapInteractively(store, localSeasons(store.history(), []), client, prompt);
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [countMapping],
  );
  assert.deepEqual(client.reads, [42]);
  assert.match(output.join("\n"), /TV \| 12 episodes \| ID 42/);
  assert.match(output.join("\n"), /https:\/\/anilist.co\/anime\/42/);
  assert.match(output.join("\n"), /1 mapping\(s\) saved/);
});

test("comma selections preserve reverse order, whitespace, review allocation, and whole-season replacement", async (t) => {
  for (const [answer, watched] of [
    ["2,1", 18],
    ["  2 , 1  ", 18],
    ["2,1", 30],
  ] as const) {
    await t.test(`${JSON.stringify(answer)} with ${watched} watched`, async (t) => {
      using store = new Store(":memory:");
      store.upsertHistory([
        ...Array.from({ length: watched }, (_, index) => episode(101 + index * 2)),
        episode(1, { id: "OTHER", seasonId: "OTHER" }),
      ]);
      const other = { ...mapping, seasonId: "OTHER", mediaId: 99 };
      store.setMapping(other);
      store.setMapping({ ...mapping, mediaId: 10, to: 12 });
      store.setMapping({ ...mapping, mediaId: 11, from: 13, to: 24, offset: 12 });
      store.setMapping({ ...mapping, mediaId: 12, from: 25, offset: 24 });
      const before = store.mappings();
      const candidates = [media(), media({ id: 43 })];
      const client = clientFor(candidates);
      const save = t.mock.method(store, "setSeasonMappings");
      const secondCount = Math.min(watched - 12, 12);
      const { prompt, output } = scriptedPrompt([answer, "y"], (question) => {
        assert.deepEqual(store.mappings(), before);
        assert.equal(save.mock.callCount(), 0);
        if (question.startsWith("Save mapping?")) {
          assert.deepEqual(client.reads, [43, 42]);
          assert.ok(output.includes("1. Test Anime (43): 12 viewed episode(s) / 12."));
          assert.ok(output.includes(`2. Test Anime (42): ${secondCount} viewed episode(s) / 12.`));
        }
      });
      await mapInteractively(
        store,
        localSeasons(store.history(), before).filter((season) => season.id === "SEASON"),
        client,
        prompt,
      );
      assert.equal(save.mock.callCount(), 1);
      assert.deepEqual(save.mock.calls[0]!.arguments, ["SEASON", [candidates[1], candidates[0]]]);
      assert.deepEqual(store.mappings(), [
        other,
        { ...countMapping, mediaId: 43, to: 12 },
        { ...countMapping, from: 13, offset: 12 },
      ]);
      assert.equal(output.filter((line) => line.startsWith("Save mapping?")).length, 1);
      assert.ok(
        output.includes(
          "Choose 1–2 (comma-separated for multiple, in watch order), s search, i enter ID, Enter skip, q quit: ",
        ),
      );
      assert.ok(output.includes("Mapping: SEASON → Test Anime (43) → Test Anime (42)."));
      assert.ok(output.includes("Saved SEASON → Test Anime (43) → Test Anime (42)."));
      assert.ok(
        output.includes(
          `${watched} watched Crunchyroll episode(s), allocated in the selected order.`,
        ),
      );
      if (watched > 24) {
        assert.ok(
          output.includes(
            "6 episode(s) exceed the selected entries' totals and will not increase progress.",
          ),
        );
      } else {
        assert.doesNotMatch(output.join("\n"), /exceed the selected entries/);
      }
      assert.match(output.join("\n"), /Saving replaces the existing mapping\(s\) for this season/);
      assert.match(output.join("\n"), /1 mapping\(s\) saved/);

      const { groups } = collectProgress(store.history(), store.mappings(), 0.9);
      assert.deepEqual(
        groups
          .filter((group) => group.mediaId !== 99)
          .map((group) => {
            const plan = planProgress(
              group,
              candidates.find((candidate) => candidate.id === group.mediaId)!,
            );
            return [plan.mediaId, plan.progress];
          }),
        [
          [43, 12],
          [42, secondCount],
        ],
      );
    });
  }
});

test("more than two selections preview zero later counts without creating empty remote entries", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(101), episode(103)]);
  const candidates = [media(), media({ id: 43 }), media({ id: 44 })];
  const client = clientFor(candidates);
  const { prompt, output } = scriptedPrompt(["3,1,2", "y"]);
  await mapInteractively(store, localSeasons(store.history(), []), client, prompt);
  assert.deepEqual(client.reads, [44, 42, 43]);
  assert.deepEqual(store.mappings(), [
    { ...countMapping, mediaId: 44, to: 12 },
    { ...countMapping, from: 13, to: 24, offset: 12 },
    { ...countMapping, mediaId: 43, from: 25, offset: 24 },
  ]);
  assert.ok(output.includes("1. Test Anime (44): 2 viewed episode(s) / 12."));
  assert.ok(output.includes("2. Test Anime (42): 0 viewed episode(s) / 12."));
  assert.ok(output.includes("3. Test Anime (43): 0 viewed episode(s) / 12."));
  assert.equal(output.filter((line) => line.startsWith("Save mapping?")).length, 1);

  client.reads.length = 0;
  const writes: [number, number][] = [];
  const result = await syncAniList(
    store,
    {
      ...client,
      viewer: async () => ({ id: 1, name: "Test viewer" }),
      save: async (selected, progress, status) => {
        writes.push([selected.id, progress]);
        return { id: selected.id, progress, status };
      },
    },
    { dryRun: false, threshold: 0.9 },
  );
  assert.deepEqual(client.reads, [44]);
  assert.deepEqual(writes, [[44, 2]]);
  assert.deepEqual(
    result.plans.map((plan) => [plan.mediaId, plan.progress]),
    [[44, 2]],
  );

  const saved = store.mappings();
  store.upsertHistory(Array.from({ length: 38 }, (_, index) => episode(101 + index * 2)));
  const { groups } = collectProgress(store.history(), store.mappings(), 0.9);
  assert.deepEqual(
    groups.map((group) => [group.mediaId, group.episodes.size]),
    [
      [44, 12],
      [42, 12],
      [43, 14],
    ],
  );
  // Live totals cap progress but do not move the boundaries saved during mapping.
  assert.deepEqual(
    groups.map((group) => {
      const plan = planProgress(
        group,
        media({ id: group.mediaId, episodes: group.mediaId === 44 ? 10 : 13 }),
      );
      return [plan.mediaId, plan.progress];
    }),
    [
      [44, 10],
      [42, 12],
      [43, 13],
    ],
  );
  assert.deepEqual(store.mappings(), saved);
});

test("malformed, out-of-bounds, and duplicate lists reject the whole selection before any media reads or writes", async (t) => {
  for (const answer of [
    "1,",
    ",1",
    "1,,2",
    "1, ,2",
    "1 2",
    "1;2",
    "1,2x",
    "1,1.5",
    "1,-2",
    "1,0",
    "0,1",
    "1,3",
    "3,1",
    "1,2,99",
    "42,43",
    "1,1",
    "2,1,2",
    "1,01",
  ]) {
    await t.test(answer, async (t) => {
      using store = new Store(":memory:");
      store.upsertHistory([episode()]);
      store.setSeasonMappings("SEASON", [media({ id: 10 }), media({ id: 11 })]);
      const before = store.mappings();
      const changes = store.db.prepare("SELECT total_changes() AS count").get();
      const save = t.mock.method(store, "setSeasonMappings");
      const client = clientFor([media(), media({ id: 43 })]);
      const { prompt, output } = scriptedPrompt([answer, "q"], () => {
        assert.deepEqual(client.reads, []);
        assert.deepEqual(store.mappings(), before);
      });
      await mapInteractively(store, localSeasons(store.history(), before), client, prompt);
      assert.deepEqual(client.reads, []);
      assert.equal(save.mock.callCount(), 0);
      assert.deepEqual(store.mappings(), before);
      assert.deepEqual(store.db.prepare("SELECT total_changes() AS count").get(), changes);
      assert.ok(
        output.includes(
          ["1,1", "2,1,2", "1,01"].includes(answer)
            ? "Choose each match only once."
            : "Choose listed numbers separated by commas, or an action.",
        ),
      );
      assert.doesNotMatch(output.join("\n"), /Save mapping\?|Mapping: SEASON|Saved SEASON/);
    });
  }
});

test("an unknown first total rejects after all media reads; reselecting it last succeeds", async (t) => {
  using store = new Store(":memory:");
  store.upsertHistory(Array.from({ length: 30 }, (_, index) => episode(101 + index * 2)));
  store.setMapping(mapping);
  const before = store.mappings();
  const save = t.mock.method(store, "setSeasonMappings");
  const client = clientFor([media(), media({ id: 43 })]);
  const readMedia = client.media;
  client.media = async (id) => ({ ...(await readMedia(id)), episodes: id === 42 ? null : 12 });
  let choices = 0;
  const { prompt, output } = scriptedPrompt(["1,2", "2,1", "y"], (question) => {
    assert.deepEqual(store.mappings(), before);
    assert.equal(save.mock.callCount(), 0);
    if (question.startsWith("Choose") && ++choices === 2) {
      assert.deepEqual(client.reads, [42, 43]);
      assert.ok(
        output.includes(
          "Invalid mapping: episode totals must be positive safe integers; only the last entry may have an unknown total.",
        ),
      );
      assert.doesNotMatch(output.join("\n"), /Save mapping\?|Mapping: SEASON/);
    }
    if (question.startsWith("Save mapping?")) {
      assert.deepEqual(client.reads, [42, 43, 43, 42]);
      assert.ok(output.includes("1. Test Anime (43): 12 viewed episode(s) / 12."));
      assert.ok(output.includes("2. Test Anime (42): 18 viewed episode(s) / unknown."));
    }
  });
  await mapInteractively(store, localSeasons(store.history(), before), client, prompt);
  assert.equal(save.mock.callCount(), 1);
  assert.deepEqual(store.mappings(), [
    { ...countMapping, mediaId: 43, to: 12 },
    { ...countMapping, from: 13, offset: 12 },
  ]);
  assert.equal(output.filter((line) => line.startsWith("Save mapping?")).length, 1);
  assert.doesNotMatch(output.join("\n"), /exceed the selected entries/);
});

test("cancelling a multi-match review preserves every prior mapping", async () => {
  for (const answers of [
    ["2,1", "n", ""],
    ["2,1", "k"],
    ["2,1", "q"],
    ["2,1", null],
  ]) {
    using store = new Store(":memory:");
    store.upsertHistory([episode()]);
    store.setSeasonMappings("SEASON", [media({ id: 10 }), media({ id: 11 }), media({ id: 12 })]);
    const before = store.mappings();
    const changes = store.db.prepare("SELECT total_changes() AS count").get();
    const client = clientFor([media(), media({ id: 43 })]);
    const { prompt, output } = scriptedPrompt(answers, () =>
      assert.deepEqual(store.mappings(), before),
    );
    await mapInteractively(store, localSeasons(store.history(), before), client, prompt);
    assert.deepEqual(client.reads, [43, 42]);
    assert.deepEqual(store.mappings(), before);
    assert.deepEqual(store.db.prepare("SELECT total_changes() AS count").get(), changes);
    assert.match(output.join("\n"), /0 mapping\(s\) saved/);
    assert.doesNotMatch(output.join("\n"), /Saved SEASON/);
  }
});

test("a later selected media fetch failure never previews or partially saves the selection", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  store.setMapping({ ...mapping, mediaId: 10, to: 12 });
  store.setMapping({ ...mapping, mediaId: 11, from: 13, offset: 12 });
  const before = store.mappings();
  const changes = store.db.prepare("SELECT total_changes() AS count").get();
  const client = clientFor([media(), media({ id: 43 }), media({ id: 44 })]);
  const readMedia = client.media;
  client.media = async (id) => {
    const result = await readMedia(id);
    assert.deepEqual(store.mappings(), before);
    if (id === 42) throw new Error("Selected media unavailable");
    return result;
  };
  const { prompt, output } = scriptedPrompt(["3,2,1"]);
  await assert.rejects(
    mapInteractively(store, localSeasons(store.history(), before), client, prompt),
    /Selected media unavailable/,
  );
  assert.deepEqual(client.reads, [44, 43, 42]);
  assert.deepEqual(store.mappings(), before);
  assert.deepEqual(store.db.prepare("SELECT total_changes() AS count").get(), changes);
  assert.doesNotMatch(output.join("\n"), /Save mapping\?|Mapping: SEASON|Saved SEASON/);
});

test("empty searches allow custom search and explicit ID entry", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  const client = clientFor([]);
  const { prompt, output } = scriptedPrompt(["s", "Alternate title", "i", "12x", "i", "123", "y"]);
  await mapInteractively(store, localSeasons(store.history(), []), client, prompt);
  assert.ok(client.searches.includes("Alternate title"));
  assert.deepEqual(client.reads, [123]);
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [{ ...countMapping, mediaId: 123 }],
  );
  assert.match(output.join("\n"), /No matches found/);
});

test("rejecting, skipping, quitting, and EOF never save an unconfirmed match", async () => {
  for (const answers of [
    [""],
    ["q"],
    [null],
    ["1", null],
    ["1", "n", ""],
    ["1", "k"],
    ["1", "q"],
    ["1", "invalid", "q"],
  ]) {
    using store = new Store(":memory:");
    store.upsertHistory([episode()]);
    const { prompt } = scriptedPrompt(answers);
    await mapInteractively(store, localSeasons(store.history(), []), clientFor(), prompt);
    assert.deepEqual(
      store.mappings().map((m) => ({ ...m })),
      [],
    );
  }
});

test("review previews watched counts despite gaps/high numbering, excluding partial episodes and duplicate dubs", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([
    episode(13),
    episode(24),
    episode(100),
    episode(13, { id: "DUB" }),
    episode(101, { fullyWatched: false, playhead: 100 }),
    episode(13.5),
  ]);
  const { prompt, output } = scriptedPrompt(["1", "y"]);
  await mapInteractively(store, localSeasons(store.history(), []), clientFor(), prompt);
  assert.deepEqual(store.mappings(), [countMapping]);
  const text = output.join("\n");
  assert.match(text, /Watched Crunchyroll episodes: 3/);
  assert.match(text, /3 watched Crunchyroll episode\(s\) → 3 viewed episode\(s\) on AniList/);
  assert.match(text, /Sync preserves higher AniList progress and protected list statuses/);
  assert.doesNotMatch(text, /range|offset|exceeds|capped|e edit/i);
});

test("review uses the configured watched threshold", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([
    episode(13, { fullyWatched: false, durationMs: 1_000_000, playhead: 800 }),
    episode(24, { fullyWatched: false, durationMs: 1_000_000, playhead: 799 }),
  ]);
  assert.equal(localSeasons(store.history(), [])[0]?.watchedCount, 0);
  const { prompt, output } = scriptedPrompt(["1", "y"]);
  await mapInteractively(store, localSeasons(store.history(), [], 0.8), clientFor(), prompt);
  assert.match(output.join("\n"), /1 watched Crunchyroll episode\(s\) → 1 viewed episode\(s\)/);
  assert.deepEqual(store.mappings(), [countMapping]);
});

test("a season with zero watched episodes can be previewed and mapped", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(13, { fullyWatched: false, playhead: 100 })]);
  const { prompt, output } = scriptedPrompt(["1", "y"]);
  await mapInteractively(store, localSeasons(store.history(), []), clientFor(), prompt);
  assert.match(output.join("\n"), /0 watched Crunchyroll episode\(s\) → 0 viewed episode\(s\)/);
  assert.deepEqual(store.mappings(), [countMapping]);
});

test("review caps counts at a known AniList total but leaves unknown totals uncapped", async () => {
  for (const total of [12, null]) {
    using store = new Store(":memory:");
    store.upsertHistory(Array.from({ length: 14 }, (_, index) => episode(101 + index * 2)));
    const { prompt, output } = scriptedPrompt(["1", "y"]);
    await mapInteractively(
      store,
      localSeasons(store.history(), []),
      clientFor([media({ episodes: total })]),
      prompt,
    );
    const text = output.join("\n");
    assert.ok(
      text.includes(`14 watched Crunchyroll episode(s) → ${total ?? 14} viewed episode(s)`),
    );
    if (total === null) assert.doesNotMatch(text, /capped/);
    else assert.match(text, /Count capped at AniList's 12 episodes/);
    assert.deepEqual(store.mappings(), [countMapping]);
  }
});

test("saving explicitly replaces all legacy mappings for the season only after confirmation", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(13), episode(24), episode(1, { id: "OTHER", seasonId: "OTHER" })]);
  const other = { ...mapping, seasonId: "OTHER", mediaId: 99 };
  store.setMapping(other);
  store.setMapping({ ...mapping, mediaId: 10, to: 12 });
  store.setMapping({ ...mapping, from: 13, to: 24, offset: 12 });
  const before = store.mappings();
  const { prompt, output } = scriptedPrompt(["1", "y"], (question) => {
    assert.deepEqual(store.mappings(), before);
    if (question.startsWith("Save mapping?")) {
      assert.match(output.join("\n"), /Saving replaces the existing mapping\(s\) for this season/);
    }
  });
  await mapInteractively(
    store,
    localSeasons(store.history(), before).filter((season) => season.id === "SEASON"),
    clientFor([media({ id: 43 })]),
    prompt,
  );
  assert.deepEqual(store.mappings(), [other, { ...countMapping, mediaId: 43 }]);
  assert.match(output.join("\n"), /Existing: AniList 10 \(legacy range mapping\)/);
  assert.match(output.join("\n"), /Existing: AniList 42 \(legacy range mapping\)/);
});

test("rejecting, skipping, quitting, or EOF during remapping preserves every legacy mapping", async () => {
  for (const answers of [
    ["1", "n", ""],
    ["1", "k"],
    ["1", "q"],
    ["1", null],
  ]) {
    using store = new Store(":memory:");
    store.upsertHistory([episode(13), episode(24)]);
    store.setMapping({ ...mapping, mediaId: 10, to: 12 });
    store.setMapping({ ...mapping, from: 13, to: 24, offset: 12 });
    const before = store.mappings();
    const { prompt, output } = scriptedPrompt(answers);
    await mapInteractively(store, localSeasons(store.history(), before), clientFor(), prompt);
    assert.deepEqual(store.mappings(), before);
    assert.match(output.join("\n"), /0 mapping\(s\) saved/);
  }
});

test("quitting a batch keeps previously saved mappings and leaves remaining seasons untouched", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([
    episode(),
    episode(1, { id: "OTHER", seasonId: "SECOND", seasonTitle: "ZZZ Anime" }),
  ]);
  const { prompt, output } = scriptedPrompt(["1", "y", "q"]);
  await mapInteractively(store, localSeasons(store.history(), []), clientFor(), prompt);
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [countMapping],
  );
  assert.match(output.join("\n"), /1 mapping\(s\) saved; 0 season\(s\) skipped; 1 remaining/);
});

test("search failures propagate without writing a mapping", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  const { prompt } = scriptedPrompt([]);
  await assert.rejects(
    mapInteractively(
      store,
      localSeasons(store.history(), []),
      {
        ...clientFor(),
        search: async () => {
          throw new Error("AniList unavailable");
        },
      },
      prompt,
    ),
    /AniList unavailable/,
  );
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [],
  );
});

test("terminal input closes cleanly on EOF and strips control sequences from displayed titles", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let displayed = "";
  output.on("data", (data) => {
    displayed += data.toString();
  });
  using prompt = new TerminalPrompt(input, output);
  prompt.write("\x1b[31mTitle\x1b[0m\nInjected line");
  const answer = prompt.read("Choose: ");
  input.write("  2  \n");
  assert.equal(await answer, "2");
  const pending = prompt.read("Save? ");
  input.end();
  assert.equal(await pending, null);
  assert.equal(await prompt.read("After close: "), null);
  assert.equal(displayed.trimEnd(), "Title Injected line\nChoose: Save?");
});
