#!/usr/bin/env node
import { resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { AniListClient, mediaTitle } from "./anilist.ts";
import { browserLogin } from "./browser-login.ts";
import { crunchyrollSettings, loadEnvironment, requiredEnv, threshold, token } from "./config.ts";
import { CrunchyrollClient, isWatched } from "./crunchyroll.ts";
import { renewSession, SessionFile, SessionManager } from "./crunchyroll-session.ts";
import { Store } from "./database.ts";
import { mapInteractively } from "./interactive-map.ts";
import { localSeasons } from "./matching.ts";
import { formatWatchDates, syncAniList } from "./sync.ts";
import { clean, TerminalPrompt } from "./terminal.ts";

loadEnvironment();

function integer(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("Expected an integer.");
  }
  return Number(value);
}

function positiveInteger(value: string): number {
  const result = integer(value);
  if (result < 1 || result > 2_147_483_647)
    throw new InvalidArgumentError("Expected a positive 32-bit integer.");
  return result;
}

const program = new Command()
  .name("anime-watch-sync")
  .description("Crunchyroll → local SQLite → AniList. Run pull, seasons, map, then sync.")
  .version("0.1.0")
  .option(
    "--db <path>",
    "SQLite database path",
    process.env.DATABASE_PATH || "./data/watch-history.sqlite",
  )
  .option(
    "--session-file <path>",
    "Local Crunchyroll session file",
    process.env.CR_SESSION_PATH || "./data/cr-session.json",
  );

function openStore(): Store {
  return new Store(program.opts<{ db: string }>().db);
}
function sessionFile(): SessionFile {
  return new SessionFile(program.opts<{ sessionFile: string }>().sessionFile);
}
function aniList(): AniListClient {
  return new AniListClient(token("ANILIST_ACCESS_TOKEN"));
}

async function pull(store: Store, pageSize = 100): Promise<void> {
  const manager = new SessionManager(sessionFile());
  const session = await manager.getSession();
  const config = { ...crunchyrollSettings(), accountId: session.accountId };
  store.bindAuthenticatedSource(session.accountId, session.profileId, config.profileId);
  const client = new CrunchyrollClient(config, manager);
  let fetched = 0;
  let page = 0;
  for await (const items of client.history(pageSize)) {
    store.upsertHistory(items);
    fetched += items.length;
    console.log(`Imported page ${++page}: ${items.length} records (${fetched} fetched).`);
  }
  console.log(
    `History saved to ${resolve(program.opts<{ db: string }>().db)} (${store.history().length} unique records).`,
  );
}

const auth = program
  .command("auth")
  .description("Sign in to Crunchyroll and manage the saved local session");
auth
  .command("login")
  .description("Open a browser to sign in once and save a renewable Crunchyroll session")
  .addOption(
    new Option("--browser <name>", "Installed browser to open")
      .choices(["chrome", "msedge"])
      .default("chrome"),
  )
  .option("--timeout <seconds>", "Time allowed for interactive login", positiveInteger, 300)
  .action(async (options: { browser: "chrome" | "msedge"; timeout: number }) => {
    if (options.timeout > 3600) throw new Error("--timeout must be at most 3600 seconds.");
    const file = sessionFile();
    console.log(
      "Sign in in the opened browser, select the intended profile, then open History. The window closes when the session has been captured.",
    );
    const captured = await browserLogin({
      sessionPath: file.path,
      channel: options.browser,
      timeoutMs: options.timeout * 1000,
    });
    console.log("Verifying automatic session renewal…");
    const session = await renewSession(captured);
    using store = openStore();
    store.bindAuthenticatedSource(
      session.accountId,
      session.profileId,
      crunchyrollSettings().profileId,
    );
    await file.save(session);
    console.log(
      `Crunchyroll session saved to ${clean(file.path)} (owner-only permissions). Run pnpm dev pull; access tokens renew automatically.`,
    );
  });

