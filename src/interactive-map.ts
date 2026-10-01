import { type AniListClient, type Media, mediaTitle } from "./anilist.ts";
import { buildSeasonMappings, type Mapping, type Store } from "./database.ts";
import { type LocalSeason, matchingCandidates } from "./matching.ts";
import type { MappingPrompt } from "./terminal.ts";

type Outcome = "saved" | "skipped" | "quit";

function showCandidates(prompt: MappingPrompt, candidates: Media[]): void {
  if (!candidates.length)
    prompt.write("No matches found. Search another title or enter an AniList ID.");
  candidates.forEach((media, index) => {
    const alternate =
      media.title.romaji && media.title.romaji !== mediaTitle(media)
        ? ` / ${media.title.romaji}`
        : "";
    prompt.write(
      `${index + 1}. ${mediaTitle(media)}${alternate} | ${media.format ?? "unknown format"} | ${media.episodes ?? "unknown"} episodes | ID ${media.id}`,
    );
    prompt.write(`   https://anilist.co/anime/${media.id}`);
  });
}

async function reviewMapping(
  store: Store,
  season: LocalSeason,
  selected: Media[],
  prompt: MappingPrompt,
): Promise<Outcome | "back"> {
  let mappings: Mapping[];
  try {
    mappings = buildSeasonMappings(season.id, selected);
  } catch (error) {
    prompt.write(error instanceof Error ? error.message : "Invalid selection.");
    return "back";
  }
  prompt.write(
    `Mapping: ${season.id} → ${selected.map((media) => `${mediaTitle(media)} (${media.id})`).join(" → ")}.`,
  );

  let allocated = 0;
  for (const [index, media] of selected.entries()) {
    const count = Math.min(
      Math.max(0, season.watchedCount - mappings[index]!.offset),
      media.episodes ?? Infinity,
    );
    allocated += count;
    if (selected.length === 1) {
      prompt.write(
        `${season.watchedCount} watched Crunchyroll episode(s) → ${count} viewed episode(s) on AniList.`,
      );
      if (count < season.watchedCount)
        prompt.write(`Count capped at AniList's ${media.episodes} episodes.`);
    } else {
      prompt.write(
        `${index + 1}. ${mediaTitle(media)} (${media.id}): ${count} viewed episode(s) / ${media.episodes ?? "unknown"}.`,
      );
    }
  }
  if (selected.length > 1) {
    prompt.write(
      `${season.watchedCount} watched Crunchyroll episode(s), allocated in the selected order.`,
    );
    if (allocated < season.watchedCount)
      prompt.write(
        `${season.watchedCount - allocated} episode(s) exceed the selected entries' totals and will not increase progress.`,
      );
  }
  prompt.write("Sync preserves higher AniList progress and protected list statuses.");
  if (season.mappings.length)
    prompt.write(
      "Saving replaces the existing mapping(s) for this season with watched-count syncing.",
    );
  for (;;) {
    const answer = await prompt.read("Save mapping? [Y/n], k skip, q quit: ");
    if (answer === null || answer.toLowerCase() === "q") return "quit";
    switch (answer.toLowerCase()) {
      case "n":
        return "back";
      case "k":
        return "skipped";
      case "":
      case "y":
      case "yes":
        store.setSeasonMappings(season.id, selected);
        prompt.write(
          `Saved ${season.id} → ${selected.map((media) => `${mediaTitle(media)} (${media.id})`).join(" → ")}.`,
        );
        return "saved";
      default:
        prompt.write("Choose one of the listed options.");
    }
  }
}

async function matchSeason(
  store: Store,
  season: LocalSeason,
  client: Pick<AniListClient, "search" | "media">,
  prompt: MappingPrompt,
): Promise<Outcome> {
  prompt.write(`Season: ${season.title} (${season.id})`);
  if (season.crunchyrollUrl) prompt.write(`Crunchyroll: ${season.crunchyrollUrl}`);
  prompt.write(`Watched Crunchyroll episodes: ${season.watchedCount}`);
  for (const mapping of season.mappings) {
    prompt.write(
      `Existing: AniList ${mapping.mediaId} (${mapping.mode === "count" ? "watched count" : "legacy range mapping"}).`,
    );
  }
  if (season.queries.length) prompt.write(`Searching AniList: ${season.queries.join(" / ")}…`);
  let candidates = await matchingCandidates(client, season.queries);
  for (;;) {
    showCandidates(prompt, candidates);
    const answer = await prompt.read(
      `${candidates.length ? `Choose 1–${candidates.length} (comma-separated for multiple, in watch order), ` : ""}s search, i enter ID, Enter skip, q quit: `,
    );
    if (answer === null || answer.toLowerCase() === "q") return "quit";
    if (!answer || answer.toLowerCase() === "k") return "skipped";
    if (answer.toLowerCase() === "s") {
      const query = await prompt.read("Search title (Enter keeps current matches): ");
      if (query === null) return "quit";
      if (query) {
        prompt.write(`Searching AniList: ${query}…`);
        candidates = await matchingCandidates(client, [query]);
      }
      continue;
    }
    let ids: number[] = [];
    if (answer.toLowerCase() === "i") {
      const input = await prompt.read("AniList anime ID (Enter goes back): ");
      if (input === null) return "quit";
      if (!input) continue;
      if (/^\d+$/.test(input) && Number(input) > 0 && Number(input) <= 2_147_483_647)
        ids = [Number(input)];
      else {
        prompt.write("Enter a positive AniList anime ID.");
        continue;
      }
    } else if (/^\d+(?:\s*,\s*\d+)*$/.test(answer.trim())) {
      const choices = answer.split(",").map((value) => candidates[Number(value.trim()) - 1]);
      if (choices.every((choice) => choice !== undefined))
        ids = choices.map((choice) => choice!.id);
    }
    if (!ids.length) {
      prompt.write("Choose listed numbers separated by commas, or an action.");
      continue;
    }
    if (new Set(ids).size !== ids.length) {
      prompt.write("Choose each match only once.");
      continue;
    }
    const selected: Media[] = [];
    for (const id of ids) selected.push(await client.media(id));
    const result = await reviewMapping(store, season, selected, prompt);
    if (result !== "back") return result;
  }
}

export async function mapInteractively(
  store: Store,
  seasons: LocalSeason[],
  client: Pick<AniListClient, "search" | "media">,
  prompt: MappingPrompt,
): Promise<void> {
  let saved = 0;
  let skipped = 0;
  prompt.write(
    `Matching ${seasons.length} season(s). Select one or more matches in watch order and review the watched episode allocation before saving. Saved mappings are kept if you quit.`,
  );
  for (const [index, season] of seasons.entries()) {
    prompt.write(`[${index + 1}/${seasons.length}]`);
    const outcome = await matchSeason(store, season, client, prompt);
    if (outcome === "quit") {
      prompt.write("Mapping stopped.");
      break;
    }
    if (outcome === "saved") saved++;
    else skipped++;
  }
  prompt.write(
    `${saved} mapping(s) saved; ${skipped} season(s) skipped; ${seasons.length - saved - skipped} remaining. Run sync to preview AniList changes.`,
  );
}
