# Vintage Story Waypoint Extractor
# Copyright (C) 2026
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along
# with this program; if not, see <https://www.gnu.org/licenses/>.

"""
Vintage Story Waypoint Extractor
Extracts waypoints from a .vcdbs save file's gamedata protobuf blob.

Usage:
    python search_waypoints.py <save_file> [--filter TERM] [--icon ICON] [--owner NAME] [--json]

Examples:
    python search_waypoints.py "C:/Users/You/AppData/Roaming/VintagestoryData/Saves/myworld.vcdbs"
    python search_waypoints.py myworld.vcdbs --filter "gold"
    python search_waypoints.py myworld.vcdbs --icon circle
    python search_waypoints.py myworld.vcdbs --json > waypoints.json
"""

import sqlite3
import struct
import argparse
import json
import os
import sys

# Vintage Story default data directories per platform
_VS_DATA_DIRS = [
    os.path.join(os.environ.get("APPDATA", ""), "VintagestoryData"),          # Windows
    os.path.expanduser("~/.config/VintagestoryData"),                          # Linux
    os.path.expanduser("~/Library/Application Support/VintagestoryData"),      # macOS
]

# ─── Protobuf minimal decoder ────────────────────────────────────────────────

def decode_varint(data, offset):
    """Decode a protobuf varint, return (value, new_offset)."""
    result = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise ValueError("Varint extends past end of data")
        byte = data[offset]
        result |= (byte & 0x7F) << shift
        offset += 1
        if (byte & 0x80) == 0:
            break
        shift += 7
    return result, offset


def decode_signed_varint(data, offset):
    """Decode a varint and interpret as signed 64-bit int."""
    val, offset = decode_varint(data, offset)
    # Interpret as signed 64-bit
    if val >= (1 << 63):
        val -= (1 << 64)
    return val, offset


def parse_protobuf_fields(data):
    """Parse raw protobuf bytes into a dict of {field_number: [(wire_type, value), ...]}."""
    fields = {}
    offset = 0
    while offset < len(data):
        tag, offset = decode_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:  # Varint
            value, offset = decode_varint(data, offset)
        elif wire_type == 1:  # 64-bit (fixed64 / double)
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 2:  # Length-delimited (string, bytes, sub-message)
            length, offset = decode_varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 5:  # 32-bit (fixed32 / float)
            value = data[offset:offset + 4]
            offset += 4
        else:
            break  # Unknown wire type

        fields.setdefault(field_number, []).append((wire_type, value))

    return fields


# ─── Waypoint decoder ────────────────────────────────────────────────────────

def decode_color(varint_val):
    """Convert protobuf varint (unsigned) to ARGB color int."""
    # Stored as signed int cast to unsigned varint representation
    if varint_val >= (1 << 63):
        varint_val -= (1 << 64)
    return varint_val


def color_to_hex(color_int):
    """Convert signed int color to #AARRGGBB hex string."""
    # Force to unsigned 32-bit
    color_uint = color_int & 0xFFFFFFFF
    return f"#{color_uint:08X}"


def decode_position(pos_bytes):
    """Decode a position sub-message with double fields for X, Y, Z."""
    fields = parse_protobuf_fields(pos_bytes)
    x = y = z = 0.0
    if 1 in fields:
        x = struct.unpack('<d', fields[1][0][1])[0]
    if 2 in fields:
        y = struct.unpack('<d', fields[2][0][1])[0]
    if 3 in fields:
        z = struct.unpack('<d', fields[3][0][1])[0]
    return x, y, z


