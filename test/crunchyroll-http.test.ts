import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createCrunchyrollHttpClient } from "../src/crunchyroll-http.ts";
import { HttpError } from "../src/http.ts";

test("impit sends authenticated GET requests and returns JSON through the shared client", async () => {
  const requests: {
    method: string | undefined;
    authorization: string | undefined;
    userAgent: string | undefined;
  }[] = [];
  await using server = createServer((request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      userAgent: request.headers["user-agent"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "EP1" }], total: 1 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createCrunchyrollHttpClient();
  const payload = await client.request(new URL(`http://127.0.0.1:${address.port}/history`), {
    headers: { Authorization: "Bearer test-token", Accept: "application/json" },
  });
  assert.deepEqual(payload, { data: [{ id: "EP1" }], total: 1 });
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.authorization, "Bearer test-token");
  assert.match(requests[0]?.userAgent ?? "", /Chrome\//);
});

test("impit rejects redirects without forwarding credentials and preserves challenge diagnostics", async () => {
  let redirectTargetRequests = 0;
  await using server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/target" });
      response.end();
    } else if (request.url === "/challenge") {
      response.writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" });
      response.end("<html>private-response-data</html>");
    } else {
      redirectTargetRequests++;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createCrunchyrollHttpClient();
  await assert.rejects(
    client.request(
      `${origin}/redirect`,
      {
        headers: { Authorization: "Bearer test-token" },
      },
      false,
    ),
    /network request failed/,
  );
  assert.equal(redirectTargetRequests, 0);
  await assert.rejects(
    client.request(`${origin}/challenge`),
    (error: unknown) =>
      error instanceof HttpError &&
      error.reason === "cloudflare-challenge" &&
      !error.message.includes("private-response-data"),
  );
});

test("impit preserves POST form data and exposes rotating response cookies", async () => {
  let method: string | undefined;
  let authorization: string | undefined;
  let cookie: string | undefined;
  let body = "";
  await using server = createServer(async (request, response) => {
    method = request.method;
    authorization = request.headers.authorization;
    cookie = request.headers.cookie;
    for await (const chunk of request) body += chunk;
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["other=unused; Path=/", "etp_rt=rotated; HttpOnly; Path=/"],
    });
    response.end(JSON.stringify({ access_token: "test-access", expires_in: 300 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createCrunchyrollHttpClient();
  const result = await client.requestWithHeaders(
    `http://127.0.0.1:${address.port}/token`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic d2ViOg==",
        Cookie: "etp_rt=previous",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=etp_rt_cookie&device_id=test",
    },
    false,
  );
  assert.equal(method, "POST");
  assert.equal(authorization, "Basic d2ViOg==");
  assert.equal(cookie, "etp_rt=previous");
  assert.equal(body, "grant_type=etp_rt_cookie&device_id=test");
  assert.deepEqual(result.headers.getSetCookie(), [
    "other=unused; Path=/",
    "etp_rt=rotated; HttpOnly; Path=/",
  ]);
});
