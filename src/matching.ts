import { z } from "zod";
import type { AniListClient, Media } from "./anilist.ts";
import type { HistoryItem } from "./crunchyroll.ts";
import type { Mapping } from "./database.ts";
import { clean } from "./terminal.ts";

export interface LocalSeason {
  id: string;
  title: string;
  crunchyrollUrl: string | null;
  queries: string[];
  episodes: number[];
  mappings: Mapping[];
}

const seriesMetadataSchema = z.object({
  panel: z.object({
    episode_metadata: z.object({
      series_id: z.string().regex(/^[a-z0-9_-]+$/i),
      series_slug_title: z.unknown().optional(),
    }),
  }),
});

function crunchyrollSeriesUrl(items: HistoryItem[]): string | null {
  for (const item of items) {
    let raw: unknown;
    try {
      raw = JSON.parse(item.raw);
    } catch {
      continue;
    }
    const parsed = seriesMetadataSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { series_id: id, series_slug_title: slug } = parsed.data.panel.episode_metadata;
    const suffix = typeof slug === "string" && /^[a-z0-9-]+$/i.test(slug) ? `/${slug}` : "";
    return `https://www.crunchyroll.com/series/${id}${suffix}`;
  }
  return null;
}

function searchTitle(title: string): string {
  // Remove language/version annotations, while preserving season and arc names.
  return clean(title)
    .replace(/\s*[([](?:[^()[\]]*\s)?(?:dub(?:bed)?|sub(?:bed)?)[)\]]/gi, "")
    .replace(
      /\s*[([](?:english|japanese|spanish|portuguese|french|german|italian|hindi|arabic|russian)(?:\s+dub)?[)\]]/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function localSeasons(history: HistoryItem[], mappings: Mapping[]): LocalSeason[] {
  return [
    ...Map.groupBy(
      history.filter((item) => item.seasonId),
      (item) => item.seasonId!,
    ),
  ]
    .map(([id, items]) => {
      const series = searchTitle(items.find((item) => item.seriesTitle.trim())?.seriesTitle ?? "");
      const season = searchTitle(items.find((item) => item.seasonTitle.trim())?.seasonTitle ?? "");
      const title =
        season || series || (id.startsWith("movie:") ? searchTitle(items[0]!.episodeTitle) : "");
      const primary =
        /^(?:season|s|part|cour)\s*\d+$/i.test(title) && series ? `${series} ${title}` : title;
      const queries = [
        ...new Map([primary, series].filter(Boolean).map((q) => [normalize(q), q])).values(),
      ];
      return {
        id,
        title: primary || id,
        crunchyrollUrl: crunchyrollSeriesUrl(items),
        queries,
        episodes: [
          ...new Set(
            items
              .map((item) => item.episodeNumber)
              .filter((n): n is number => n !== null && Number.isSafeInteger(n) && n > 0),
          ),
        ].sort((a, b) => a - b),
        mappings: mappings.filter((mapping) => mapping.seasonId === id),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function similarity(left: string, right: string): number {
  const a = new Set(normalize(left).split(" ").filter(Boolean));
  const b = new Set(normalize(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  return (2 * [...a].filter((token) => b.has(token)).length) / (a.size + b.size);
}

export async function matchingCandidates(
  client: Pick<AniListClient, "search">,
  queries: string[],
): Promise<Media[]> {
  const candidates = new Map<number, Media>();
  // Sequential requests use the client's existing rate-limit pacing.
  for (const query of queries) {
    for (const media of await client.search(query)) candidates.set(media.id, media);
  }
  const score = (media: Media) =>
    Math.max(
      ...[media.title.english, media.title.romaji]
        .filter((t): t is string => !!t)
        .map((title) => similarity(queries[0] ?? "", title)),
      0,
    );
  return [...candidates.values()].sort((a, b) => score(b) - score(a));
}