def decode_waypoint(wp_bytes):
    """Decode a single waypoint protobuf message."""
    fields = parse_protobuf_fields(wp_bytes)
    wp = {}

    # Field 1: Color (varint)
    if 1 in fields:
        wp['color'] = color_to_hex(decode_color(fields[1][0][1]))

    # Field 2: Icon (string)
    if 2 in fields:
        wp['icon'] = fields[2][0][1].decode('utf-8', errors='replace')

    # Field 3: Unknown varint (possibly ShowInWorld or similar)
    if 3 in fields:
        val = fields[3][0][1]
        if val >= (1 << 63):
            val -= (1 << 64)
        wp['field3'] = val

    # Field 4: OwningPlayerUid (string)
    if 4 in fields:
        wp['owner'] = fields[4][0][1].decode('utf-8', errors='replace')

    # Field 5: Pinned (bool/varint)
    if 5 in fields:
        wp['pinned'] = bool(fields[5][0][1])

    # Field 6: Position (sub-message with doubles)
    if 6 in fields:
        x, y, z = decode_position(fields[6][0][1])
        wp['x'] = x
        wp['y'] = y
        wp['z'] = z

    # Field 10: Title (string)
    if 10 in fields:
        wp['title'] = fields[10][0][1].decode('utf-8', errors='replace')

    # Field 11: Guid (string)
    if 11 in fields:
        wp['guid'] = fields[11][0][1].decode('utf-8', errors='replace')

    return wp


# ─── Extract from save ───────────────────────────────────────────────────────

def find_server_config(save_path):
    """Locate serverconfig.json based on the save file's location.
    
    Typical VS data layout: <DataDir>/Saves/<file>.vcdbs
    So serverconfig.json is at <DataDir>/serverconfig.json (two levels up).
    """
    saves_dir = os.path.dirname(os.path.abspath(save_path))
    data_dir = os.path.dirname(saves_dir)
    candidate = os.path.join(data_dir, "serverconfig.json")
    if os.path.isfile(candidate):
        return candidate
    return None


def get_map_offsets(config_path=None):
    """Read map size from serverconfig.json and return (offset_x, offset_z).
    
    Vintage Story stores positions as absolute internal coordinates.
    In-game coordinates are relative to the map center (mapSize / 2).
    """
    offset_x = 512000  # default for 1,024,000 map
    offset_z = 512000
    if config_path is None:
        return offset_x, offset_z
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        offset_x = config.get('MapSizeX', 1024000) // 2
        offset_z = config.get('MapSizeZ', 1024000) // 2
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass
    return offset_x, offset_z


def extract_waypoints(save_path, config_path=None):
    """Extract all waypoints from a Vintage Story .vcdbs save file."""
    conn = sqlite3.connect(save_path)
    cur = conn.cursor()
    cur.execute('SELECT data FROM gamedata WHERE savegameid=1')
    row = cur.fetchone()
    conn.close()

    if not row:
        print("ERROR: No gamedata found in save.", file=sys.stderr)
        return []

    data = row[0]

    # The gamedata blob is a protobuf message.
    # We need to find the playerMapMarkers_v2 key-value entry.
    # The outer structure uses repeated field 11 (tag 0x5a) for key-value pairs:
    #   field 1 = key (string), field 2 = value (bytes)
    outer_fields = parse_protobuf_fields(data)

    waypoints = []
    markers_data = None

    # Field 11 contains the mod system data entries (key-value pairs)
    if 11 in outer_fields:
        for _, entry_bytes in outer_fields[11]:
            entry_fields = parse_protobuf_fields(entry_bytes)
            key = ""
            if 1 in entry_fields:
                key = entry_fields[1][0][1].decode('utf-8', errors='replace')
            if key == "playerMapMarkers_v2" and 2 in entry_fields:
                markers_data = entry_fields[2][0][1]
                break

    if not markers_data:
        print("WARNING: playerMapMarkers_v2 not found in gamedata.", file=sys.stderr)
        return []

    # Convert internal absolute coords to game-relative coords
    offset_x, offset_z = get_map_offsets(config_path)

    # markers_data is a repeated message — each field 1 entry is one waypoint
    marker_fields = parse_protobuf_fields(markers_data)
    if 1 in marker_fields:
        for _, wp_bytes in marker_fields[1]:
            try:
                wp = decode_waypoint(wp_bytes)
                # Convert to in-game coordinates
                if 'x' in wp:
                    wp['x'] = wp['x'] - offset_x
                if 'z' in wp:
                    wp['z'] = wp['z'] - offset_z
                waypoints.append(wp)
            except Exception as e:
                print(f"WARNING: Failed to decode a waypoint: {e}", file=sys.stderr)

    return waypoints


# ─── Display ──────────────────────────────────────────────────────────────────

