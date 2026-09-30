import { type AniListClient, type Media, mediaTitle } from "./anilist.ts";
import type { Mapping, Store } from "./database.ts";
import { type LocalSeason, matchingCandidates } from "./matching.ts";
import type { MappingPrompt } from "./terminal.ts";

export interface MappingOptions {
  from: number;
  to?: number;
  offset: number;
}

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

async function readNumber(
  prompt: MappingPrompt,
  label: string,
  current: number | null,
  kind: "positive" | "end" | "offset",
): Promise<number | null | "quit"> {
  for (;;) {
    const answer = await prompt.read(
      `${label} [${current ?? "end"}]${kind === "end" ? " (or end)" : ""}, q quit: `,
    );
    if (answer === null || answer.toLowerCase() === "q") return "quit";
    if (!answer) return current;
    if (kind === "end" && answer.toLowerCase() === "end") return null;
    const number = Number(answer);
    if (
      /^-?\d+$/.test(answer) &&
      Number.isSafeInteger(number) &&
      (kind === "offset" || (number > 0 && number <= 2_147_483_647))
    )
      return number;
    prompt.write(
      kind === "offset" ? "Enter an integer offset." : "Enter a positive 32-bit integer.",
    );
  }
}

async function editRange(prompt: MappingPrompt, mapping: Mapping): Promise<Mapping | null> {
  const from = await readNumber(prompt, "First Crunchyroll episode", mapping.from, "positive");
  if (from === "quit") return null;
  const to = await readNumber(prompt, "Last Crunchyroll episode", mapping.to, "end");
  if (to === "quit") return null;
  const offset = await readNumber(
    prompt,
    "Offset (AniList episode = Crunchyroll episode minus offset)",
    mapping.offset,
    "offset",
  );
  if (offset === "quit") return null;
  return { ...mapping, from: from!, to, offset: offset! };
}

function mappingProblem(
  store: Store,
  season: LocalSeason,
  mapping: Mapping,
  media: Media,
): string | null {
  try {
    store.validateMapping(mapping);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid mapping.";
  }
  const covered = season.episodes.filter(
    (episode) => episode >= mapping.from && episode <= (mapping.to ?? Infinity),
  );
  if (
    media.episodes !== null &&
    [mapping.from, mapping.to ?? mapping.from, ...covered].some(
      (episode) => episode - mapping.offset > media.episodes!,
    )
  ) {
    return `This range exceeds AniList's ${media.episodes} episodes. Edit the range/offset for this season or choose another match.`;
  }
  return null;
}

async function reviewMapping(
  store: Store,
  season: LocalSeason,
  media: Media,
  options: MappingOptions,
  prompt: MappingPrompt,
): Promise<Outcome | "back"> {
  let mapping: Mapping = {
    seasonId: season.id,
    mediaId: media.id,
    from: options.from,
    to: options.to ?? null,
    offset: options.offset,
  };
  for (;;) {
    prompt.write(
      `Mapping: ${season.id} [${mapping.from}–${mapping.to ?? "end"}] → ${mediaTitle(media)} (${media.id}), offset ${mapping.offset}.`,
    );
    prompt.write(
      `Crunchyroll episode ${mapping.from} → AniList episode ${mapping.from - mapping.offset}.`,
    );
    if (store.mappings().some((m) => m.seasonId === season.id && m.from === mapping.from)) {
      prompt.write(`Saving replaces the existing mapping starting at episode ${mapping.from}.`);
    }
    const problem = mappingProblem(store, season, mapping, media);
    if (problem) prompt.write(problem);
    const answer = await prompt.read(
      problem
        ? "e edit range/offset, n back to matches, k skip, q quit: "
        : "Save mapping? [Y/n], e edit range/offset, k skip, q quit: ",
    );
    if (answer === null || answer.toLowerCase() === "q") return "quit";
    switch (answer.toLowerCase()) {
      case "e": {
        const edited = await editRange(prompt, mapping);
        if (!edited) return "quit";
        mapping = edited;
        break;
      }
      case "n":
        return "back";
      case "k":
        return "skipped";
      case "":
      case "y":
      case "yes":
        if (problem) break;
        store.setMapping(mapping);
        prompt.write(`Saved ${season.id} → ${mediaTitle(media)} (${media.id}).`);
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
  options: MappingOptions,
  prompt: MappingPrompt,
): Promise<Outcome> {
  prompt.write(`Season: ${season.title} (${season.id})`);
  if (season.crunchyrollUrl) prompt.write(`Crunchyroll: ${season.crunchyrollUrl}`);
  prompt.write(`Local episode numbers: ${season.episodes.join(", ") || "unknown"}`);
  for (const mapping of season.mappings) {
    prompt.write(
      `Existing: AniList ${mapping.mediaId} [${mapping.from}–${mapping.to ?? "end"}], offset ${mapping.offset}.`,
    );
  }
  if (season.queries.length) prompt.write(`Searching AniList: ${season.queries.join(" / ")}…`);
  let candidates = await matchingCandidates(client, season.queries);
  for (;;) {
    showCandidates(prompt, candidates);
    const answer = await prompt.read(
      `${candidates.length ? `Choose 1–${candidates.length}, ` : ""}s search, i enter ID, Enter skip, q quit: `,
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
    let id: number | undefined;
    if (answer.toLowerCase() === "i") {
      const input = await prompt.read("AniList anime ID (Enter goes back): ");
      if (input === null) return "quit";
      if (!input) continue;
      if (/^\d+$/.test(input) && Number(input) > 0 && Number(input) <= 2_147_483_647)
        id = Number(input);
      else {
        prompt.write("Enter a positive AniList anime ID.");
        continue;
      }
    } else if (/^\d+$/.test(answer)) {
      id = candidates[Number(answer) - 1]?.id;
    }
    if (id === undefined) {
      prompt.write("Choose a listed number or action.");
      continue;
    }
    const media = await client.media(id);
    const result = await reviewMapping(store, season, media, options, prompt);
    if (result !== "back") return result;
  }
}

export async function mapInteractively(
  store: Store,
  seasons: LocalSeason[],
  client: Pick<AniListClient, "search" | "media">,
  options: MappingOptions,
  prompt: MappingPrompt,
): Promise<void> {
  let saved = 0;
  let skipped = 0;
  prompt.write(
    `Matching ${seasons.length} season(s). Select a match and review its episode range before saving. Saved mappings are kept if you quit.`,
  );
  for (const [index, season] of seasons.entries()) {
    prompt.write(`[${index + 1}/${seasons.length}]`);
    const outcome = await matchSeason(store, season, client, options, prompt);
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
