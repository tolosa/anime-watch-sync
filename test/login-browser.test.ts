import assert from "node:assert/strict";
import { test } from "node:test";
import { loginBrowserArguments } from "../src/login-browser.ts";

test("interactive login keeps normal browser behavior and confines debugging to a separate profile on loopback", () => {
  const args = loginBrowserArguments("/tmp/app profile", 54321);
  assert.ok(args.includes("--user-data-dir=/tmp/app profile"));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--remote-debugging-port=54321"));
  assert.ok(args.includes("about:blank")); // Observe network before navigation starts.
  assert.doesNotMatch(
    args.join(" "),
    /--enable-automation|--headless|--disable-blink-features|--no-sandbox|--disable-web-security|--ignore-certificate-errors|--user-agent|--remote-allow-origins/,
  );
});

test("the launcher rejects debugging port zero, which Chrome treats as automation", () => {
  for (const port of [0, -1, 65536, 1.5])
    assert.throws(
      () => loginBrowserArguments("/tmp/profile", port),
      /nonzero local debugging port/,
    );
});
