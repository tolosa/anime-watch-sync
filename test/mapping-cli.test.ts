import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Store } from "../src/database.ts";
import { episode, mapping, media } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const countMapping = { ...mapping, mode: "count" as const };

test("map CLI handles empty/mapped databases and rejects unattended interactive use", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anime-map-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, "history.sqlite");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "--db", db, "map", ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ANILIST_ACCESS_TOKEN: "", WATCHED_THRESHOLD: "0.9" },
    });
  const empty = run();
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No local seasons/);
  {
    using store = new Store(db);
    store.upsertHistory([episode()]);
  }
  const unattended = run();
  assert.equal(unattended.status, 1);
  assert.match(unattended.stderr, /requires a terminal.*map <season-id> <anilist-id>/);
  const unknown = run("UNKNOWN");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown season ID/);
  for (const flag of ["--from", "--to", "--offset"]) {
    for (const ids of [[], ["SEASON"], ["SEASON", "42"]]) {
      const removedOption = run(...ids, flag, "12");
      assert.equal(removedOption.status, 1);
      assert.ok(removedOption.stderr.includes(`unknown option '${flag}'`), removedOption.stderr);
    }
  }
  {
    using store = new Store(db);
    assert.deepEqual(store.mappings(), []);
  }
  {
    using store = new Store(db);
    store.setMapping(mapping);
  }
  const mapped = run();
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.match(mapped.stdout, /All local seasons have mappings/);
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\[season-id\] \[anilist-id\]/);
  assert.doesNotMatch(help.stdout, /--from|--to|--offset/);
});

test("real CLI previews configured watched counts and saves count mappings interactively and directly", {
  timeout: 15000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anime-map-interactive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, "history.sqlite");
  const loader = join(directory, "mock-anilist.mjs");
  await writeFile(
    loader,
    `
    if (process.env.MAP_TEST_TTY === "1") {
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
    }
    globalThis.fetch = async (url, init) => {
      if (String(url) !== "https://graphql.anilist.co") throw new Error("Unexpected URL");
      const { query, variables } = JSON.parse(init.body);
      const media = ${JSON.stringify(media())};
      if (query.includes("Page(")) {
        if (variables.search !== "Test Anime") throw new Error("Unexpected search");
        return Response.json({ data: { Page: { media: [media] } } });
      }
      if (query.includes("Media(id:")) return Response.json({ data: { Media: {
        ...media, id: variables.id, episodes: variables.id === 43 ? 2 : media.episodes,
      } } });
      throw new Error("Unexpected AniList operation; mapping must never mutate the list");
    };
  `,
  );
  {
    using store = new Store(db);
    store.upsertHistory([
      episode(13, { seasonTitle: "Test Anime" }),
      episode(13, { id: "DUB", seasonTitle: "Test Anime" }),
      episode(24, {
        seasonTitle: "Test Anime",
        fullyWatched: false,
        durationMs: 1_000_000,
        playhead: 800,
      }),
      episode(25, {
        seasonTitle: "Test Anime",
        fullyWatched: false,
        durationMs: 1_000_000,
        playhead: 799,
      }),
      episode(100, { seasonTitle: "Test Anime" }),
      episode(1, { id: "MAPPED", seasonId: "MAPPED", seasonTitle: "Already mapped" }),
    ]);
    store.setMapping({ ...mapping, seasonId: "MAPPED", mediaId: 10 });
  }
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", loader, cli, "--db", db, "map"], {
        cwd: directory,
        env: {
          ...process.env,
          ANILIST_ACCESS_TOKEN: "synthetic-test-token",
          MAP_TEST_TTY: "1",
          WATCHED_THRESHOLD: "0.8",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const steps = [
        { question: "Enter skip, q quit:", answer: "1\n" },
        { question: "Save mapping?", answer: "y\n" },
      ];
      let stdout = "";
      let stderr = "";
      let pending = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Prompt timed out: ${stdout}\n${stderr}`));
      }, 10000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        pending += stripVTControlCharacters(data.toString());
        const step = steps[0];
        if (step && pending.includes(step.question)) {
          steps.shift();
          pending = "";
          child.stdin.write(step.answer);
        }
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout: stripVTControlCharacters(stdout), stderr });
      });
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Matching 1 season/);
  assert.match(result.stdout, /1\. Test Anime \| TV \| 12 episodes/);
  assert.match(result.stdout, /1 mapping\(s\) saved/);
  assert.match(result.stdout, /3 watched Crunchyroll episode\(s\) → 3 viewed episode\(s\)/);
  assert.doesNotMatch(result.stdout, /range|offset/i);
  assert.doesNotMatch(result.stdout, /Already mapped/);
  {
    using store = new Store(db);
    assert.deepEqual(store.mappings(), [
      { ...mapping, seasonId: "MAPPED", mediaId: 10 },
      countMapping,
    ]);
    store.removeMapping("SEASON");
    store.setMapping({ ...mapping, mediaId: 20, to: 12 });
    store.setMapping({ ...mapping, from: 13, to: 24, offset: 12 });
  }
  const direct = spawnSync(
    process.execPath,
    ["--import", loader, cli, "--db", db, "map", "SEASON", "43"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        ANILIST_ACCESS_TOKEN: "synthetic-test-token",
        MAP_TEST_TTY: "0",
        WATCHED_THRESHOLD: "0.8",
      },
    },
  );
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /Mapped SEASON → Test Anime \(43\)/);
  assert.match(
    direct.stdout,
    /3 watched Crunchyroll episode\(s\), 2 viewed episode\(s\) on AniList/,
  );
  assert.match(direct.stdout, /Run sync to preview changes/);
  using store = new Store(db);
  assert.deepEqual(store.mappings(), [
    { ...mapping, seasonId: "MAPPED", mediaId: 10 },
    { ...countMapping, mediaId: 43 },
  ]);
});

test("unmap removes all season mappings by default and retains --from for legacy removal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anime-unmap-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, "history.sqlite");
  const first = { ...mapping, mediaId: 10, to: 12 };
  const second = { ...mapping, from: 13, to: 24, offset: 12 };
  const other = { ...mapping, seasonId: "OTHER", mediaId: 99 };
  {
    using store = new Store(db);
    store.upsertHistory([episode(), episode(1, { id: "OTHER", seasonId: "OTHER" })]);
    store.setMapping(first);
    store.setMapping(second);
    store.setMapping(other);
  }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "--db", db, "unmap", ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ANILIST_ACCESS_TOKEN: "" },
    });
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--from <episode>/);
  assert.match(help.stdout, /legacy mapping/);
  const legacy = run("SEASON", "--from", "13");
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /Removed 1 mapping\(s\)/);
  {
    using store = new Store(db);
    assert.deepEqual(store.mappings(), [other, first]);
    store.setMapping(second);
  }
  const all = run("SEASON");
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /Removed 2 mapping\(s\)/);
  {
    using store = new Store(db);
    assert.deepEqual(store.mappings(), [other]);
    store.setSeasonMapping("SEASON", 42);
  }
  const count = run("SEASON");
  assert.equal(count.status, 0, count.stderr);
  assert.match(count.stdout, /Removed 1 mapping\(s\)/);
  using store = new Store(db);
  assert.deepEqual(store.mappings(), [other]);
});
