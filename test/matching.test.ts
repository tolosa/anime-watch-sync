import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Media } from "../src/anilist.ts";
import { Store } from "../src/database.ts";
import { mapInteractively } from "../src/interactive-map.ts";
import { localSeasons, matchingCandidates } from "../src/matching.ts";
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
