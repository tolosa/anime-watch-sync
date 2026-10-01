import type { AniListClient, ListStatus, Media, WatchDate, WatchDates } from "./anilist.ts";
import { mediaTitle, sameDate } from "./anilist.ts";
import type { HistoryItem } from "./crunchyroll.ts";
import { isWatched } from "./crunchyroll.ts";
import type { Mapping, Store } from "./database.ts";

export interface ProgressGroup {
  mediaId: number;
  episodes: Set<number>;
  watchedAt?: Map<number, number>;

  latestWatchedAt?: number;
}

export function collectProgress(history: HistoryItem[], mappings: Mapping[], threshold: number) {
  const groups = new Map<number, ProgressGroup>();

  const countMappings = new Map<string, Mapping[]>();
  for (const mapping of mappings) {
    if (mapping.mode !== "count") continue;
    const season = countMappings.get(mapping.seasonId) ?? [];
    season.push(mapping);
    countMappings.set(mapping.seasonId, season);
  }
  const countSeasons = new Map<string, Map<number, { earliest: number; latest: number }>>();
  const addEpisode = (mapping: Mapping, episode: number, earliest: number, latest: number) => {
    const group: ProgressGroup = groups.get(mapping.mediaId) ?? {
      mediaId: mapping.mediaId,
      episodes: new Set<number>(),
      watchedAt: new Map<number, number>(),
    };
    groups.set(mapping.mediaId, group);
    // Count offsets allocate watched ordinals; only legacy offsets translate
    // episode numbers. Keep source identities so separate arcs don't collapse.
    const mappedEpisode = mapping.mode === "count" ? episode : episode - mapping.offset;
    group.episodes.add(mappedEpisode);
    if (Number.isFinite(earliest)) {
      const dates = group.watchedAt!;
      dates.set(mappedEpisode, Math.min(dates.get(mappedEpisode) ?? Infinity, earliest));
    }
    if (Number.isFinite(latest)) {
      group.latestWatchedAt = Math.max(group.latestWatchedAt ?? -Infinity, latest);
    }
  };
  let unmapped = 0;
  let unnumbered = 0;
  for (const item of history) {
    if (!isWatched(item, threshold)) continue;
    if (
      !item.seasonId ||
      item.episodeNumber === null ||
      !Number.isSafeInteger(item.episodeNumber) ||
      item.episodeNumber < 1
    ) {
      unnumbered++;
      continue;
    }
    const episodeNumber = item.episodeNumber;
    const timestamp = item.watchedAt === null ? NaN : Date.parse(item.watchedAt);
    const hasCountMappings = countMappings.has(item.seasonId);
    if (hasCountMappings) {
      const season =
        countSeasons.get(item.seasonId) ?? new Map<number, { earliest: number; latest: number }>();
      const dates = season.get(episodeNumber) ?? { earliest: Infinity, latest: -Infinity };
      if (Number.isFinite(timestamp)) {
        dates.earliest = Math.min(dates.earliest, timestamp);
        dates.latest = Math.max(dates.latest, timestamp);
      }
      season.set(episodeNumber, dates);
      countSeasons.set(item.seasonId, season);
    }
    const mapping = mappings.find(
      (m) =>
        m.mode !== "count" &&
        m.seasonId === item.seasonId &&
        episodeNumber >= m.from &&
        episodeNumber <= (m.to ?? Infinity),
    );
    if (mapping) addEpisode(mapping, episodeNumber, timestamp, timestamp);
    else if (!hasCountMappings) unmapped++;
  }
  for (const [seasonId, season] of countSeasons) {
    // Ordinals select the target, but original episode numbers identify duplicates.
    [...season.keys()]
      .sort((a, b) => a - b)
      .forEach((episode, index) => {
        const ordinal = index + 1;
        const mapping = countMappings
          .get(seasonId)!
          .find((m) => ordinal >= m.from && ordinal <= (m.to ?? Infinity));
        if (!mapping) {
          unmapped++;
          return;
        }
        const dates = season.get(episode)!;
        addEpisode(mapping, episode, dates.earliest, dates.latest);
      });
  }

  return { groups: [...groups.values()], unmapped, unnumbered };
}

