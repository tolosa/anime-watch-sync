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

test("map CLI handles empty/mapped databases and rejects unattended interactive use", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "anime-map-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, "history.sqlite");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "--db", db, "map", ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ANILIST_ACCESS_TOKEN: "" },
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
  const batchRange = run("--offset", "12");
  assert.equal(batchRange.status, 1);
  assert.match(batchRange.stderr, /Specify a season ID/);
  {
    using store = new Store(db);
    store.setMapping(mapping);
  }
  const mapped = run();
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.match(mapped.stdout, /All local seasons have mappings/);
  const help = run("--help");
  assert.match(help.stdout, /\[season-id\] \[anilist-id\]/);
});

test("real CLI prompts search and save an unmapped season; both-ID mapping still works", {
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
      if (query.includes("Media(id:")) return Response.json({ data: { Media: { ...media, id: variables.id } } });
      throw new Error("Unexpected AniList operation; mapping must never mutate the list");
    };
  `,
  );
  {
    using store = new Store(db);
    store.upsertHistory([
      episode(1, { seasonTitle: "Test Anime" }),
      episode(1, { id: "MAPPED", seasonId: "MAPPED", seasonTitle: "Already mapped" }),
    ]);
    store.setMapping({ ...mapping, seasonId: "MAPPED", mediaId: 10 });
  }
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", loader, cli, "--db", db, "map"], {
        cwd: directory,
        env: { ...process.env, ANILIST_ACCESS_TOKEN: "synthetic-test-token", MAP_TEST_TTY: "1" },
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
  assert.doesNotMatch(result.stdout, /Already mapped/);
  {
    using store = new Store(db);
    assert.equal(store.mappings().find((m) => m.seasonId === "SEASON")?.mediaId, 42);
  }
  const direct = spawnSync(
    process.execPath,
    ["--import", loader, cli, "--db", db, "map", "SEASON", "43", "--from", "1", "--to", "12"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ANILIST_ACCESS_TOKEN: "synthetic-test-token", MAP_TEST_TTY: "0" },
    },
  );
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /Mapped SEASON \[1–12\].*\(43\)/);
  using store = new Store(db);
  assert.equal(store.mappings().find((m) => m.seasonId === "SEASON")?.mediaId, 43);
});
