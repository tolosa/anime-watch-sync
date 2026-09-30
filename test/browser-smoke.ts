import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLoginBrowser } from "../src/login-browser.ts";

test("installed Chrome runs normally, exposes network responses, and removes its temporary profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watch-sync-browser-smoke-"));
  try {
    const received = Promise.withResolvers<{ webdriver: boolean }>();
    await using server = createServer(async (request, response) => {
      if (request.url === "/probe") {
        let body = "";
        for await (const chunk of request) body += chunk;
        received.resolve(JSON.parse(body));
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "test-session=synthetic; HttpOnly; Path=/",
        });
        response.end(JSON.stringify({ data: ["local-browser-smoke"] }));
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<!doctype html><title>Local login browser check</title><p>Checking the login browser. This window will close automatically.</p><script>fetch('/probe', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ webdriver: navigator.webdriver }) });</script>`,
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    {
      await using browser = await openLoginBrowser({
        sessionPath: join(directory, "cr-session.json"),
        channel: "chrome",
        signal: AbortSignal.timeout(15_000),
      });
      const response = Promise.withResolvers<unknown>();
      const tracked = new Set<string>();
      browser.connection.on("Network.responseReceived", ({ requestId, response }) => {
        if (response.url === `${origin}/probe`) tracked.add(requestId);
      });
      browser.connection.on("Network.loadingFinished", ({ requestId }) => {
        if (tracked.has(requestId))
          void browser.connection
            .send("Network.getResponseBody", { requestId })
            .then((data) => response.resolve(JSON.parse(data.body)), response.reject);
      });
      await browser.connection.send("Network.enable", {});
      await browser.connection.send("Page.navigate", { url: origin });
      const timer = setTimeout(() => {
        response.reject(new Error("Browser smoke test timed out"));
        received.reject(new Error("Browser smoke test timed out"));
      }, 10_000);
      try {
        const [fingerprint, body] = await Promise.all([received.promise, response.promise]);
        assert.equal(fingerprint.webdriver, false);
        assert.deepEqual(body, { data: ["local-browser-smoke"] });
        const { cookies } = await browser.connection.send("Network.getCookies", { urls: [origin] });
        assert.equal(cookies.find((cookie) => cookie.name === "test-session")?.value, "synthetic");
      } finally {
        clearTimeout(timer);
      }
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