auth
  .command("status")
  .description("Show local session identity and access-token expiry without revealing credentials")
  .action(async () => {
    const file = sessionFile();
    const session = await file.read();
    if (!session) {
      console.log("No saved Crunchyroll session. Run pnpm dev auth login.");
      return;
    }
    console.log(`Session file: ${clean(file.path)}`);
    console.log(`Account: ${clean(session.accountId)}; profile: ${clean(session.profileId)}`);
    console.log(`Access token expires: ${new Date(session.expiresAt).toISOString()}`);
    console.log(
      session.expiresAt <= Date.now() + 60_000
        ? "Access token will renew on the next pull."
        : "Access token is cached; it renews automatically when needed.",
    );
    console.log("Status is local; the saved session is validated on use.");
  });

auth
  .command("logout")
  .description("Delete the local Crunchyroll session file")
  .action(async () => {
    await sessionFile().remove();
    console.log("Local Crunchyroll session removed.");
  });

program
  .command("pull")
  .description("Fetch all available Crunchyroll watch history and upsert it into SQLite")
  .option("--page-size <number>", "Records per request (1–100)", positiveInteger, 100)
  .action(async (options: { pageSize: number }) => {
    if (options.pageSize > 100) throw new Error("--page-size must be between 1 and 100.");
    using store = openStore();
    await pull(store, options.pageSize);
  });

program
  .command("seasons")
  .description("List local seasons/movie IDs, watched counts, and mappings")
  .action(() => {
    using store = openStore();
    const watchedThreshold = threshold();
    const mappings = store.mappings();
    const groups = Map.groupBy(store.history(), (item) => item.seasonId);
    const rows = [...groups].map(([id, items]) => ({
      season: id ?? "(missing metadata)",
      title: clean(
        items[0]?.seasonTitle || items[0]?.seriesTitle || items[0]?.episodeTitle || "Unknown",
      ),
      records: items.length,
      watched: new Set(
        items
          .filter((item) => isWatched(item, watchedThreshold))
          .map((item) => item.episodeNumber ?? item.id),
      ).size,
      episodes: [...new Set(items.map((item) => item.episodeNumber).filter((n) => n !== null))]
        .sort((a, b) => a - b)
        .join(", "),
      anilist:
        mappings
          .filter((m) => m.seasonId === id)
          .map((m) =>
            m.mode === "count"
              ? `${m.mediaId} [watched count ${m.from}–${m.to ?? "remaining"}]`
              : `${m.mediaId} [legacy ${m.from}–${m.to ?? "end"}, offset ${m.offset}]`,
          )
          .join("; ") || "unmapped",
    }));
    if (!rows.length) console.log("No local history. Run pull first.");
    else console.table(rows);
  });

program
  .command("history")
  .description("Inspect recently watched local records")
  .option("--limit <number>", "Maximum records", positiveInteger, 20)
  .action((options: { limit: number }) => {
    using store = openStore();
    const watchedThreshold = threshold();
    console.table(
      store
        .history()
        .sort((a, b) => (b.watchedAt ?? "").localeCompare(a.watchedAt ?? ""))
        .slice(0, options.limit)
        .map((item) => ({
          id: item.id,
          season: item.seasonId,
          title: clean(item.seriesTitle || item.seasonTitle),
          episode: item.episodeNumber,
          watched: isWatched(item, watchedThreshold),
          seconds: item.playhead,
          lastWatched: item.watchedAt,
        })),
    );
  });

program
  .command("search")
  .description("Search AniList for the correct anime/season ID")
  .argument("<title>", "Anime title (quote titles containing spaces)")
  .action(async (title: string) => {
    const media = await aniList().search(title);
    console.table(
      media.map((m) => ({
        id: m.id,
        title: clean(mediaTitle(m)),
        format: m.format,
        episodes: m.episodes ?? "unknown",
        url: `https://anilist.co/anime/${m.id}`,
      })),
    );
  });

