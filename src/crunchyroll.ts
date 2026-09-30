import { z } from "zod";
import { createCrunchyrollHttpClient } from "./crunchyroll-http.ts";
import type { AccessTokenProvider } from "./crunchyroll-session.ts";
import { HttpError, type JsonHttpClient } from "./http.ts";

const object = z.record(z.string(), z.unknown());
const entrySchema = z
  .object({
    id: z.string().min(1),
    date_played: z.string().optional(),
    playhead: z.number().nonnegative().optional(),
    fully_watched: z.boolean().optional(),
    panel: object.nullish(),
  })
  .passthrough();
const pageSchema = z.object({
  data: z.array(entrySchema),
  total: z.number().int().nonnegative().optional(),
  meta: z.object({ next_page: z.string().nullish() }).passthrough().optional(),
});

export interface HistoryItem {
  id: string;
  seasonId: string | null;
  seriesTitle: string;
  seasonTitle: string;
  episodeTitle: string;
  episodeNumber: number | null;
  durationMs: number | null;
  playhead: number;
  fullyWatched: boolean;
  watchedAt: string | null;
  raw: string;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeEntry(input: unknown): HistoryItem {
  const entry = entrySchema.parse(input);
  const panel = entry.panel ?? {};
  const metadata = object.safeParse(panel.episode_metadata);
  const movie = object.safeParse(panel.movie_metadata);
  const isEpisode = panel.type === "episode" || metadata.success;
  const isMovie = panel.type === "movie" || movie.success;
  const details = metadata.success ? metadata.data : movie.success ? movie.data : panel;
  const date = entry.date_played ? Date.parse(entry.date_played) : NaN;
  return {
    id: entry.id,
    seasonId: isEpisode ? string(details.season_id) || null : isMovie ? `movie:${entry.id}` : null,
    seriesTitle: string(details.series_title) || string(details.movie_listing_title),
    seasonTitle: string(details.season_title) || (isMovie ? string(panel.title) : ""),
    episodeTitle: string(panel.title),
    // Don't round fractional specials or guess from sequence_number.
    episodeNumber: isMovie ? 1 : isEpisode ? number(details.episode_number) : null,
    durationMs: number(details.duration_ms) ?? number(panel.duration_ms),
    playhead: entry.playhead ?? 0,
    fullyWatched: entry.fully_watched ?? false,
    watchedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    raw: JSON.stringify(input),
  };
}

export function isWatched(
  item: Pick<HistoryItem, "fullyWatched" | "durationMs" | "playhead">,
  threshold: number,
): boolean {
  return (
    item.fullyWatched ||
    (item.durationMs !== null &&
      item.durationMs > 0 &&
      (item.playhead * 1000) / item.durationMs >= threshold)
  );
}

export interface CrunchyrollConfig {
  baseUrl: string;
  accountId: string;
  locale: string;
}

export class CrunchyrollClient {
  private readonly config: CrunchyrollConfig;
  private readonly http: JsonHttpClient;
  private readonly tokens: AccessTokenProvider;
  constructor(
    config: CrunchyrollConfig,
    tokens: AccessTokenProvider,
    http = createCrunchyrollHttpClient(),
  ) {
    this.config = config;
    this.http = http;
    this.tokens = tokens;
  }

  private async requestHistory(url: URL): Promise<unknown> {
    let accessToken = await this.tokens.getAccessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.http.request(url, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 401 || error.reason !== "http")
          throw error;
        if (attempt === 1)
          throw new Error(
            "Crunchyroll rejected the renewed access token. Run pnpm dev auth login to sign in again.",
          );
        accessToken = await this.tokens.getAccessToken(accessToken);
      }
    }
    throw new Error("Crunchyroll authentication retry limit reached.");
  }

  async *history(pageSize = 100): AsyncGenerator<HistoryItem[]> {
    const seen = new Set<string>();
    const seenPages = new Set<string>();
    let received = 0;
    let page = "1";
    for (let pageNumber = 1; pageNumber <= 10_000; pageNumber++) {
      if (seenPages.has(page))
        throw new Error("Crunchyroll repeated a pagination cursor; import stopped.");
      seenPages.add(page);
      const url = new URL(
        `/content/v2/${encodeURIComponent(this.config.accountId)}/watch-history`,
        this.config.baseUrl,
      );
      url.search = new URLSearchParams({
        page,
        page_size: String(pageSize),
        locale: this.config.locale,
      }).toString();
      const payload = await this.requestHistory(url);
      const parsed = pageSchema.safeParse(payload);
      if (!parsed.success)
        throw new Error(
          "Crunchyroll watch-history response has an unexpected shape; its internal API may have changed.",
        );
      const result = parsed.data;
      if (!result.data.length) return;
      const newItems = result.data.filter((item) => !seen.has(item.id));
      if (!newItems.length)
        throw new Error(
          "Crunchyroll repeated a history page; import stopped to avoid an infinite loop.",
        );
      for (const item of result.data) seen.add(item.id);
      received += result.data.length;
      yield result.data.map(normalizeEntry);
      // The page value can be an opaque cursor, not an incrementing integer.
      // Copy only that parameter; never follow the supplied URL with credentials.
      const next = result.meta?.next_page;
      if (typeof next === "string") {
        if (!next) return;
        let cursor: string | null;
        try {
          cursor = new URL(next, this.config.baseUrl).searchParams.get("page");
        } catch {
          throw new Error("Crunchyroll returned an invalid next_page URL.");
        }
        if (!cursor)
          throw new Error("Crunchyroll next_page is missing its page cursor; import stopped.");
        page = cursor;
        continue;
      }
      if (result.total !== undefined && received >= result.total) return;
      if (result.total === undefined && result.data.length < pageSize) return;
      page = String(pageNumber + 1);
    }
    throw new Error("Crunchyroll exceeded 10,000 history pages; import stopped.");
  }
}
