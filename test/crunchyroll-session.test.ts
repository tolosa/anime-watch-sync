import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { sessionFromBrowserExchange } from "../src/browser-login.ts";
import { CrunchyrollClient } from "../src/crunchyroll.ts";
import {
  type CrunchyrollSession,
  renewSession,
  SessionFile,
  SessionManager,
} from "../src/crunchyroll-session.ts";
import { Store } from "../src/database.ts";
import { HttpError, JsonHttpClient } from "../src/http.ts";

const now = 1_790_000_000_000;
const session: CrunchyrollSession = {
  version: 1,
  kind: "etp_rt",
  credential: "private-cookie",
  basicAuthorization: "Basic d2ViOg==",
  deviceId: "device-123",
  deviceType: "Chrome",
  deviceName: "test browser",
  accountId: "account",
  profileId: "profile",
  accessToken: "private-access",
  expiresAt: now + 300_000,
  updatedAt: now,
};
const tokenResponse = {
  access_token: "new-access",
  refresh_token: "rotated-cookie",
  expires_in: 300,
  account_id: "account",
  profile_id: "profile",
};
async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "watch-sync-session-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: new SessionFile(join(directory, "cr-session.json")) };
}

test("sessions survive a new process/manager with owner-only atomic replacements", async (t) => {
  const { file, directory } = await temporary(t);
  assert.equal(await file.read(), null);
  await file.save(session);
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  assert.deepEqual(await new SessionFile(file.path).read(), session);
  await file.save({ ...session, credential: "updated-cookie" });
  assert.equal((await file.read())?.credential, "updated-cookie");
  assert.deepEqual(await readdir(directory), ["cr-session.json"]);
  await file.remove();
  await file.remove();
  assert.equal(await file.read(), null);
});

test("corrupt session data and symlinks fail without exposing credentials or changing targets", async (t) => {
  const { file, directory } = await temporary(t);
  await writeFile(file.path, '{"credential":"do-not-disclose"');
  await assert.rejects(
    file.read(),
    (error: Error) => /invalid/.test(error.message) && !error.message.includes("do-not-disclose"),
  );
  await file.save(session); // Explicit login can replace a corrupt regular file.
  const target = join(directory, "target");
  await writeFile(target, "keep this");
  await file.remove();
  await symlink(target, file.path);
  await assert.rejects(file.read(), /symlink/);
  await assert.rejects(file.save(session), /symlink/);
  assert.equal(await readFile(target, "utf8"), "keep this");
});

test("browser capture excludes passwords and anonymous tokens, preserves device/client identity", () => {
  const exchange = {
    headers: { authorization: session.basicAuthorization, "x-unrelated": "unused" },
    form: "grant_type=password&username=private-email&password=private-password&device_id=device-123&device_type=Chrome",
    response: tokenResponse,
    cookie: "browser-cookie",
    receivedAt: now,
  };
  const result = sessionFromBrowserExchange(exchange);
  assert.ok(result);
  assert.equal(result.credential, "browser-cookie");
  assert.equal(result.deviceId, "device-123");
  assert.equal(result.basicAuthorization, session.basicAuthorization);
  assert.equal(result.expiresAt, now + 300_000);
  assert.doesNotMatch(JSON.stringify(result), /private-password|private-email|unused/);
  assert.equal(
    sessionFromBrowserExchange({
      ...exchange,
      response: { access_token: "anonymous", expires_in: 300 },
    }),
    null,
  );
  assert.equal(sessionFromBrowserExchange({ ...exchange, form: "" }), null);
});

test("renewal sends the cookie grant with the original device and handles both rotation channels", async () => {
  let withCookie = true;
  const http = new JsonHttpClient("Crunchyroll", async (url, init) => {
    assert.equal(String(url), "https://www.crunchyroll.com/auth/v1/token");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), session.basicAuthorization);
    assert.equal(headers.get("cookie"), "etp_rt=private-cookie");
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("grant_type"), "etp_rt_cookie");
    assert.equal(form.get("device_id"), session.deviceId);
    assert.equal(form.get("device_type"), session.deviceType);
    assert.equal(form.get("scope"), "offline_access");
    assert.equal(form.has("password"), false);
    return Response.json(
      tokenResponse,
      withCookie
        ? { headers: { "set-cookie": "etp_rt=cookie-header-rotation; Secure; HttpOnly; Path=/" } }
        : {},
    );
  });
  assert.equal((await renewSession(session, http, () => now)).credential, "cookie-header-rotation");
  withCookie = false;
  const renewed = await renewSession(session, http, () => now);
  assert.equal(renewed.credential, tokenResponse.refresh_token);
  assert.equal(renewed.accessToken, tokenResponse.access_token);
});

