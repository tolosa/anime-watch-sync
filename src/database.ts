import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HistoryItem } from "./crunchyroll.ts";

export interface Mapping {
  seasonId: string;
  mediaId: number;
  from: number;
  to: number | null;
  offset: number;
  mode?: "count";
}

export function buildSeasonMappings(
  seasonId: string,
  targets: { id: number; episodes: number | null }[],
): Mapping[] {
  if (!seasonId || targets.length === 0)
    throw new Error("Invalid mapping: select at least one AniList entry for a season.");
  const ids = new Set<number>();
  let offset = 0;
  return targets.map(({ id, episodes }, index) => {
    const last = index === targets.length - 1;
    if (!Number.isSafeInteger(id) || id < 1 || ids.has(id))
      throw new Error("Invalid mapping: AniList IDs must be unique positive safe integers.");
    if (episodes === null ? !last : !Number.isSafeInteger(episodes) || episodes < 1)
      throw new Error(
        "Invalid mapping: episode totals must be positive safe integers; only the last entry may have an unknown total.",
      );
    const from = offset + 1;
    const end = episodes === null ? offset : offset + episodes;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(end))
      throw new Error("Invalid mapping: accumulated episode ranges exceed safe integers.");
    ids.add(id);
    // Count boundaries are watched ordinals, not source episode numbers. The last
    // slice stays open so future imports use the live AniList total as their cap.
    const mapping: Mapping = {
      seasonId,
      mediaId: id,
      from,
      to: last ? null : end,
      offset,
      mode: "count",
    };
    offset = end;
    return mapping;
  });
}

