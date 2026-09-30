import { Impit } from "impit";
import { JsonHttpClient } from "./http.ts";

/** Browser-compatible transport for Crunchyroll history and session renewal. */
export function createCrunchyrollHttpClient(): JsonHttpClient {
  const client = new Impit({
    browser: "chrome",
    timeout: 30_000,
    followRedirects: false,
    ignoreTlsErrors: false,
    vanillaFallback: false,
  });

  return new JsonHttpClient("Crunchyroll", (url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "POST")
      throw new Error("Unsupported Crunchyroll request method.");
    const body = init?.body;
    if (body != null && typeof body !== "string" && !(body instanceof URLSearchParams)) {
      throw new Error("Crunchyroll requests require a string or form body.");
    }
    return client.fetch(url, {
      method,
      headers: new Headers(init?.headers),
      redirect: "error",
      ...(body != null ? { body } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  });
}