test("cached tokens are reused; impending expiry and server rejection rotate and persist", async (t) => {
  const { file } = await temporary(t);
  await file.save(session);
  let calls = 0;
  let clock = now;
  const renew = async (old: CrunchyrollSession) => {
    calls++;
    assert.equal(old.credential, calls === 1 ? "private-cookie" : "rotated-1");
    return {
      ...old,
      accessToken: `access-${calls}`,
      credential: `rotated-${calls}`,
      expiresAt: clock + 300_000,
    };
  };
  const manager = new SessionManager(file, renew, () => clock);
  assert.equal(await manager.getAccessToken(), session.accessToken);
  assert.equal(calls, 0);
  clock += 240_001;
  assert.equal(await manager.getAccessToken(), "access-1");
  assert.equal((await file.read())?.credential, "rotated-1");
  const restarted = new SessionManager(file, renew, () => clock);
  assert.equal(await restarted.getAccessToken(), "access-1");
  assert.equal(calls, 1);
  assert.equal(await restarted.getAccessToken("access-1"), "access-2");
  // A rejection for an older token does not unnecessarily rotate the new one.
  assert.equal(await restarted.getAccessToken("access-1"), "access-2");
  assert.equal(calls, 2);
});

test("failed rotation keeps the saved session and does not retry uncertain mutations", async (t) => {
  const { file } = await temporary(t);
  const expired = { ...session, expiresAt: now - 1 };
  await file.save(expired);
  let calls = 0;
  const http = new JsonHttpClient("Crunchyroll", async () => {
    calls++;
    return new Response("private-service-body", { status: 500 });
  });
  const manager = new SessionManager(
    file,
    (old) => renewSession(old, http),
    () => now,
  );
  await assert.rejects(
    manager.getSession(),
    (error: Error) =>
      /HTTP 500/.test(error.message) && !error.message.includes("private-service-body"),
  );
  assert.equal(calls, 1);
  assert.deepEqual(await file.read(), expired);
  for (const status of [400, 401]) {
    const rejected = new JsonHttpClient(
      "Crunchyroll",
      async () => new Response("sensitive-details", { status }),
    );
    await assert.rejects(
      renewSession(session, rejected),
      (error: Error) =>
        /auth login/.test(error.message) && !error.message.includes("sensitive-details"),
    );
  }
});

test("renewal and session replacement cannot change the account/profile mid-import", async (t) => {
  const http = new JsonHttpClient("Crunchyroll", async () =>
    Response.json({ ...tokenResponse, profile_id: "other" }),
  );
  await assert.rejects(
    renewSession(session, http, () => now),
    /account\/profile changed/,
  );
  const { file } = await temporary(t);
  await file.save(session);
  const manager = new SessionManager(
    file,
    async () => {
      throw new Error("should not renew");
    },
    () => now,
  );
  await manager.getSession();
  await file.save({ ...session, accountId: "other" });
  await assert.rejects(manager.getSession(), /account\/profile changed/);
});

const config = {
  baseUrl: "https://www.crunchyroll.com",
  accountId: "account",
  locale: "en-US",
};
test("history retries the same page once on 401 and uses the renewed token", async () => {
  const urls: string[] = [];
  const tokens: string[] = [];
  const http = new JsonHttpClient("Crunchyroll", async (url, init) => {
    urls.push(String(url));
    tokens.push(new Headers(init?.headers).get("authorization")!);
    return tokens.length === 1 ? new Response(null, { status: 401 }) : Response.json({ data: [] });
  });
  const client = new CrunchyrollClient(
    config,
    {
      async getAccessToken(rejected) {
        return rejected === "old" ? "renewed" : "old";
      },
    },
    http,
  );
  for await (const _ of client.history()) assert.fail("empty history should not yield");
  assert.deepEqual(tokens, ["Bearer old", "Bearer renewed"]);
  assert.equal(urls[0], urls[1]);
});

test("history does not refresh on 403 and stops after a second 401", async () => {
  for (const status of [403, 401]) {
    let requests = 0;
    let renewals = 0;
    const http = new JsonHttpClient("Crunchyroll", async () => {
      requests++;
      return new Response(null, { status });
    });
    const client = new CrunchyrollClient(
      config,
      {
        async getAccessToken(rejected) {
          if (rejected) renewals++;
          return "token";
        },
      },
      http,
    );
    await assert.rejects(
      async () => {
        for await (const _ of client.history()) {
        }
      },
      (error: unknown) =>
        status === 403
          ? error instanceof HttpError && error.status === 403
          : error instanceof Error && /auth login/.test(error.message),
    );
    assert.equal(requests, status === 403 ? 1 : 2);
    assert.equal(renewals, status === 403 ? 0 : 1);
  }
});

test("database migration preserves existing labels while binding the authenticated profile", () => {
  using store = new Store(":memory:");
  store.bindSource("account", "default");
  store.bindAuthenticatedSource("account", "profile", "default");
  assert.throws(
    () => store.bindAuthenticatedSource("account", "wrong", "default"),
    /different Crunchyroll authenticated profile/,
  );
  assert.throws(
    () => store.bindAuthenticatedSource("wrong", "profile", "default"),
    /different Crunchyroll source/,
  );
});