def print_waypoints_table(waypoints, file=None):
    """Pretty-print waypoints as a table."""
    if file is None:
        file = sys.stdout
    if not waypoints:
        print("No waypoints found.", file=file)
        return

    print(f"\n{'#':>3}  {'Title':<45} {'Icon':<10} {'X':>10} {'Y':>6} {'Z':>10}  {'Pinned':<6}  {'Color':<11}  GUID", file=file)
    print("-" * 140, file=file)
    for i, wp in enumerate(waypoints, 1):
        title = wp.get('title', '???')
        icon = wp.get('icon', '?')
        x = wp.get('x', 0)
        y = wp.get('y', 0)
        z = wp.get('z', 0)
        pinned = "Yes" if wp.get('pinned') else "No"
        color = wp.get('color', '?')
        guid = wp.get('guid', '?')
        print(f"{i:>3}  {title:<45} {icon:<10} {x:>10.1f} {y:>6.1f} {z:>10.1f}  {pinned:<6}  {color:<11}  {guid}", file=file)

    print(f"\nTotal: {len(waypoints)} waypoints", file=file)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Extract waypoints from a Vintage Story save file.")
    parser.add_argument("save_file",
                        help="Path to the .vcdbs save file (absolute, relative, or just a filename to search in default VS data dirs)")
    parser.add_argument("--config", "-c", type=str, default=None,
                        help="Path to serverconfig.json (auto-detected from save location if omitted)")
    parser.add_argument("--filter", "-f", type=str, default=None,
                        help="Filter waypoints by title (case-insensitive substring match)")
    parser.add_argument("--icon", "-i", type=str, default=None,
                        help="Filter by icon name (e.g. circle, bee, home)")
    parser.add_argument("--owner", "-o", type=str, default=None,
                        help="Filter by owner player UID (substring match)")
    parser.add_argument("--pinned", "-p", action="store_true", default=False,
                        help="Show only pinned waypoints")
    parser.add_argument("--json", "-j", action="store_true", default=False,
                        help="Output as JSON instead of table")
    parser.add_argument("--output", type=str, default=None,
                        help="Write output to a file instead of stdout")
    args = parser.parse_args()

    # Resolve save file path
    save_path = args.save_file
    if not os.path.isabs(save_path) and not os.path.exists(save_path):
        # Try to find it in known Vintage Story data directories
        for data_dir in _VS_DATA_DIRS:
            candidate = os.path.join(data_dir, "Saves", save_path)
            if os.path.exists(candidate):
                save_path = candidate
                break

    if not os.path.exists(save_path):
        print(f"ERROR: Save file not found: {save_path}", file=sys.stderr)
        print("Searched in:", file=sys.stderr)
        for data_dir in _VS_DATA_DIRS:
            print(f"  {os.path.join(data_dir, 'Saves')}", file=sys.stderr)
        sys.exit(1)

    # Resolve server config
    config_path = args.config
    if config_path is None:
        config_path = find_server_config(save_path)
    if config_path:
        print(f"Config:  {config_path}", file=sys.stderr)
    else:
        print("Config:  not found (using default map size)", file=sys.stderr)

    print(f"Reading: {os.path.basename(save_path)}", file=sys.stderr)

    waypoints = extract_waypoints(save_path, config_path)

    # Apply filters
    if args.filter:
        term = args.filter.lower()
        waypoints = [wp for wp in waypoints if term in wp.get('title', '').lower()]
    if args.icon:
        icon = args.icon.lower()
        waypoints = [wp for wp in waypoints if wp.get('icon', '').lower() == icon]
    if args.owner:
        owner = args.owner.lower()
        waypoints = [wp for wp in waypoints if owner in wp.get('owner', '').lower()]
    if args.pinned:
        waypoints = [wp for wp in waypoints if wp.get('pinned')]

    # Output
    if args.output:
        out_file = open(args.output, 'w', encoding='utf-8')
    else:
        out_file = sys.stdout

    if args.json:
        print(json.dumps(waypoints, indent=2), file=out_file)
    else:
        print_waypoints_table(waypoints, file=out_file)

    if args.output:
        out_file.close()
        print(f"Output:  {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
