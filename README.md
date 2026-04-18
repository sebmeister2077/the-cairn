# Vintage Story Waypoint Extractor

A standalone Python script that extracts waypoints from [Vintage Story](https://www.vintagestory.at/) save files (`.vcdbs`). No external dependencies required — just Python 3.6+.

## Why?

Vintage Story stores waypoints inside a protobuf blob embedded in a SQLite database. There's no built-in way to export, search, or bulk-manage your waypoints outside the game. This tool lets you:

- **Export all waypoints** from any save file into a readable table or JSON
- **Search and filter** waypoints by title, icon, owner, or pinned status
- **Back up waypoint data** before risky world edits
- **Share waypoint lists** with other players on your server
- **Feed waypoint data into other tools** (maps, spreadsheets, scripts) via JSON output

## Requirements

- Python 3.6+
- No third-party packages needed (uses only `sqlite3`, `struct`, `argparse`, `json`, `os`, `sys`)

## Usage

```
python search_waypoints.py <save_file> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `save_file` | Path to a `.vcdbs` save file. Can be an absolute path, relative path, or just a filename (auto-searches default VS data directories). |
| `--config`, `-c` | Path to `serverconfig.json`. Auto-detected from the save file's location if omitted. Used to determine map size for coordinate conversion. |
| `--filter`, `-f` | Filter waypoints by title (case-insensitive substring match). |
| `--icon`, `-i` | Filter by icon name (e.g. `circle`, `bee`, `home`, `pick`). |
| `--owner`, `-o` | Filter by owner player UID (substring match). |
| `--pinned`, `-p` | Show only pinned waypoints. |
| `--json`, `-j` | Output as JSON instead of a table. |
| `--output` | Write output to a file instead of stdout. |

### Save file auto-discovery

If you pass just a filename (e.g. `myworld.vcdbs`), the script searches the default Vintage Story data directories:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\VintagestoryData\Saves\` |
| Linux | `~/.config/VintagestoryData/Saves/` |
| macOS | `~/Library/Application Support/VintagestoryData/Saves/` |

## Examples

### List all waypoints

```bash
python search_waypoints.py myworld.vcdbs
```

```
Config:  C:\Users\You\AppData\Roaming\VintagestoryData\serverconfig.json
Reading: myworld.vcdbs

  #  Title                                          Icon         X        Y          Z  Pinned  Color        GUID
--------------------------------------------------------------------------------------------------------------------------------------------
  1  Home Base                                      home       12.0  68.0      -45.0  Yes     #FF44AA00    a1b2c3d4-e5f6-7890-abcd-ef1234567890
  2  Iron Deposit                                   pick      -302.5  42.0      187.3  No      #FFFF6600    b2c3d4e5-f6a7-8901-bcde-f12345678901
  3  Trader Village                                 star       540.0  71.0     -820.6  Yes     #FF2299FF    c3d4e5f6-a7b8-9012-cdef-123456789012
  4  Clay pit                                       circle    -150.0  65.0       90.0  No      #FFCC3300    d4e5f6a7-b8c9-0123-defa-234567890123
  5  Beehive spot                                   bee        88.0  73.0     -210.0  No      #FFFFFF00    e5f6a7b8-c9d0-1234-efab-345678901234

Total: 5 waypoints
```

### Filter by title

```bash
python search_waypoints.py myworld.vcdbs --filter "iron"
```

```
  #  Title                                          Icon         X        Y          Z  Pinned  Color        GUID
--------------------------------------------------------------------------------------------------------------------------------------------
  1  Iron Deposit                                   pick      -302.5  42.0      187.3  No      #FFFF6600    b2c3d4e5-f6a7-8901-bcde-f12345678901

Total: 1 waypoints
```

### Export as JSON

```bash
python search_waypoints.py myworld.vcdbs --json --output waypoints.json
```

```json
[
  {
    "color": "#FF44AA00",
    "icon": "home",
    "field3": 0,
    "owner": "player-uid-string",
    "pinned": true,
    "x": 12.0,
    "y": 68.0,
    "z": -45.0,
    "title": "Home Base",
    "guid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  },
  {
    "color": "#FFFF6600",
    "icon": "pick",
    "field3": 0,
    "owner": "player-uid-string",
    "pinned": false,
    "x": -302.5,
    "y": 42.0,
    "z": 187.3,
    "title": "Iron Deposit",
    "guid": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
  }
]
```

### Save table output to a file

```bash
python search_waypoints.py myworld.vcdbs --output waypoints.txt
```

### Show only pinned waypoints with a specific icon

```bash
python search_waypoints.py myworld.vcdbs --pinned --icon home
```

---

## Waypoint Command Generator

`generate_commands.py` takes JSON output from the extractor and produces `/waypoint addati` commands you can paste directly into Vintage Story's chat to recreate waypoints in your own world.

### Usage

```bash
# Full pipeline: extract then generate
python search_waypoints.py myworld.vcdbs --json > waypoints.json
python generate_commands.py waypoints.json
```

### Arguments

| Argument | Description |
|---|---|
| `input` | Path to the JSON file (produced by `search_waypoints.py --json`) |
| `--output`, `-o` | Write commands to a file instead of stdout |
| `--filter`, `-f` | Only include waypoints whose title contains this term |
| `--icon`, `-i` | Only include waypoints with this icon |
| `--pinned`, `-p` | Only include pinned waypoints |

### Example output

```bash
python generate_commands.py waypoints.json
```

```
/waypoint addati home 12 68 -45 true -12285440 Home Base
/waypoint addati pick -303 42 187 false -39424 Iron Deposit
/waypoint addati star 540 71 -821 true -14114049 Trader Village
/waypoint addati circle -150 65 90 false -3342592 Clay pit
/waypoint addati bee 88 73 -210 false -256 Beehive spot
```

Each line can be pasted into the Vintage Story chat window (`T` key) to add that waypoint at the exact coordinates with the original icon, color, and title.

### Save to file

```bash
python generate_commands.py waypoints.json -o commands.txt
```

Then open `commands.txt` and paste commands one by one into the game.

### Filter before generating

```bash
# Only generate commands for waypoints with "trader" in the title
python generate_commands.py waypoints.json --filter trader

# Only pinned waypoints with the home icon
python generate_commands.py waypoints.json --pinned --icon home
```

---

## Waypoint Importer (Direct Save Editing)

`import_waypoints.py` writes waypoints directly into a `.vcdbs` save file — no need to paste commands in-game. It takes the same JSON format produced by the extractor.

> **Warning:** This modifies your save file. A timestamped backup is created automatically unless `--no-backup` is used. Always make sure the game is **not running** when importing.

### Usage

```bash
python import_waypoints.py <save_file> <waypoints.json> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `save_file` | Path to the target `.vcdbs` save file |
| `waypoints_json` | Path to the JSON waypoint file (from `search_waypoints.py --json`) |
| `--mode`, `-m` | `append` (default) adds to existing waypoints; `replace` removes all existing waypoints first |
| `--owner` | Override the owner UID for all imported waypoints (useful when importing another player's waypoints) |
| `--new-guids` | Generate fresh GUIDs for imported waypoints instead of keeping the originals |
| `--config`, `-c` | Path to `serverconfig.json` (auto-detected if omitted) |
| `--no-backup` | Skip creating a backup before modifying the save |
| `--dry-run` | Show what would happen without modifying anything |

### Examples

**Append waypoints to your world:**
```bash
python import_waypoints.py myworld.vcdbs waypoints.json
```
```
Config:  C:\Users\You\AppData\Roaming\VintagestoryData\serverconfig.json

Save:    myworld.vcdbs
Mode:    append
Existing waypoints: 12
Importing:          5
Total after import: 17
Backup:  myworld.vcdbs.backup_20260418_153012

Done! 5 waypoints imported.
```

**Replace all waypoints:**
```bash
python import_waypoints.py myworld.vcdbs waypoints.json --mode replace
```

**Preview without modifying:**
```bash
python import_waypoints.py myworld.vcdbs waypoints.json --dry-run
```

**Import with a different owner and fresh GUIDs:**
```bash
python import_waypoints.py myworld.vcdbs waypoints.json --owner "your-player-uid" --new-guids
```

### Full pipeline example

```bash
# 1. Extract waypoints from a friend's save
python search_waypoints.py friends_world.vcdbs --json > shared_waypoints.json

# 2. Preview what will be imported
python import_waypoints.py myworld.vcdbs shared_waypoints.json --dry-run

# 3. Import into your world with your ownership
python import_waypoints.py myworld.vcdbs shared_waypoints.json --owner "your-player-uid" --new-guids
```

---

## Waypoint Remover

`delete_waypoints.py` removes waypoints directly from a `.vcdbs` save file. By default it deletes **all** waypoints. Use filter options to target only specific ones.

> **Warning:** This modifies your save file. A timestamped backup is created automatically unless `--no-backup` is used. Always make sure the game is **not running** when deleting.

### Usage

```bash
python delete_waypoints.py <save_file> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `save_file` | Path to the `.vcdbs` save file |
| `--filter`, `-f` | Delete waypoints whose title contains this term (case-insensitive) |
| `--icon`, `-i` | Delete waypoints with this icon (e.g. `circle`, `bee`, `home`) |
| `--owner`, `-o` | Delete waypoints owned by this player UID (substring match) |
| `--pinned` | Delete only pinned waypoints |
| `--unpinned` | Delete only unpinned waypoints |
| `--color` | Delete waypoints with this exact color (e.g. `#FFFF6600`) |
| `--guid` | Delete a single waypoint by its exact GUID |
| `--config`, `-c` | Path to `serverconfig.json` (auto-detected if omitted) |
| `--no-backup` | Skip creating a backup before modifying the save |
| `--dry-run` | Show what would be deleted without modifying anything |

### Examples

**Delete all waypoints:**
```bash
python delete_waypoints.py myworld.vcdbs
```
```
Save:    myworld.vcdbs
Filters: none (deleting ALL waypoints)

Total waypoints:   17
To be deleted:     17
Remaining after:   0

Waypoints to delete:
  - Home Base  (home, 12 68 -45, pinned)
  - Iron Deposit  (pick, -303 42 187, unpinned)
  - Trader Village  (star, 540 71 -821, pinned)
  ...

Backup:  myworld.vcdbs.backup_20260418_161500
Done! Deleted 17 waypoints. 0 remaining.
```

**Delete only waypoints matching a title:**
```bash
python delete_waypoints.py myworld.vcdbs --filter "trader"
```

**Delete all unpinned circle waypoints:**
```bash
python delete_waypoints.py myworld.vcdbs --icon circle --unpinned
```

**Delete a single waypoint by GUID:**
```bash
python delete_waypoints.py myworld.vcdbs --guid "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

**Preview without modifying:**
```bash
python delete_waypoints.py myworld.vcdbs --filter "old" --dry-run
```

---

## How it works

1. Opens the `.vcdbs` file (a SQLite database) and reads the `gamedata` blob
2. Parses the protobuf-encoded game data to find the `playerMapMarkers_v2` entry
3. Decodes each waypoint message, extracting title, icon, color, position, owner, pinned status, and GUID
4. Reads `serverconfig.json` to determine map size, then converts internal absolute coordinates to in-game relative coordinates
5. Outputs the results as a formatted table or JSON

## Waypoint fields

| Field | Description |
|---|---|
| `title` | The waypoint name as shown in-game |
| `icon` | Icon identifier (e.g. `circle`, `bee`, `home`, `star`, `pick`) |
| `color` | ARGB hex color string (e.g. `#FF44AA00`) |
| `x`, `y`, `z` | In-game coordinates (converted from internal absolute coords) |
| `pinned` | Whether the waypoint is pinned (always visible on screen) |
| `owner` | The UID of the player who created the waypoint |
| `guid` | Unique identifier for the waypoint |

## License

This project is licensed under the [GNU General Public License v2.0](LICENSE).

You are free to use, modify, and distribute this software under the terms of the GPL v2. Any derivative work must also be distributed under the same license.
