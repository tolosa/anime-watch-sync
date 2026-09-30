import type { AniListClient, ListStatus, Media, WatchDate, WatchDates } from "./anilist.ts";
import { mediaTitle, sameDate } from "./anilist.ts";
import type { HistoryItem } from "./crunchyroll.ts";
import { isWatched } from "./crunchyroll.ts";
import type { Mapping, Store } from "./database.ts";

export interface ProgressGroup {
  mediaId: number;
  episodes: Set<number>;
  watchedAt?: Map<number, number>;
}

export function collectProgress(history: HistoryItem[], mappings: Mapping[], threshold: number) {
  const groups = new Map<number, ProgressGroup>();
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
    const mapping = mappings.find(
      (m) =>
        m.seasonId === item.seasonId &&
        episodeNumber >= m.from &&
        episodeNumber <= (m.to ?? Infinity),
    );
    if (!mapping) {
      unmapped++;
      continue;
    }
    const group: ProgressGroup = groups.get(mapping.mediaId) ?? {
      mediaId: mapping.mediaId,
      episodes: new Set<number>(),
      watchedAt: new Map<number, number>(),
    };
    const mappedEpisode = episodeNumber - mapping.offset;
    group.episodes.add(mappedEpisode);
    const timestamp = item.watchedAt === null ? NaN : Date.parse(item.watchedAt);
    if (Number.isFinite(timestamp)) {
      // Multiple language versions can represent the same episode. Keep the earliest viewing.
      const dates = group.watchedAt!;
      dates.set(mappedEpisode, Math.min(dates.get(mappedEpisode) ?? Infinity, timestamp));
    }
    groups.set(mapping.mediaId, group);
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
  if (media.episodes !== null && [...group.episodes].some((n) => n > media.episodes!)) {
    return {
      ...plan,
      reason: "Mapped episode exceeds AniList episode count; check the range/offset",
    };
  }
  if (current && ["COMPLETED", "REPEATING", "PAUSED", "DROPPED"].includes(current.status)) {
    return { ...plan, reason: `Preserving ${current.status.toLowerCase()} entry` };
  }
  // Advance only through consecutive watched episodes after current remote progress.
  // A high episode in an incomplete history must not mark the whole series watched.
  while (group.episodes.has(plan.progress + 1)) plan.progress++;
  if (plan.progress === previous) {
    if ([...group.episodes].some((n) => n > previous))
      plan.reason = `Missing watched episode ${previous + 1}; progress held`;
    return plan;
  }
  plan.status =
    media.episodes !== null && plan.progress === media.episodes ? "COMPLETED" : "CURRENT";
  plan.action = "update";
  plan.reason = "Consecutive watched episodes";
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
  if (media.episodes !== null && [...group.episodes].some((n) => n > media.episodes!)) return plan;
  const dates = group.watchedAt;
  if (!dates?.has(1)) return plan;

  const startedAt = watchDate(Math.min(...dates.values()));
  if (!sameDate(media.mediaListEntry?.startedAt, startedAt)) plan.dates.startedAt = startedAt;

  // A last-episode timestamp alone is insufficient: earlier episodes may have been
  // watched later, or may be absent from Crunchyroll's exposed history entirely.
  if (plan.status === "COMPLETED" && media.episodes !== null && dates.size === media.episodes) {
    const completedAt = watchDate(Math.max(...dates.values()));
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
