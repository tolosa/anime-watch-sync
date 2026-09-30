import { z } from "zod";
import { JsonHttpClient } from "./http.ts";

export const statusSchema = z.enum([
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "DROPPED",
  "PAUSED",
  "REPEATING",
]);
export type ListStatus = z.infer<typeof statusSchema>;
const dateSchema = z.object({
  year: z.number().int().nullable(),
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
});
export type WatchDate = { year: number; month: number; day: number };
export interface WatchDates {
  startedAt?: WatchDate;
  completedAt?: WatchDate;
}

export function sameDate(a: z.infer<typeof dateSchema> | null | undefined, b: WatchDate): boolean {
  return a?.year === b.year && a.month === b.month && a.day === b.day;
}

const listSchema = z.object({
  id: z.number().int(),
  progress: z.number().int().nonnegative(),
  status: statusSchema,
  startedAt: dateSchema.nullish(),
  completedAt: dateSchema.nullish(),
});
const mediaSchema = z.object({
  id: z.number().int(),
  title: z.object({ romaji: z.string().nullable(), english: z.string().nullable() }),
  episodes: z.number().int().positive().nullable(),
  format: z.string().nullable(),
  mediaListEntry: listSchema.nullable(),
});
export type Media = z.infer<typeof mediaSchema>;
export type ListEntry = z.infer<typeof listSchema>;
const listFields = "id progress status startedAt { year month day } completedAt { year month day }";
const fields = `id title { romaji english } episodes format mediaListEntry { ${listFields} }`;

export function mediaTitle(media: Pick<Media, "title" | "id">): string {
  return media.title.english ?? media.title.romaji ?? `AniList ${media.id}`;
}

export class AniListClient {
  private readonly accessToken: string;
  private readonly http: JsonHttpClient;
  constructor(accessToken: string, http = new JsonHttpClient("AniList", fetch, undefined, 2100)) {
    this.accessToken = accessToken;
    this.http = http;
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    mutation = false,
  ): Promise<T> {
    const payload = await this.http.request(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      },
      !mutation,
    );
    const envelope = z
      .object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
      .safeParse(payload);
    if (!envelope.success) throw new Error("AniList returned an unexpected GraphQL response.");
    // Do not echo response bodies, which can contain personal information.
    if (envelope.data.errors?.length)
      throw new Error(
        "AniList returned GraphQL errors. Check your token, media ID, and API availability.",
      );
    const result = schema.safeParse(envelope.data.data);
    if (!result.success)
      throw new Error("AniList returned missing or unexpected data. Check the media ID and token.");
    return result.data;
  }

  async viewer(): Promise<{ id: number; name: string }> {
    return (
      await this.query(
        "query { Viewer { id name } }",
        {},
        z.object({ Viewer: z.object({ id: z.number().int(), name: z.string() }) }),
      )
    ).Viewer;
  }

  async search(search: string): Promise<Media[]> {
    return (
      await this.query(
        `query ($search: String!) {
      Page(page: 1, perPage: 10) { media(search: $search, type: ANIME) { ${fields} } }
    }`,
        { search },
        z.object({ Page: z.object({ media: z.array(mediaSchema) }) }),
      )
    ).Page.media;
  }

  async media(id: number): Promise<Media> {
    return (
      await this.query(
        `query ($id: Int!) { Media(id: $id, type: ANIME) { ${fields} } }`,
        { id },
        z.object({ Media: mediaSchema }),
      )
    ).Media;
  }

  async save(
    media: Media,
    progress: number,
    status: ListStatus,
    dates: WatchDates = {},
  ): Promise<ListEntry> {
    // AniList validates an explicit null id as an invalid list entry ID.
    // For new entries, omit the argument entirely and identify the anime by mediaId.
    const entryId = media.mediaListEntry?.id;
    const dateKeys = (["startedAt", "completedAt"] as const).filter(
      (key) => dates[key] !== undefined,
    );
    const dateVariables = dateKeys.map((key) => `, $${key}: FuzzyDateInput!`).join("");
    const dateArguments = dateKeys.map((key) => `, ${key}: $${key}`).join("");
    const entry = (
      await this.query(
        `mutation (${entryId === undefined ? "" : "$id: Int!, "}$mediaId: Int!, $progress: Int!, $status: MediaListStatus!${dateVariables}) {
      SaveMediaListEntry(${entryId === undefined ? "" : "id: $id, "}mediaId: $mediaId, progress: $progress, status: $status${dateArguments}) { ${listFields} }
    }`,
        {
          ...(entryId === undefined ? {} : { id: entryId }),
          mediaId: media.id,
          progress,
          status,
          ...dates,
        },
        z.object({ SaveMediaListEntry: listSchema }),
        true,
      )
    ).SaveMediaListEntry;
    if (entry.progress !== progress || entry.status !== status)
      throw new Error(
        "AniList did not confirm the requested progress/status. Rerun sync to reconcile.",
      );
    if (dateKeys.some((key) => !sameDate(entry[key], dates[key]!)))
      throw new Error(
        "AniList did not confirm the requested watch dates. Rerun sync to reconcile.",
      );
    return entry;
  }
}