export interface SyncPlan {
  mediaId: number;
  title: string;
  previous: number;
  progress: number;
  status: ListStatus;
  action: "update" | "skip";
  reason: string;
  dates: WatchDates;
}

function planEpisodes(group: ProgressGroup, media: Media): SyncPlan {
  const current = media.mediaListEntry;
  const previous = current?.progress ?? 0;
  const plan: SyncPlan = {
    mediaId: media.id,
    title: mediaTitle(media),
    previous,
    progress: previous,
    status: current?.status ?? "CURRENT",
    action: "skip",
    reason: "Already up to date",
    dates: {},
  };

  if (current && ["COMPLETED", "REPEATING", "PAUSED", "DROPPED"].includes(current.status)) {
    return { ...plan, reason: `Preserving ${current.status.toLowerCase()} entry` };
  }
  plan.progress = Math.max(previous, Math.min(group.episodes.size, media.episodes ?? Infinity));
  if (plan.progress === previous) return plan;
  plan.status =
    media.episodes !== null && plan.progress === media.episodes ? "COMPLETED" : "CURRENT";
  plan.action = "update";
  plan.reason = "Watched episode count";
  return plan;
}

function watchDate(timestamp: number): WatchDate {
  const date = new Date(timestamp);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

export function formatWatchDates(dates: WatchDates): string {
  return (["startedAt", "completedAt"] as const)
    .flatMap((key) => {
      const date = dates[key];
      if (!date) return [];
      return [
        `${key === "startedAt" ? "start" : "finish"} ${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
      ];
    })
    .join(", ");
}

export function planProgress(group: ProgressGroup, media: Media): SyncPlan {
  const plan = planEpisodes(group, media);
  const dates = group.watchedAt;
  if (!dates?.size) return plan;

  const startedAt = watchDate(Math.min(...dates.values()));
  if (!sameDate(media.mediaListEntry?.startedAt, startedAt)) plan.dates.startedAt = startedAt;

  // A last-episode timestamp alone is insufficient: earlier episodes may have been
  // watched later, or may be absent from Crunchyroll's exposed history entirely.
  const completeDates =
    dates.size === group.episodes.size && group.episodes.size >= (media.episodes ?? Infinity);
  if (plan.status === "COMPLETED" && media.episodes !== null && completeDates) {
    const completedAt = watchDate(group.latestWatchedAt ?? Math.max(...dates.values()));
    if (!sameDate(media.mediaListEntry?.completedAt, completedAt))
      plan.dates.completedAt = completedAt;
  }
  if (Object.keys(plan.dates).length) {
    if (plan.action === "skip")
      plan.reason = "Watch dates from Crunchyroll; preserving progress/status";
    else plan.reason += "; watch dates from Crunchyroll";
    plan.action = "update";
  }
  return plan;
}

export async function syncAniList(
  store: Store,
  client: Pick<AniListClient, "viewer" | "media" | "save">,
  options: { dryRun: boolean; threshold: number; report?: (plan: SyncPlan) => void },
) {
  const collected = collectProgress(store.history(), store.mappings(), options.threshold);
  const viewer = await client.viewer();
  store.bindTarget(viewer.id, !options.dryRun);
  const plans: SyncPlan[] = [];
  for (const group of collected.groups) {
    const media = await client.media(group.mediaId);
    const plan = planProgress(group, media);
    if (plan.action === "update" && !options.dryRun) {
      const saved = await client.save(media, plan.progress, plan.status, plan.dates);
      store.recordSync(media.id, saved.progress, saved.status);
    }
    plans.push(plan);
    options.report?.(plan);
  }
  return { viewer, plans, unmapped: collected.unmapped, unnumbered: collected.unnumbered };
}
