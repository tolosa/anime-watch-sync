import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { createCrunchyrollHttpClient } from "./crunchyroll-http.ts";
import { HttpError, type JsonHttpClient } from "./http.ts";

export const TOKEN_URL = "https://www.crunchyroll.com/auth/v1/token";
const cookieValue = z
  .string()
  .min(1)
  .regex(/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/);
const identifier = z.string().min(1).max(512);
export const sessionSchema = z.object({
  version: z.literal(1),
  kind: z.literal("etp_rt"),
  credential: cookieValue,
  basicAuthorization: z.string().regex(/^Basic [A-Za-z0-9+/]+=*$/),
  deviceId: identifier,
  deviceType: identifier.optional(),
  deviceName: identifier.optional(),
  accountId: identifier,
  profileId: identifier,
  accessToken: z
    .string()
    .min(1)
    .regex(/^[^\s\x00-\x1f\x7f]+$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  updatedAt: z.number().int().positive(),
});
export type CrunchyrollSession = z.infer<typeof sessionSchema>;
export const tokenResponseSchema = z.object({
  access_token: sessionSchema.shape.accessToken,
  refresh_token: cookieValue.optional(),
  expires_in: z.number().positive().finite(),
  account_id: identifier,
  profile_id: identifier,
});

const missingSession = () => new Error("No Crunchyroll session saved. Run pnpm dev auth login.");
const invalidSession = () =>
  new Error("The Crunchyroll session file is invalid. Run pnpm dev auth login to replace it.");
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Unencrypted credentials, restricted to the owner; replacements are atomic. */
export class SessionFile {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }

  async read(): Promise<CrunchyrollSession | null> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw new Error(
        "Cannot safely open the Crunchyroll session file. Check its permissions and ensure it is not a symlink.",
      );
    }
    try {
      if (!(await handle.stat()).isFile()) throw invalidSession();
      await handle.chmod(0o600);
      let data: unknown;
      try {
        data = JSON.parse(await handle.readFile("utf8"));
      } catch {
        throw invalidSession();
      }
      const parsed = sessionSchema.safeParse(data);
      if (!parsed.success) throw invalidSession();
      return parsed.data;
    } finally {
      await handle.close();
    }
  }

  async save(session: CrunchyrollSession): Promise<void> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) throw invalidSession();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const previous = await lstat(this.path).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    });
    if (previous && !previous.isFile())
      throw new Error("The session path must be a regular file, not a symlink or directory.");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/** Decode only an identity hint when migrating a database from manual token mode. */
export function tokenProfileId(token: string | undefined): string | undefined {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(token?.replace(/^Bearer\s+/i, "").split(".")[1] ?? "", "base64url").toString(
        "utf8",
      ),
    );
    const parsed = z.object({ profile_id: identifier }).safeParse(claims);
    return parsed.success ? parsed.data.profile_id : undefined;
  } catch {
    return undefined;
  }
}

function assertIdentity(
  session: CrunchyrollSession,
  expected: Pick<CrunchyrollSession, "accountId" | "profileId">,
): void {
  if (session.accountId !== expected.accountId || session.profileId !== expected.profileId) {
    throw new Error(
      "Crunchyroll account/profile changed. Import stopped; use a separate --db and --session-file for each profile.",
    );
  }
}

/** Cookie grants rotate independently from mobile/other OAuth refresh-token grants. */
export async function renewSession(
  session: CrunchyrollSession,
  http: JsonHttpClient = createCrunchyrollHttpClient(),
  now: () => number = Date.now,
): Promise<CrunchyrollSession> {
  const startedAt = now();
  const body = new URLSearchParams({
    grant_type: "etp_rt_cookie",
    scope: "offline_access",
    device_id: session.deviceId,
    ...(session.deviceType ? { device_type: session.deviceType } : {}),
    ...(session.deviceName ? { device_name: session.deviceName } : {}),
  });
  let response;
  try {
    response = await http.requestWithHeaders(
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          Authorization: session.basicAuthorization,
          Cookie: `etp_rt=${session.credential}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Origin: "https://www.crunchyroll.com",
          Referer: "https://www.crunchyroll.com/",
        },
        body: body.toString(),
      },
      false,
    ); // Never blindly replay a potentially successful credential rotation.
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.reason === "http" &&
      [400, 401].includes(error.status)
    ) {
      throw new Error(
        "Crunchyroll rejected the saved session. Run pnpm dev auth login to sign in again.",
      );
    }
    throw error;
  }
  const parsed = tokenResponseSchema.safeParse(response.data);
  if (!parsed.success)
    throw new Error(
      "Crunchyroll returned an unexpected login response. Its internal API may have changed; run pnpm dev auth login.",
    );
  const token = parsed.data;
  const rotatedCookies = response.headers
    .getSetCookie()
    .map((cookie) => /^etp_rt=([^;]*)/i.exec(cookie)?.[1])
    .filter((value) => value !== undefined);
  const credential = rotatedCookies.at(-1) ?? token.refresh_token ?? session.credential;
  const result = sessionSchema.safeParse({
    ...session,
    credential,
    accessToken: token.access_token,
    accountId: token.account_id,
    profileId: token.profile_id,
    expiresAt: Math.floor(startedAt + token.expires_in * 1000),
    updatedAt: now(),
  });
  if (!result.success)
    throw new Error("Crunchyroll returned invalid session credentials. Run pnpm dev auth login.");
  assertIdentity(result.data, session);
  if (result.data.expiresAt <= now())
    throw new Error("Crunchyroll returned an already expired session. Run pnpm dev auth login.");
  return result.data;
}

export interface AccessTokenProvider {
  getAccessToken(rejectedToken?: string): Promise<string>;
}

/** Renew before expiry and pin account/profile identity throughout an import. */
export class SessionManager implements AccessTokenProvider {
  private expected: Pick<CrunchyrollSession, "accountId" | "profileId"> | undefined;
  private readonly file: SessionFile;
  private readonly renew: (session: CrunchyrollSession) => Promise<CrunchyrollSession>;
  private readonly now: () => number;
  constructor(file: SessionFile, renew = renewSession, now = Date.now) {
    this.file = file;
    this.renew = renew;
    this.now = now;
  }

  async getSession(rejectedToken?: string): Promise<CrunchyrollSession> {
    const read = async () => {
      const session = await this.file.read();
      if (!session) throw missingSession();
      if (this.expected) assertIdentity(session, this.expected);
      else this.expected = { accountId: session.accountId, profileId: session.profileId };
      return session;
    };
    const fresh = (session: CrunchyrollSession) =>
      session.expiresAt > this.now() + 60_000 && session.accessToken !== rejectedToken;
    const current = await read();
    if (fresh(current)) return current;
    const renewed = await this.renew(current);
    assertIdentity(renewed, current);
    await this.file.save(renewed);
    return renewed;
  }

  async getAccessToken(rejectedToken?: string): Promise<string> {
    return (await this.getSession(rejectedToken)).accessToken;
  }
}
