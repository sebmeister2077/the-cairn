# Waypoint Tool — Feature Ideas

The waypoint tool currently does three things: parse a `client-chat.log` from
`/waypoint list details`, pull markers from the site overlays
(landmarks/traders/translocators), or build remove/loop macros from scratch —
and outputs a `.json` macro file dropped into the VS `Macros/` folder.

The guiding question for new features: **what can an external app do that the
in-game waypoint UI genuinely can't?** Three buckets: *bulk operations*,
*backup/portability*, and *syncing against the shared community map*.

## Tier 1 — "you literally can't do this in-game"

1. **Sync missing waypoints from the community map ("what am I missing?")**
   Upload chat-log → diff against the live traders/translocators/landmarks
   overlays → generate an add-macro for only the map features you don't already
   have (matched by proximity, not exact coords). One click brings your game up
   to date with everything the community has mapped. The killer feature.

2. **Backup & restore your full waypoint set**
   VS has no waypoint backup. Save a named snapshot (account-backed) and
   regenerate a re-add macro anytime. Portable across characters/worlds.

3. **Dedup & cleanup detection**
   Flag exact/near-duplicate coordinates, auto-named junk (e.g. `770 57560`),
   and markers sitting on a known map feature. Generate a remove-macro for the
   cruft. (In progress.)

## Tier 2 — bulk editing painful in-game

4. **Rule-based recolor / re-icon / rename** — emit `modify` commands from rules
   ("all traders → pink + trader icon", "names matching coal/copper → pick").
5. **Distance / region filtering** — only waypoints within N blocks of a point
   or inside a map region.
6. **Merge multiple chat-logs** — combine sets from several characters, dedup,
   output one clean set.

## Tier 3 — sharing / collaboration

7. **Shareable waypoint packs** — export a curated set to a link/short code;
   import a friend's.
8. **Translocator route labeling** — generate TL-network waypoints labeled by
   destination ("→ Spawn", "→ Iron base"), or trace a route between two points.

## Priority

#1 (sync from community map) and #2 (backup/restore) justify the app's
existence — they lean on the two assets the game can't replicate: the shared map
database and persistent storage. #3 (dedup) is a strong, low-effort companion.