program
  .command("map")
  .description("Interactively match unmapped seasons, one season, or map directly using both IDs")
  .argument("[season-id]", "Crunchyroll season ID (omit to review all unmapped seasons)")
  .argument(
    "[anilist-id]",
    "AniList anime ID (omit to search and choose interactively)",
    positiveInteger,
  )
  .action(async (seasonId: string | undefined, mediaId: number | undefined) => {
    using store = openStore();
    const seasons = localSeasons(store.history(), store.mappings(), threshold());
    if (seasonId && !seasons.some((season) => season.id === seasonId)) {
      throw new Error(
        "Unknown season ID. Run pull, then seasons, and copy a season ID from the results.",
      );
    }
    if (mediaId === undefined) {
      const pending = seasons.filter((season) =>
        seasonId ? season.id === seasonId : !season.mappings.length,
      );
      if (!pending.length) {
        console.log(
          seasons.length
            ? "All local seasons have mappings. Use map <season-id> to change a match or switch to watched-count syncing."
            : "No local seasons. Run pull first.",
        );
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "Interactive mapping requires a terminal. Use map <season-id> <anilist-id> for non-interactive mapping.",
        );
      }
      const client = aniList();
      using prompt = new TerminalPrompt();
      await mapInteractively(store, pending, client, prompt);
      return;
    }
    const media = await aniList().media(mediaId);
    store.setSeasonMapping(seasonId!, mediaId);
    const count = seasons.find((season) => season.id === seasonId)!.watchedCount;
    console.log(
      `Mapped ${clean(seasonId!)} → ${clean(mediaTitle(media))} (${mediaId}): ${count} watched Crunchyroll episode(s), ${Math.min(count, media.episodes ?? Infinity)} viewed episode(s) on AniList. Run sync to preview changes.`,
    );
  });

program
  .command("unmap")
  .description("Remove a season mapping from SQLite")
  .argument("<season-id>")
  .option(
    "--from <episode>",
    "Remove only a legacy mapping starting at this episode",
    positiveInteger,
  )
  .action((seasonId: string, options: { from?: number }) => {
    using store = openStore();
    console.log(`Removed ${store.removeMapping(seasonId, options.from)} mapping(s).`);
  });

program
  .command("auth-url")
  .description(
    "Print the AniList OAuth URL for your application (configure the PIN redirect first)",
  )
  .option("--client-id <id>", "AniList OAuth client ID")
  .action((options: { clientId?: string }) => {
    const id = positiveInteger(options.clientId ?? requiredEnv("ANILIST_CLIENT_ID"));
    const url = new URL("https://anilist.co/api/v2/oauth/authorize");
    url.search = new URLSearchParams({ client_id: String(id), response_type: "token" }).toString();
    console.log("Set your AniList application redirect URL to https://anilist.co/api/v2/oauth/pin");
    console.log(url.href);
    console.log(
      "After authorizing, save the displayed access token as ANILIST_ACCESS_TOKEN in .env.",
    );
  });

program
  .command("sync")
  .description("Preview AniList changes from local history; use --apply to write")
  .option("--pull", "Refresh local Crunchyroll history before syncing")
  .addOption(new Option("--apply", "Write progress/status changes to AniList").conflicts("dryRun"))
  .addOption(new Option("--dry-run", "Preview only (default)").conflicts("apply"))
  .action(async (options: { pull?: boolean; apply?: boolean; dryRun?: boolean }) => {
    const client = aniList();
    const watchedThreshold = threshold();
    using store = openStore();
    if (options.pull) await pull(store);
    const dryRun = !options.apply;
    console.log(
      dryRun
        ? "Preview only. Use sync --apply to write these changes."
        : "Syncing watch progress to AniList…",
    );
    const result = await syncAniList(store, client, {
      dryRun,
      threshold: watchedThreshold,
      report: (plan) =>
        console.log(
          `${plan.action === "update" ? (dryRun ? "WOULD UPDATE" : "UPDATED") : "SKIP"} ${clean(plan.title)} (${plan.mediaId}): ${plan.previous} → ${plan.progress}, ${plan.status}. ${plan.reason}${Object.keys(plan.dates).length ? `. Dates: ${formatWatchDates(plan.dates)}` : ""}`,
        ),
    });
    console.log(
      `${dryRun ? "Preview" : "Sync"} for ${clean(result.viewer.name)}: ${result.plans.filter((p) => p.action === "update").length} update(s); ${result.unmapped} watched record(s) unmapped; ${result.unnumbered} missing metadata or regular episode numbers.`,
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? clean(error.message) : "Unexpected failure"}`);
  process.exitCode = 1;
}
