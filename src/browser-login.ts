import type { Protocol } from "devtools-protocol";
import {
  type CrunchyrollSession,
  sessionSchema,
  TOKEN_URL,
  tokenResponseSchema,
} from "./crunchyroll-session.ts";
import { openLoginBrowser } from "./login-browser.ts";

export interface BrowserExchange {
  headers: Record<string, string>;
  form: string;
  response: unknown;
  cookie?: string;
  deviceCookie?: string;
  receivedAt: number;
}

/** Keep only renewable session data, never passwords, full headers, or other cookies. */
export function sessionFromBrowserExchange(exchange: BrowserExchange): CrunchyrollSession | null {
  const token = tokenResponseSchema.safeParse(exchange.response);
  if (!token.success) return null; // Anonymous tokens have no account/profile.
  const form = new URLSearchParams(exchange.form);
  const deviceType = form.get("device_type");
  const deviceName = form.get("device_name");
  const parsed = sessionSchema.safeParse({
    version: 1,
    kind: "etp_rt",
    credential: exchange.cookie ?? token.data.refresh_token,
    basicAuthorization: exchange.headers.authorization,
    deviceId: form.get("device_id") || exchange.deviceCookie,
    ...(deviceType ? { deviceType } : {}),
    ...(deviceName ? { deviceName } : {}),
    accountId: token.data.account_id,
    profileId: token.data.profile_id,
    accessToken: token.data.access_token,
    expiresAt: Math.floor(exchange.receivedAt + token.data.expires_in * 1000),
    updatedAt: exchange.receivedAt,
  });
  return parsed.success ? parsed.data : null;
}

export async function browserLogin(options: {
  sessionPath: string;
  channel: "chrome" | "msedge";
  timeoutMs: number;
}): Promise<CrunchyrollSession> {
  const stop = new AbortController();
  const interrupt = () =>
    stop.abort(new Error("Crunchyroll login cancelled. The previous saved session was kept."));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, interrupt);
  let sawChallenge = false;
  const timer = setTimeout(
    () =>
      stop.abort(
        new Error(
          sawChallenge
            ? "Cloudflare verification did not complete. Try signing in with your regular browser on the same network to check whether the challenge also fails there. No session was saved."
            : "Crunchyroll login timed out. Run auth login again, sign in, select your profile, and open History in the login tab.",
        ),
      ),
    options.timeoutMs,
  );
  try {
    await using browser = await openLoginBrowser({ ...options, signal: stop.signal });
    const connection = browser.connection;
    const completion = Promise.withResolvers<CrunchyrollSession>();
    void completion.promise.catch(() => {});
    stop.signal.addEventListener("abort", () => completion.reject(stop.signal.reason), {
      once: true,
    });
    connection.onClose(() =>
      completion.reject(
        new Error("The login browser was closed. The previous saved session was kept."),
      ),
    );

    const requests = new Map<
      string,
      {
        url: URL;
        authorization: string;
        form: string;
        receivedAt: number;
        status?: number;
      }
    >();
    const candidates = new Map<string, CrunchyrollSession>();
    const histories = new Map<string, string>();
    let chain = Promise.resolve();
    const authorization = (headers: Protocol.Network.Headers) =>
      Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
    const historyAccount = (url: URL) => {
      if (
        url.protocol !== "https:" ||
        !["www.crunchyroll.com", "beta-api.crunchyroll.com"].includes(url.hostname)
      )
        return undefined;
      const match = /^\/content\/v2\/([^/]+)\/watch-history$/.exec(url.pathname);
      return match ? decodeURIComponent(match[1]!) : undefined;
    };
    const accept = () => {
      for (const [token, session] of candidates) {
        if (histories.get(token) === session.accountId) completion.resolve(session);
      }
    };
    connection.on("Network.requestWillBeSent", ({ requestId, request }) => {
      const url = new URL(request.url);
      if (url.href !== TOKEN_URL && !historyAccount(url)) return;
      // Do not retain usernames, passwords, unrelated request headers, or query strings.
      const form = new URLSearchParams(request.postData ?? "");
      const device = new URLSearchParams();
      for (const key of ["device_id", "device_type", "device_name"]) {
        const value = form.get(key);
        if (value) device.set(key, value);
      }
      requests.set(requestId, {
        url,
        authorization: authorization(request.headers),
        form: device.toString(),
        receivedAt: Date.now(),
      });
      if (requests.size > 100) requests.delete(requests.keys().next().value!);
    });
    connection.on("Network.requestWillBeSentExtraInfo", ({ requestId, headers }) => {
      const request = requests.get(requestId);
      const auth = authorization(headers);
      if (request && auth) request.authorization = auth;
    });
    connection.on("Network.responseReceived", ({ requestId, response }) => {
      const request = requests.get(requestId);
      if (request) request.status = response.status;
      if (
        Object.entries(response.headers).some(
          ([key, value]) => key.toLowerCase() === "cf-mitigated" && value === "challenge",
        )
      )
        sawChallenge = true;
    });
    connection.on("Network.loadingFailed", ({ requestId }) => {
      requests.delete(requestId);
    });
    connection.on("Network.loadingFinished", ({ requestId }) => {
      if (!requests.has(requestId)) return;
      chain = chain
        .then(async () => {
          const request = requests.get(requestId);
          requests.delete(requestId);
          if (!request || !request.status || request.status < 200 || request.status >= 300) return;
          const response = await connection.send("Network.getResponseBody", { requestId });
          let body: unknown;
          try {
            body = JSON.parse(
              response.base64Encoded
                ? Buffer.from(response.body, "base64").toString("utf8")
                : response.body,
            );
          } catch {
            return;
          }
          if (request.url.href === TOKEN_URL) {
            const { cookies } = await connection.send("Network.getCookies", { urls: [TOKEN_URL] });
            const cookie = cookies.find((item) => item.name === "etp_rt")?.value;
            const deviceCookie = cookies.find((item) => item.name === "device_id")?.value;
            const session = sessionFromBrowserExchange({
              headers: { authorization: request.authorization },
              form: request.form,
              response: body,
              ...(cookie ? { cookie } : {}),
              ...(deviceCookie ? { deviceCookie } : {}),
              receivedAt: request.receivedAt,
            });
            if (session) {
              candidates.set(session.accessToken, session);
              if (candidates.size > 10) candidates.delete(candidates.keys().next().value!);
            }
          } else {
            const account = historyAccount(request.url);
            if (
              account &&
              body &&
              typeof body === "object" &&
              "data" in body &&
              Array.isArray(body.data)
            ) {
              histories.set(request.authorization.replace(/^Bearer\s+/i, ""), account);
              if (histories.size > 10) histories.delete(histories.keys().next().value!);
            }
          }
          accept();
        })
        .catch(() =>
          completion.reject(
            new Error(
              "Could not capture the Crunchyroll session from the login browser. Run auth login again and use the same tab for sign-in and History.",
            ),
          ),
        );
    });
    // Network observation only. Leave browser JavaScript, fingerprint, and user input alone.
    await connection.send("Network.enable", { maxPostDataSize: 65_536 });
    await connection.send("Page.navigate", { url: "https://www.crunchyroll.com/history" });
    if (stop.signal.aborted) throw stop.signal.reason;
    return await completion.promise;
  } catch (error) {
    if (stop.signal.aborted) throw stop.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.removeListener(signal, interrupt);
  }
}
