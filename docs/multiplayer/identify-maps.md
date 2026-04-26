# Identify Maps

> Frontend route: `/multiplayer/identify`
> Page: [frontend/src/pages/IdentifyMapsPage.tsx](../../frontend/src/pages/IdentifyMapsPage.tsx)
> Logic: [frontend/src/lib/identify-maps.ts](../../frontend/src/lib/identify-maps.ts)
> Backend: **none** — this tool is 100% browser-side.

## What it does

When you play multiplayer, the game writes one `.db` per server you connect to into `%AppData%\VintagestoryData\Maps\`, but the filenames are randomised UUIDs. There is no in-file metadata that says "this map belongs to server X". After you've connected to many servers, you end up with a folder of opaque `.db` files and no way to tell which is which.

Identify Maps reconstructs that mapping by correlating two things the player already has:

1. The text logs in `%AppData%\VintagestoryData\Logs\`, which contain `Connecting to <addr>...` and `Received level finalize` lines with timestamps.
2. The list of `.db` files with their last-modified timestamps.

Optionally, `clientsettings.json` is parsed to pull friendly server names out of `stringListSettings.multiplayerservers` (entries are stored as `"<friendly name>, <address>"` and we split on the comma).

## Why it lives entirely in the browser

There is no reason for the server to see this data:

- Logs and `clientsettings.json` are personal — they list every server the player has connected to, including private/whitelisted ones. Sending them to the backend for parsing would be an unnecessary privacy hit.
- The matching algorithm is cheap (a few regex passes and a sort).
- The actual `.db` files are large; the user only needs the *filename*, not the contents, so a browser folder picker that returns `File` metadata is enough.

The page reads `File.text()` for logs and `clientsettings.json`, and reads `name`, `lastModified`, `size` for the `.db` files. The `.db` contents are never read.

## How the matching works

`extractDBFromLogs` in `lib/identify-maps.ts`:

1. **Parse connections** from the log(s). A connection is a `Connecting to <addr>...` line followed (later) by a `Received level finalize` line. The timestamp on the *finalize* line is taken as the connection time, because that's when the client has actually committed to writing the world DB. The regex parses VS's `dd.MM.yyyy HH:mm:ss` log timestamps.
2. **Deduplicate** by server address: keep only the most recent connection per address. The user almost always cares about "which DB is the *current* version of this server's map" rather than every historical session.
3. **Pair each connection with a `.db` file**: walk connections newest-to-oldest and assign the unmatched `.db` whose `lastModified` is **after** that connection but **less than 24 hours later**. Pick the closest one. Mark it as assigned so it can't be paired with an older connection too.
4. **Resolve friendly names** from `clientsettings.json` if provided. We look up by full `host:port`, then fall back to `host` only.

A `.db` is considered "matching" if it was modified within 24 hours after the connection was finalised. That window catches "I joined, played for a couple of hours, the game wrote the map" but excludes random unrelated DB writes.

## Heuristic & limitations

This is a best-effort correlation, not a guarantee. The known failure modes:

- **Servers with the same address but a different world** (server wipe, world swap): all old DBs share the same address; we pick whichever one's mtime is closest to the most recent connection. Old worlds can show up as "no match".
- **DBs older than the oldest log file**: if the user has rotated their logs, we have no way to know when those DBs were written; the corresponding row will show `dbFile: null`.
- **Two servers played within the 24h window of each other** can swap if the OS reports identical mtimes. The closest-mtime tiebreak is deterministic but not always semantically right.
- **Single-player worlds and replayed servers**: filenames in `Maps/` aren't only multiplayer, so the user is expected to point the page at the right files. We don't try to filter SP from MP.

The output is intended as an *aid* — the user should still verify by opening the matched DB in [Local Map Viewer](./local-map-viewer.md) before doing anything destructive (renaming, deleting, contributing).

## What the user sees

A table of `serverAddress`, `friendlyName`, `dbFile`, `dbSizeMB`, `lastConnected`. The `.db` filename is rendered with a copy-to-clipboard button so the user can quickly find or rename it on disk. Servers with no matching DB are still listed (they help the user understand which servers were detected at all).

The "files folder" hint card (`%AppData%\VintagestoryData\…`) is a static lookup, just there because new users have no idea where these files live.
