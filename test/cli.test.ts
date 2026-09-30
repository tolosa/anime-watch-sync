import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: "/private/tmp",
    env: {
      ...process.env,
      CR_ACCESS_TOKEN: "obsolete-env-token",
      CR_ACCOUNT_ID: "obsolete-env-account",
      CR_SESSION_PATH: "/private/tmp/nonexistent-watch-sync-test-session.json",
      ANILIST_ACCESS_TOKEN: "",
    },
  });
}

test("native TypeScript CLI renders help and an OAuth URL without credentials", () => {
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sync/);
  const auth = run("auth-url", "--client-id", "123");
  assert.equal(auth.status, 0, auth.stderr);
  assert.match(auth.stdout, /client_id=123&response_type=token/);
});

test("local commands work without tokens; remote commands fail with actionable errors", () => {
  const seasons = run("--db", ":memory:", "seasons");
  assert.equal(seasons.status, 0, seasons.stderr);
  assert.match(seasons.stdout, /No local history/);
  const pull = run("--db", ":memory:", "pull");
  assert.equal(pull.status, 1);
  assert.match(pull.stderr, /No Crunchyroll session saved.*auth login/);
  assert.doesNotMatch(pull.stderr, /obsolete-env-token|obsolete-env-account/);
});

test("rejects conflicting sync flags and invalid numeric arguments", () => {
  assert.equal(run("--db", ":memory:", "sync", "--apply", "--dry-run").status, 1);
  assert.equal(run("--db", ":memory:", "map", "SEASON", "12x").status, 1);
  assert.equal(run("--db", ":memory:", "pull", "--page-size", "101").status, 1);
});

test("auth status and logout operate locally without disclosing saved credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "watch-sync-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "cr-session.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      kind: "etp_rt",
      credential: "private-cookie",
      basicAuthorization: "Basic d2ViOg==",
      deviceId: "private-device",
      accountId: "test-account",
      profileId: "test-profile",
      accessToken: "private-token",
      expiresAt: Date.now() - 1,
      updatedAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  const status = run("--session-file", file, "auth", "status");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /test-account/);
  assert.match(status.stdout, /renew on the next pull/);
  assert.doesNotMatch(
    status.stdout + status.stderr,
    /private-cookie|private-token|private-device|d2ViOg/,
  );
  const logout = run("--session-file", file, "auth", "logout");
  assert.equal(logout.status, 0, logout.stderr);
  assert.doesNotMatch(logout.stdout, /fallback|CR_ACCESS_TOKEN|CR_ACCOUNT_ID/);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.match(
    run("--session-file", file, "auth", "status").stdout,
    /No saved Crunchyroll session/,
  );
});


test("obsolete credentials in .env cannot authenticate without a session file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "watch-sync-env-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  await writeFile(join(directory, ".env"), `CR_ACCESS_TOKEN=${expiredToken}\nCR_ACCOUNT_ID=obsolete-account\nANILIST_ACCESS_TOKEN=test-anilist-token\n`, { mode: 0o600 });
  const env = { ...process.env };
  delete env.CR_ACCESS_TOKEN;
  delete env.CR_ACCOUNT_ID;
  delete env.ANILIST_ACCESS_TOKEN;
  for (const command of [["pull"], ["sync", "--pull"]]) {
    const result = spawnSync(process.execPath, [cli, "--db", ":memory:", "--session-file", join(directory, "missing-session.json"), ...command], {
      cwd: directory, env, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No Crunchyroll session saved.*auth login/);
    assert.doesNotMatch(result.stderr, /obsolete-account|CR_ACCESS_TOKEN|CR_ACCOUNT_ID/);
    assert.ok(!result.stderr.includes(expiredToken));
  }
});