export class Store implements Disposable {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY, season_id TEXT, series_title TEXT NOT NULL,
        season_title TEXT NOT NULL, episode_title TEXT NOT NULL, episode_number REAL,
        duration_ms REAL, playhead REAL NOT NULL, fully_watched INTEGER NOT NULL,
        watched_at TEXT, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS history_season ON history(season_id);
      CREATE TABLE IF NOT EXISTS mappings (
        season_id TEXT NOT NULL, media_id INTEGER NOT NULL CHECK(media_id > 0),
        episode_from INTEGER NOT NULL CHECK(episode_from > 0), episode_to INTEGER,
        episode_offset INTEGER NOT NULL,
        PRIMARY KEY (season_id, episode_from),
        CHECK(episode_to IS NULL OR episode_to >= episode_from),
        CHECK(episode_from - episode_offset > 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY, media_id INTEGER NOT NULL, progress INTEGER NOT NULL,
        status TEXT NOT NULL, synced_at TEXT NOT NULL
      ) STRICT;
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(mappings)")
        .all()
        .some((column) => column.name === "mode")
    ) {
      this.db.exec(`ALTER TABLE mappings ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'
        CHECK(mode IN ('legacy', 'count'))`);
    }
  }

  [Symbol.dispose](): void {
    this.db.close();
  }

  private bind(key: string, value: string, persist: boolean): void {
    const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
    if (current && current.value !== value) {
      throw new Error(
        `This database belongs to a different ${key}. Use a separate --db file for each account/profile.`,
      );
    }
    if (persist && !current)
      this.db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run(key, value);
  }

  bindSource(accountId: string, profileId: string): void {
    this.bind("Crunchyroll source", JSON.stringify([accountId, profileId]), true);
  }

  bindAuthenticatedSource(accountId: string, profileId: string, label: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.bindSource(accountId, label);
      this.bind("Crunchyroll authenticated profile", profileId, true);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindTarget(userId: number, persist: boolean): void {
    this.bind("AniList user", String(userId), persist);
  }

  upsertHistory(items: HistoryItem[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        season_id = COALESCE(excluded.season_id, history.season_id),
        series_title = COALESCE(NULLIF(excluded.series_title, ''), history.series_title),
        season_title = COALESCE(NULLIF(excluded.season_title, ''), history.season_title),
        episode_title = COALESCE(NULLIF(excluded.episode_title, ''), history.episode_title),
        episode_number = COALESCE(excluded.episode_number, history.episode_number),
        duration_ms = COALESCE(excluded.duration_ms, history.duration_ms),
        playhead = MAX(history.playhead, excluded.playhead),
        fully_watched = MAX(history.fully_watched, excluded.fully_watched),
        watched_at = CASE WHEN COALESCE(excluded.watched_at, '') > COALESCE(history.watched_at, '')
          THEN excluded.watched_at ELSE history.watched_at END,
        raw_json = excluded.raw_json, imported_at = excluded.imported_at
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      for (const item of items)
        upsert.run(
          item.id,
          item.seasonId,
          item.seriesTitle,
          item.seasonTitle,
          item.episodeTitle,
          item.episodeNumber,
          item.durationMs,
          item.playhead,
          Number(item.fullyWatched),
          item.watchedAt,
          item.raw,
          now,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  history(): HistoryItem[] {
    return this.db
      .prepare(`SELECT id, season_id AS seasonId, series_title AS seriesTitle,
      season_title AS seasonTitle, episode_title AS episodeTitle, episode_number AS episodeNumber,
      duration_ms AS durationMs, playhead, fully_watched AS fullyWatched, watched_at AS watchedAt,
      raw_json AS raw FROM history ORDER BY season_id, episode_number`)
      .all()
      .map((row) => ({
        ...row,
        fullyWatched: row.fullyWatched === 1,
      })) as unknown as HistoryItem[];
  }

  mappings(): Mapping[] {
    return this.db
      .prepare(`SELECT season_id AS seasonId, media_id AS mediaId,
      episode_from AS "from", episode_to AS "to", episode_offset AS offset, mode
      FROM mappings ORDER BY season_id, episode_from`)
      .all()
      .map(({ mode, ...mapping }) =>
        mode === "count" ? { ...mapping, mode } : mapping,
      ) as unknown as Mapping[];
  }

  validateMapping(mapping: Mapping): void {
    const { seasonId, mediaId, from, to, offset } = mapping;
    if (
      !seasonId ||
      (mapping.mode !== undefined && mapping.mode !== "count") ||
      (mapping.mode === "count" && offset !== from - 1) ||
      ![mediaId, from, offset].every(Number.isSafeInteger) ||
      mediaId < 1 ||
      from < 1 ||
      (to !== null && (!Number.isSafeInteger(to) || to < from)) ||
      from - offset < 1
    ) {
      throw new Error(
        "Invalid mapping: use positive IDs/ranges and an offset that yields AniList episode 1 or greater.",
      );
    }
    if (!this.db.prepare("SELECT 1 FROM history WHERE season_id = ?").get(seasonId)) {
      throw new Error(
        "Unknown season ID. Run pull, then seasons, and copy a season ID from the results.",
      );
    }
    const overlap = this.mappings().find(
      (m) =>
        m.seasonId === seasonId &&
        m.from !== from &&
        m.from <= (to ?? Infinity) &&
        from <= (m.to ?? Infinity),
    );
    if (overlap)
      throw new Error(
        `Episode range overlaps the mapping starting at ${overlap.from}. Remove it or narrow the range first.`,
      );
  }

  setMapping(mapping: Mapping): void {
    this.validateMapping(mapping);
    const { seasonId, mediaId, from, to, offset } = mapping;
    this.db
      .prepare(`INSERT INTO mappings
        (season_id, media_id, episode_from, episode_to, episode_offset, mode)
        VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(season_id, episode_from) DO UPDATE SET media_id = excluded.media_id,
      episode_to = excluded.episode_to, episode_offset = excluded.episode_offset,
      mode = excluded.mode`)
      .run(seasonId, mediaId, from, to, offset, mapping.mode ?? "legacy");
  }

  setSeasonMapping(seasonId: string, mediaId: number): void {
    this.setSeasonMappings(seasonId, [{ id: mediaId, episodes: null }]);
  }

  setSeasonMappings(seasonId: string, targets: { id: number; episodes: number | null }[]): void {
    const mappings = buildSeasonMappings(seasonId, targets);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.removeMapping(seasonId);
      for (const mapping of mappings) this.setMapping(mapping);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeMapping(seasonId: string, from?: number): number {
    if (from === undefined) {
      return Number(
        this.db.prepare("DELETE FROM mappings WHERE season_id = ?").run(seasonId).changes,
      );
    }
    return Number(
      this.db
        .prepare("DELETE FROM mappings WHERE season_id = ? AND episode_from = ?")
        .run(seasonId, from).changes,
    );
  }

  recordSync(mediaId: number, progress: number, status: string): void {
    this.db
      .prepare("INSERT INTO sync_log(media_id, progress, status, synced_at) VALUES (?, ?, ?, ?)")
      .run(mediaId, progress, status, new Date().toISOString());
  }
}
