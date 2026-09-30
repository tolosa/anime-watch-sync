import type { AniListClient, ListStatus, Media } from "./anilist.ts";
import { mediaTitle } from "./anilist.ts";
import type { HistoryItem } from "./crunchyroll.ts";
import { isWatched } from "./crunchyroll.ts";
import type { Mapping, Store } from "./database.ts";

export interface ProgressGroup {
  mediaId: number;
  episodes: Set<number>;
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
    const group = groups.get(mapping.mediaId) ?? {
      mediaId: mapping.mediaId,
      episodes: new Set<number>(),
    };
    group.episodes.add(episodeNumber - mapping.offset);
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
}

export function planProgress(group: ProgressGroup, media: Media): SyncPlan {
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
  };
  if (current && ["COMPLETED", "REPEATING", "PAUSED", "DROPPED"].includes(current.status)) {
    return { ...plan, reason: `Preserving ${current.status.toLowerCase()} entry` };
  }
  if (media.episodes !== null && [...group.episodes].some((n) => n > media.episodes!)) {
    return {
      ...plan,
      reason: "Mapped episode exceeds AniList episode count; check the range/offset",
    };
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
      const saved = await client.save(media, plan.progress, plan.status);
      store.recordSync(media.id, saved.progress, saved.status);
    }
    plans.push(plan);
    options.report?.(plan);
  }
  return { viewer, plans, unmapped: collected.unmapped, unnumbered: collected.unnumbered };
}
