import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { z } from "zod";

export function loadEnvironment(path = ".env"): void {
  if (existsSync(path)) loadEnvFile(path);
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env or your environment. See README.md.`);
  return value;
}

export function token(name: string): string {
  return requiredEnv(name).replace(/^Bearer\s+/i, "");
}

export function threshold(): number {
  const value = z.coerce
    .number()
    .gt(0)
    .lte(1)
    .safeParse(process.env.WATCHED_THRESHOLD ?? "0.9");
  if (!value.success) throw new Error("WATCHED_THRESHOLD must be greater than 0 and at most 1.");
  return value.data;
}

export function crunchyrollSettings() {
  const baseUrl = process.env.CR_BASE_URL?.trim() || "https://www.crunchyroll.com";
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    !["www.crunchyroll.com", "beta-api.crunchyroll.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CR_BASE_URL must be https://www.crunchyroll.com or https://beta-api.crunchyroll.com.",
    );
  }
  return {
    baseUrl,
    profileId: process.env.CR_PROFILE_ID?.trim() || "default",
    locale: process.env.CR_LOCALE?.trim() || "en-US",
  };
}

export function crunchyrollConfig() {
  return {
    ...crunchyrollSettings(),
    accessToken: token("CR_ACCESS_TOKEN"),
    accountId: requiredEnv("CR_ACCOUNT_ID"),
  };
}
