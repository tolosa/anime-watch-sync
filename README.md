# anime-watch-sync

A small terminal application that imports your Crunchyroll watch history into a local SQLite database and syncs watched episode progress to AniList.

Built for **Node.js 26** and **TypeScript 7**. TypeScript runs directly in Node, without a development transpiler. SQLite, AniList HTTP requests, environment-file loading, resource disposal (`using`), and the test runner use native Node/JavaScript features. Runtime packages are Commander, Zod, and `impit` for browser-compatible Crunchyroll HTTP requests. Interactive login launches your installed browser directly and uses Node’s native WebSocket support to observe its network responses.

```text
Crunchyroll watch-history → SQLite history + season mappings → AniList progress
```

## Setup

```sh
pnpm install
cp .env.example .env
chmod 600 .env
```

Edit `.env` using the authentication instructions below. Environment variables already set in your shell take precedence over `.env`. The file is loaded from the current working directory.

### Crunchyroll authentication

This app reads the internal endpoint used by Crunchyroll's website:

```text
GET https://www.crunchyroll.com/content/v2/{account_id}/watch-history
    ?page=1&page_size=100&locale=en-US
Authorization: Bearer <access_token>
```

Run the login command once:

```sh
pnpm dev auth login
```

The app opens **an installed Google Chrome** directly with a temporary, separate browser profile. It does not launch through Playwright, enable automation mode, inject scripts, or automate the human verification step. A local debugging connection observes the authentication and history responses while you sign in normally. Sign in on Crunchyroll's website, choose the profile you want to sync, and open **History in the same tab**. The window closes after the app observes a successful authenticated history response. No browser extension, Developer Tools, or manual token export is required. Microsoft Edge is also supported with `pnpm dev auth login --browser msedge`; `--timeout 600` allows ten minutes to complete sign-in. For a nonstandard installation, set `CR_BROWSER_PATH` to the browser executable.

The app captures the web session's `etp_rt` credential, access token, account/profile IDs, and the client/device information needed for renewal. It verifies renewal through `impit`, then saves the session to **`./data/cr-session.json`**. The file is unencrypted local JSON with owner-only permissions (`0600`), and `data/` is ignored by Git. Passwords are entered only on Crunchyroll's sign-in page and are not retained by the app. The temporary browser profile is deleted when login finishes or is cancelled. Keychain is not used.

`pull` and `sync --pull` authenticate exclusively through the saved session file. The access token and account/profile IDs come from that session. If no session is saved, run `pnpm dev auth login`. Before each page, the app checks the cached token's expiry and renews within 60 seconds of expiry using:

```text
POST https://www.crunchyroll.com/auth/v1/token
Cookie: etp_rt=<saved credential>
grant_type=etp_rt_cookie&scope=offline_access&device_id=<original device>
```

The original web client authorization and any observed device type/name are preserved. Returned credentials are rotated in the session file with an atomic replacement. An API `401` triggers one renewal and one retry of that page. A `403` does not trigger a renewal loop. A revoked or expired renewable session requires another `auth login`; automatic renewal cannot keep a revoked session alive. An invalid saved file reports an error and must be replaced through `auth login`.

```sh
pnpm dev auth status   # Local identity and token expiry; no credentials printed.
pnpm dev pull          # Refreshes tokens automatically as needed.
pnpm dev auth logout   # Removes the saved local session.
```

`auth status` does not contact Crunchyroll and cannot tell whether the renewable credential has been revoked. `auth logout` deletes the local file; it does not revoke sessions on Crunchyroll's servers. After logout, `pull` and `sync --pull` require another `auth login`. Run one login/pull process at a time: session files deliberately use no file locking.

`CR_PROFILE_ID` remains a local database label, defaulting to `default`. The authenticated profile ID is additionally bound to the database. When attaching a session to older history that has only a local profile label, choose the same profile you originally used to import that history. Changing profiles requires a separate database and session file:

```sh
pnpm dev --db ./data/other-profile.sqlite --session-file ./data/other-cr-session.json auth login
pnpm dev --db ./data/other-profile.sqlite --session-file ./data/other-cr-session.json pull
```

`CR_SESSION_PATH` can set the default session-file path. Keep custom session files in an ignored directory. `CR_PROFILE_ID` does not switch remote profiles; select the intended profile during login.

If your browser uses `https://beta-api.crunchyroll.com` for history, set `CR_BASE_URL` to that origin. History is restricted to that origin or `https://www.crunchyroll.com`, and redirects are rejected so bearer credentials cannot be forwarded elsewhere. Session renewal always uses `www.crunchyroll.com`.

The cookie renewal flow follows the maintained [crunchyroll-rs login implementation](https://github.com/crunchy-labs/crunchyroll-rs/blob/master/src/auth/login.rs) and [session executor](https://github.com/crunchy-labs/crunchyroll-rs/blob/master/src/auth/executor.rs). This is an internal API, and changes to Crunchyroll's login flow may require updating the app.

Crunchyroll requests use [`impit`](https://apify.github.io/impit/js/) with a Chrome browser profile for TLS and HTTP behavior. This addresses the Cloudflare challenge observed with Node's native `fetch` in this environment. After login, `pull` works with the browser closed. TLS certificate verification remains enabled, redirects are rejected, and requests retain the existing timeout and retry handling. AniList continues to use native `fetch`.

Cloudflare can also challenge the interactive login browser. Its [supported-browser guidance](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/) excludes automated browsers; this was a problem with the former Playwright login launcher. The current launcher uses a normal visible browser, a dedicated profile, and a loopback-only debugging port. If verification still loops, test Crunchyroll in your regular browser on the same network; browser or network restrictions can also cause challenge failures. The app cannot guarantee that Cloudflare will accept a session.

Crunchyroll's internal API can change or reject requests. `impit` does not execute JavaScript or solve interactive challenges. If Cloudflare still returns `cf-mitigated: challenge`, the CLI reports that condition specifically; refreshing the API token alone will not resolve it. This is separate from token expiry or an account/profile mismatch. The package includes a native binary, which pnpm installs for the current platform; do not omit optional dependencies when installing it.

Other `403` responses and unexpected response shapes are reported separately. The database keeps pages successfully imported before a failure, and rerunning `pull` safely starts again from page 1.

The importer starts at page 1 and then uses the opaque `page` cursor returned in `meta.next_page`. It reconstructs each request on the configured Crunchyroll origin, rather than following the supplied URL. On current responses, `total` can describe only the current page, so the next-page cursor takes precedence.

The endpoint, pagination, and response model are based on the maintained [crunchyroll-rs watch-history implementation](https://github.com/crunchy-labs/crunchyroll-rs/blob/master/src/list/watch_history.rs). The direct-browser sign-in, `impit` renewal, and a second renewal from the persisted session file have been verified against a live account in this environment. The `impit` transport has also been verified against authenticated watch history; availability can vary by session and network.

### AniList authentication

1. Create an OAuth application in [AniList developer settings](https://anilist.co/settings/developer).
2. Set its redirect URL to `https://anilist.co/api/v2/oauth/pin`.
3. Set `ANILIST_CLIENT_ID` in `.env` and run:

   ```sh
   pnpm dev auth-url
   ```

4. Open the printed URL, authorize your application, and put the returned access token into `ANILIST_ACCESS_TOKEN` in `.env`. Use the access token, not your client secret.

This uses AniList's [implicit grant](https://docs.anilist.co/guide/auth/implicit) with its [manual PIN redirect](https://docs.anilist.co/guide/auth/). Tokens must be replaced when they expire. `auth-url` only prints the authorization link; it never prints or saves an access token.

## First sync

```sh
# Import all history currently exposed by Crunchyroll.
pnpm dev pull

# Inspect local records and copy season IDs.
pnpm dev history --limit 20
pnpm dev seasons

# Find the correct AniList entry for a season.
pnpm dev search "Frieren"

# Replace these example IDs with the IDs from seasons/search.
pnpm dev map CR_SEASON_ID ANILIST_ID

# Preview proposed changes using current AniList progress.
pnpm dev sync

# Apply them.
pnpm dev sync --apply
```

Once your mappings exist, refresh and sync in one command:

```sh
pnpm dev sync --pull --apply
```

`sync` defaults to preview mode. `--dry-run` makes that explicit. `--pull --dry-run` refreshes the **local** database but makes no AniList mutations. A preview does not write a sync log or bind a new AniList account.

You can also compile once and run the emitted JavaScript:

```sh
pnpm build
pnpm start --help
pnpm start sync --pull --apply
# Equivalent: node dist/cli.js sync --pull --apply
```

## Season mappings

Mappings are explicit because Crunchyroll and AniList do not consistently split seasons, split-season parts, specials, and dubbed versions the same way. `search` provides candidate IDs; `map` validates the selected AniList anime and stores the mapping. Title matching never automatically changes your list.

Each mapping covers an inclusive range of Crunchyroll episode numbers:

```text
AniList episode = Crunchyroll episode − offset
```

For example, if Crunchyroll numbers a second season as episodes 13–24, but AniList numbers it 1–12:

```sh
pnpm dev map CR_SEASON_ID ANILIST_SEASON_2_ID --from 13 --to 24 --offset 12
```

If one Crunchyroll season covers two AniList entries:

```sh
pnpm dev map CR_SEASON_ID ANILIST_PART_1_ID --from 1 --to 12
pnpm dev map CR_SEASON_ID ANILIST_PART_2_ID --from 13 --to 24 --offset 12
```

The defaults are `--from 1`, no upper bound, and `--offset 0`. Negative offsets support the reverse case: Crunchyroll episode 1 can map to AniList episode 13 with `--offset -12`. Overlapping ranges for the same season are rejected. Running `map` again with the same season ID and `--from` replaces that mapping. Narrow an existing open-ended range before adding a second one.

Multiple Crunchyroll season IDs, including separate dubs, can map to the same AniList entry. Watched episode numbers are combined and deduplicated. Movies appear under `movie:CONTENT_ID` and map as one episode. Entries with missing metadata, missing episode numbers, or fractional specials remain archived but do not advance AniList progress.

```sh
pnpm dev unmap CR_SEASON_ID              # Removes the range starting at 1.
pnpm dev unmap CR_SEASON_ID --from 13    # Removes only that range.
```

## Sync behavior

- An episode counts as watched when Crunchyroll reports `fully_watched`, or the playhead reaches `WATCHED_THRESHOLD` of its runtime (default **90%**). Playheads are seconds; durations are milliseconds. Unknown/zero runtime never passes the threshold by itself.
- Local history is an archive keyed by content ID, not an append-only log of every viewing. Reimports preserve the highest playhead and completed flag, so starting a rewatch does not erase prior completion. Raw JSON from the most recent import is kept separately.
- Progress advances through **consecutive watched episode numbers after the current AniList progress**. For example, local episodes 1, 2, 4 advance a new list entry to 2; episode 3 must be watched before it can advance to 4. Remote progress 10 plus local watched episodes 11 and 12 advances to 12 even if older history is unavailable.
- Higher AniList progress is preserved. Existing `COMPLETED`, `REPEATING`, `PAUSED`, and `DROPPED` entries are left as they are. New entries and advancing `PLANNING`/`CURRENT` entries become `CURRENT`, or `COMPLETED` when the known AniList episode total is reached. Unknown episode totals never trigger automatic completion.
- A mapped episode above AniList's known total skips the entire entry with a range/offset warning. Progress is not silently capped to hide a mapping mistake.
- Only list entry ID, media ID, progress, and status are sent to `SaveMediaListEntry`. The app does not send scores, notes, repeat counts, or watch dates.
- AniList is read again on every run; successful writes are logged locally. Uncertain network/server failures on mutations are not retried blindly. Rerunning reads the remote state and reconciles it.
- Requests are paced, with timeouts and bounded retries for rate limits and transient read failures. AniList's rate-limit response headers are honored for normal cooldowns; unusually long cooldowns stop with an error.
- Crunchyroll account/profile labels and the AniList viewer ID are bound to the database to catch accidental account changes. Run one sync process at a time and avoid editing the same AniList entries during a sync; AniList does not provide an atomic compare-and-update operation here.

The app imports only the history Crunchyroll currently exposes. It cannot reconstruct removed/expired history or infer earlier episodes from a later episode. To bridge a known gap, correct your baseline progress on AniList manually, then rerun sync.

## Commands and configuration

| Command | Purpose |
| --- | --- |
| `auth login [--browser chrome/msedge] [--timeout 300]` | Sign in and save a renewable session |
| `auth status` | Show local session identity/expiry without credentials |
| `auth logout` | Remove the local saved session |
| `pull [--page-size 100]` | Fetch and upsert all available history |
| `history [--limit 20]` | Inspect recent local records |
| `seasons` | Show local season IDs and saved mappings |
| `search "title"` | Search AniList anime |
| `map <season-id> <anilist-id>` | Save a mapping; supports `--from`, `--to`, `--offset` |
| `unmap <season-id> [--from 1]` | Remove a mapping |
| `auth-url [--client-id ID]` | Print the AniList authorization URL |
| `sync [--pull] [--apply / --dry-run]` | Preview or apply watch progress |

| Environment variable | Default / purpose |
| --- | --- |
| `CR_BROWSER_PATH` | Optional installed browser executable for `auth login` |
| `CR_SESSION_PATH` | `./data/cr-session.json`; local renewable session file |
| `CR_PROFILE_ID` | `default`; local profile identity label |
| `CR_BASE_URL` | `https://www.crunchyroll.com` |
| `CR_LOCALE` | `en-US` |
| `ANILIST_ACCESS_TOKEN` | Required for `search`, `map`, and `sync` |
| `ANILIST_CLIENT_ID` | Used only by `auth-url` |
| `DATABASE_PATH` | `./data/watch-history.sqlite` |
| `WATCHED_THRESHOLD` | `0.9`; must be greater than 0 and at most 1 |

Override the database per invocation with the global `--db` flag:

```sh
pnpm dev --db ./data/other-profile.sqlite seasons
```

The database contains `history`, `mappings`, `sync_log`, and `metadata` tables. SQLite uses WAL mode and a five-second busy timeout. Import transactions commit one page at a time. Crunchyroll credentials are read only from the session file. AniList credentials are read from your environment or `.env`. Credentials are never stored in SQLite. `.env`, the default session file, temporary login profiles, database files, and build output are ignored by Git. Database files are created with owner-only permissions.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
# Or all three:
pnpm check

# Optional: opens installed Chrome against a local synthetic test page.
pnpm test:browser
```

Tests use synthetic Crunchyroll responses, mocked AniList HTTP, real temporary SQLite databases, and a local HTTP server exercising the actual `impit` transport. They cover session persistence and rotation, expiry and 401 renewal, profile isolation, browser capture filtering, pagination, repeat imports, rollback, mappings, completion thresholds, gaps, preview behavior, repeat syncs, failure handling, redirects, and CLI execution. They require no tokens and make no external API calls. The optional browser smoke test verifies normal browser mode (`navigator.webdriver === false`), network/cookie capture, and temporary-profile cleanup against a local test server. Live Crunchyroll requests have been verified separately; AniList mutations have only been tested with mocks.

The API integration follows AniList's [mutation reference](https://docs.anilist.co/reference/mutation) and [rate-limit guidance](https://docs.anilist.co/guide/rate-limiting).
