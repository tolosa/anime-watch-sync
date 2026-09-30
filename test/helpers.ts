import type { Media } from "../src/anilist.ts";
import type { HistoryItem } from "../src/crunchyroll.ts";
import { normalizeEntry } from "../src/crunchyroll.ts";
import type { Fetch } from "../src/http.ts";

export function rawEpisode(n = 1, overrides: Record<string, unknown> = {}) {
  return {
    id: `EP${n}`,
    date_played: "2026-09-29T12:00:00Z",
    playhead: 1400,
    fully_watched: true,
    panel: {
      id: `EP${n}`,
      type: "episode",
      title: `Episode ${n}`,
      episode_metadata: {
        season_id: "SEASON",
        series_id: "SERIES",
        series_title: "Test Anime",
        season_title: "Test Anime Season 1",
        episode_number: n,
        duration_ms: 1_440_000,
      },
    },
    ...overrides,
  };
}

export function episode(n = 1, overrides: Partial<HistoryItem> = {}): HistoryItem {
  return { ...normalizeEntry(rawEpisode(n)), ...overrides };
}

export function media(overrides: Partial<Media> = {}): Media {
  return {
    id: 42,
    title: { english: "Test Anime", romaji: null },
    episodes: 12,
    format: "TV",
    mediaListEntry: null,
    ...overrides,
  };
}

export function mockFetch(
  fn: (url: string, init: RequestInit) => Response | Promise<Response>,
): Fetch {
  return (async (url, init) => fn(String(url), init ?? {})) as Fetch;
}

export const mapping = { seasonId: "SEASON", mediaId: 42, from: 1, to: null, offset: 0 };
