import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Media } from "../src/anilist.ts";
import { Store } from "../src/database.ts";
import { mapInteractively } from "../src/interactive-map.ts";
import { localSeasons, matchingCandidates } from "../src/matching.ts";
import { type MappingPrompt, TerminalPrompt } from "../src/terminal.ts";
import { episode, mapping, media } from "./helpers.ts";

const defaults = { from: 1, offset: 0 };

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
  assert.deepEqual(seasons.find((s) => s.id === "SEASON")?.mappings, [mapping]);
  assert.equal(seasons.find((s) => s.id === "ARC")?.queries[0], "Test Anime (Final Arc)");
  assert.deepEqual(seasons.find((s) => s.id === "movie:MOVIE")?.queries, ["A Movie"]);
  assert.deepEqual(seasons.find((s) => s.id === "MISSING")?.queries, []);
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
  await mapInteractively(store, localSeasons(store.history(), []), client, defaults, prompt);
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [mapping],
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
  await mapInteractively(store, localSeasons(store.history(), []), client, defaults, prompt);
  assert.ok(client.searches.includes("Alternate title"));
  assert.deepEqual(client.reads, [123]);
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [{ ...mapping, mediaId: 123 }],
  );
  assert.match(output.join("\n"), /No matches found/);
});

test("rejecting, skipping, quitting, and EOF never save an unconfirmed match", async () => {
  for (const answers of [[""], ["q"], [null], ["1", null], ["1", "n", ""], ["1", "e", "q"]]) {
    using store = new Store(":memory:");
    store.upsertHistory([episode()]);
    const { prompt } = scriptedPrompt(answers);
    await mapInteractively(store, localSeasons(store.history(), []), clientFor(), defaults, prompt);
    assert.deepEqual(
      store.mappings().map((m) => ({ ...m })),
      [],
    );
  }
});

test("overflow requires correction; editing a split season preserves its existing first part", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(1), episode(13), episode(24)]);
  store.setMapping({ ...mapping, mediaId: 10, to: 12 });
  const { prompt, output } = scriptedPrompt(["1", "y", "e", "13", "24", "12", "y"]);
  await mapInteractively(
    store,
    localSeasons(store.history(), store.mappings()),
    clientFor(),
    { from: 13, offset: 0 },
    prompt,
  );
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [
      { ...mapping, mediaId: 10, to: 12 },
      { ...mapping, from: 13, to: 24, offset: 12 },
    ],
  );
  assert.match(output.join("\n"), /exceeds AniList's 12 episodes/);
});

test("overlap is shown before saving and replacement is made explicit", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode()]);
  store.setMapping({ ...mapping, from: 5, to: 12 });
  const { prompt, output } = scriptedPrompt(["1", "e", "-1", "1", "4", "", "y"]);
  await mapInteractively(
    store,
    localSeasons(store.history(), store.mappings()),
    clientFor(),
    defaults,
    prompt,
  );
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [
      { ...mapping, to: 4 },
      { ...mapping, from: 5, to: 12 },
    ],
  );
  assert.match(output.join("\n"), /overlaps/);
  const replacement = scriptedPrompt(["1", "y"]);
  await mapInteractively(
    store,
    localSeasons(store.history(), store.mappings()),
    clientFor([media({ id: 43 })]),
    { ...defaults, to: 4 },
    replacement.prompt,
  );
  assert.equal(store.mappings()[0]?.mediaId, 43);
  assert.match(replacement.output.join("\n"), /replaces the existing mapping/);
});

test("unknown totals and negative offsets are supported without guessing from partial history", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([episode(5)]);
  const { prompt, output } = scriptedPrompt(["1", "e", "", "end", "-12", "y"]);
  await mapInteractively(
    store,
    localSeasons(store.history(), []),
    clientFor([media({ episodes: null })]),
    defaults,
    prompt,
  );
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [{ ...mapping, offset: -12 }],
  );
  assert.match(output.join("\n"), /Crunchyroll episode 1 → AniList episode 1/);
});

test("quitting a batch keeps previously saved mappings and leaves remaining seasons untouched", async () => {
  using store = new Store(":memory:");
  store.upsertHistory([
    episode(),
    episode(1, { id: "OTHER", seasonId: "SECOND", seasonTitle: "ZZZ Anime" }),
  ]);
  const { prompt, output } = scriptedPrompt(["1", "y", "q"]);
  await mapInteractively(store, localSeasons(store.history(), []), clientFor(), defaults, prompt);
  assert.deepEqual(
    store.mappings().map((m) => ({ ...m })),
    [mapping],
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
      defaults,
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
