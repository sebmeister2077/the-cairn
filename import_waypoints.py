# Vintage Story Waypoint Importer
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
Vintage Story Waypoint Importer
Takes JSON waypoint data and writes it directly into a .vcdbs save file.

Usage:
    python import_waypoints.py <save_file> <waypoints.json> [options]

Examples:
    python import_waypoints.py myworld.vcdbs waypoints.json
    python import_waypoints.py myworld.vcdbs waypoints.json --mode replace
    python import_waypoints.py myworld.vcdbs waypoints.json --owner "my-player-uid"
    python import_waypoints.py myworld.vcdbs waypoints.json --dry-run
"""

import sqlite3
import struct
import argparse
import json
import os
import sys
import shutil
import uuid
from datetime import datetime


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
        elif wire_type == 1:  # 64-bit
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 2:  # Length-delimited
            length, offset = decode_varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 5:  # 32-bit
            value = data[offset:offset + 4]
            offset += 4
        else:
            break

        fields.setdefault(field_number, []).append((wire_type, value))

    return fields


def parse_protobuf_raw(data):
    """Parse protobuf bytes, preserving raw field entries in order.
    
    Returns a list of (field_number, wire_type, value) tuples.
    """
    entries = []
    offset = 0
    while offset < len(data):
        tag, offset = decode_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == 0:
            value, offset = decode_varint(data, offset)
        elif wire_type == 1:
            value = data[offset:offset + 8]
            offset += 8
        elif wire_type == 2:
            length, offset = decode_varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire_type == 5:
            value = data[offset:offset + 4]
            offset += 4
        else:
            break

        entries.append((field_number, wire_type, value))

    return entries


# ─── Protobuf encoder ────────────────────────────────────────────────────────

def encode_varint(value):
    """Encode an unsigned integer as a protobuf varint."""
    # Handle negative values (signed → unsigned 64-bit two's complement)
    if value < 0:
        value = value + (1 << 64)
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def encode_tag(field_number, wire_type):
    """Encode a protobuf field tag."""
    return encode_varint((field_number << 3) | wire_type)


def encode_varint_field(field_number, value):
    """Encode a varint field (wire type 0)."""
    return encode_tag(field_number, 0) + encode_varint(value)


def encode_bytes_field(field_number, data):
    """Encode a length-delimited field (wire type 2) — bytes, string, or sub-message."""
    return encode_tag(field_number, 2) + encode_varint(len(data)) + data


def encode_double_field(field_number, value):
    """Encode a 64-bit double field (wire type 1)."""
    return encode_tag(field_number, 1) + struct.pack('<d', value)


def encode_field(field_number, wire_type, value):
    """Re-encode a parsed field entry back to bytes."""
    tag = encode_tag(field_number, wire_type)
    if wire_type == 0:
        return tag + encode_varint(value)
    elif wire_type == 1:
        return tag + value
    elif wire_type == 2:
        return tag + encode_varint(len(value)) + value
    elif wire_type == 5:
        return tag + value
    else:
        raise ValueError(f"Unknown wire type: {wire_type}")


# ─── Waypoint encoder ────────────────────────────────────────────────────────

def hex_to_color_varint(color_hex):
    """Convert #AARRGGBB hex string to the unsigned varint value used in protobuf.
    
    The color is stored as a signed 32-bit int encoded as an unsigned varint.
    Negative values use 64-bit two's complement representation.
    """
    color_uint = int(color_hex.lstrip("#"), 16) & 0xFFFFFFFF
    # Convert to signed 32-bit
    if color_uint >= 0x80000000:
        color_signed = color_uint - 0x100000000
    else:
        color_signed = color_uint
    # For varint encoding, negative → large unsigned (two's complement 64-bit)
    if color_signed < 0:
        return color_signed + (1 << 64)
    return color_signed


def encode_position(x, y, z):
    """Encode a position sub-message with double fields for X, Y, Z."""
    data = b""
    data += encode_double_field(1, x)
    data += encode_double_field(2, y)
    data += encode_double_field(3, z)
    return data


def encode_waypoint(wp):
    """Encode a single waypoint dict into protobuf bytes."""
    data = b""

    # Field 1: Color (varint)
    if "color" in wp:
        color_val = hex_to_color_varint(wp["color"])
        data += encode_varint_field(1, color_val)

    # Field 2: Icon (string)
    icon = wp.get("icon", "circle")
    data += encode_bytes_field(2, icon.encode("utf-8"))

    # Field 3: Unknown varint (field3)
    if "field3" in wp:
        val = wp["field3"]
        if val < 0:
            val = val + (1 << 64)
        data += encode_varint_field(3, val)

    # Field 4: OwningPlayerUid (string)
    if "owner" in wp:
        data += encode_bytes_field(4, wp["owner"].encode("utf-8"))

    # Field 5: Pinned (bool/varint)
    if "pinned" in wp:
        data += encode_varint_field(5, 1 if wp["pinned"] else 0)

    # Field 6: Position (sub-message)
    x = wp.get("x", 0.0)
    y = wp.get("y", 0.0)
    z = wp.get("z", 0.0)
    pos_bytes = encode_position(x, y, z)
    data += encode_bytes_field(6, pos_bytes)

    # Field 10: Title (string)
    if "title" in wp:
        data += encode_bytes_field(10, wp["title"].encode("utf-8"))

    # Field 11: Guid (string)
    guid = wp.get("guid", str(uuid.uuid4()))
    data += encode_bytes_field(11, guid.encode("utf-8"))

    return data


def encode_markers(waypoint_bytes_list):
    """Encode the markers container: repeated field 1 = waypoint sub-messages."""
    data = b""
    for wp_bytes in waypoint_bytes_list:
        data += encode_bytes_field(1, wp_bytes)
    return data


# ─── Server config / coordinate helpers ──────────────────────────────────────

def find_server_config(save_path):
    """Locate serverconfig.json based on the save file's location."""
    saves_dir = os.path.dirname(os.path.abspath(save_path))
    data_dir = os.path.dirname(saves_dir)
    candidate = os.path.join(data_dir, "serverconfig.json")
    if os.path.isfile(candidate):
        return candidate
    return None


def get_map_offsets(config_path=None):
    """Read map size from serverconfig.json and return (offset_x, offset_z)."""
    offset_x = 512000
    offset_z = 512000
    if config_path is None:
        return offset_x, offset_z
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
        offset_x = config.get("MapSizeX", 1024000) // 2
        offset_z = config.get("MapSizeZ", 1024000) // 2
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass
    return offset_x, offset_z


# ─── Save file manipulation ──────────────────────────────────────────────────

def read_gamedata(save_path):
    """Read the gamedata blob from the save file."""
    conn = sqlite3.connect(save_path)
    cur = conn.cursor()
    cur.execute("SELECT data FROM gamedata WHERE savegameid=1")
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return row[0]


def write_gamedata(save_path, data):
    """Write the gamedata blob back to the save file."""
    conn = sqlite3.connect(save_path)
    cur = conn.cursor()
    cur.execute("UPDATE gamedata SET data=? WHERE savegameid=1", (data,))
    conn.commit()
    conn.close()


def get_existing_waypoint_bytes(markers_data):
    """Extract the raw protobuf bytes for each existing waypoint from markers data."""
    fields = parse_protobuf_fields(markers_data)
    if 1 in fields:
        return [value for _, value in fields[1]]
    return []


def rebuild_gamedata(original_data, new_markers_bytes):
    """Rebuild the gamedata blob with new markers data.
    
    Preserves all other fields exactly. Replaces the playerMapMarkers_v2 value
    in the field 11 key-value entries.
    """
    outer_entries = parse_protobuf_raw(original_data)
    output = b""

    replaced = False
    for field_number, wire_type, value in outer_entries:
        if field_number == 11 and wire_type == 2 and not replaced:
            # Check if this is the playerMapMarkers_v2 entry
            entry_fields = parse_protobuf_fields(value)
            key = ""
            if 1 in entry_fields:
                key = entry_fields[1][0][1].decode("utf-8", errors="replace")
            if key == "playerMapMarkers_v2":
                # Rebuild this entry with the new markers value
                new_entry = b""
                new_entry += encode_bytes_field(1, b"playerMapMarkers_v2")
                new_entry += encode_bytes_field(2, new_markers_bytes)
                output += encode_field(field_number, wire_type, new_entry)
                replaced = True
                continue

        # Preserve the field as-is
        output += encode_field(field_number, wire_type, value)

    if not replaced:
        # playerMapMarkers_v2 didn't exist yet — append it as a new field 11 entry
        new_entry = b""
        new_entry += encode_bytes_field(1, b"playerMapMarkers_v2")
        new_entry += encode_bytes_field(2, new_markers_bytes)
        output += encode_bytes_field(11, new_entry)

    return output


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Import waypoints from JSON into a Vintage Story save file."
    )
    parser.add_argument(
        "save_file",
        help="Path to the .vcdbs save file (absolute, relative, or filename to search in default VS data dirs)"
    )
    parser.add_argument(
        "waypoints_json",
        help="Path to the JSON file with waypoints (from search_waypoints.py --json)"
    )
    parser.add_argument(
        "--mode", "-m", choices=["append", "replace"], default="append",
        help="'append' adds to existing waypoints (default), 'replace' removes all existing waypoints first"
    )
    parser.add_argument(
        "--owner", type=str, default=None,
        help="Override the owner UID for all imported waypoints"
    )
    parser.add_argument(
        "--new-guids", action="store_true", default=False,
        help="Generate new GUIDs for imported waypoints instead of keeping originals"
    )
    parser.add_argument(
        "--config", "-c", type=str, default=None,
        help="Path to serverconfig.json (auto-detected from save location if omitted)"
    )
    parser.add_argument(
        "--no-backup", action="store_true", default=False,
        help="Skip creating a backup of the save file before modifying"
    )
    parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Show what would be done without modifying the save file"
    )
    args = parser.parse_args()

    # ── Resolve save file path ──
    save_path = args.save_file
    if not os.path.isabs(save_path) and not os.path.exists(save_path):
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

    # ── Read waypoint JSON ──
    if not os.path.exists(args.waypoints_json):
        print(f"ERROR: JSON file not found: {args.waypoints_json}", file=sys.stderr)
        sys.exit(1)

    with open(args.waypoints_json, "r", encoding="utf-8") as f:
        try:
            import_wps = json.load(f)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON: {e}", file=sys.stderr)
            sys.exit(1)

    if not isinstance(import_wps, list):
        print("ERROR: Expected a JSON array of waypoints.", file=sys.stderr)
        sys.exit(1)

    if not import_wps:
        print("No waypoints to import.", file=sys.stderr)
        sys.exit(0)

    # ── Resolve server config for coordinate conversion ──
    config_path = args.config
    if config_path is None:
        config_path = find_server_config(save_path)

    offset_x, offset_z = get_map_offsets(config_path)

    if config_path:
        print(f"Config:  {config_path}", file=sys.stderr)
    else:
        print("Config:  not found (using default map size)", file=sys.stderr)

    # ── Convert in-game coordinates back to internal absolute coordinates ──
    for wp in import_wps:
        if "x" in wp:
            wp["x"] = wp["x"] + offset_x
        if "z" in wp:
            wp["z"] = wp["z"] + offset_z
        if args.owner:
            wp["owner"] = args.owner
        if args.new_guids:
            wp["guid"] = str(uuid.uuid4())

    # ── Read existing save data ──
    original_data = read_gamedata(save_path)
    if original_data is None:
        print("ERROR: No gamedata found in save.", file=sys.stderr)
        sys.exit(1)

    # ── Get existing waypoints (for append mode) ──
    existing_wp_bytes = []
    if args.mode == "append":
        outer_fields = parse_protobuf_fields(original_data)
        if 11 in outer_fields:
            for _, entry_bytes in outer_fields[11]:
                entry_fields = parse_protobuf_fields(entry_bytes)
                key = ""
                if 1 in entry_fields:
                    key = entry_fields[1][0][1].decode("utf-8", errors="replace")
                if key == "playerMapMarkers_v2" and 2 in entry_fields:
                    existing_wp_bytes = get_existing_waypoint_bytes(entry_fields[2][0][1])
                    break

    # ── Encode new waypoints ──
    new_wp_bytes = [encode_waypoint(wp) for wp in import_wps]

    if args.mode == "append":
        all_wp_bytes = existing_wp_bytes + new_wp_bytes
    else:
        all_wp_bytes = new_wp_bytes

    new_markers = encode_markers(all_wp_bytes)

    # ── Summary ──
    print(f"\nSave:    {os.path.basename(save_path)}", file=sys.stderr)
    print(f"Mode:    {args.mode}", file=sys.stderr)
    print(f"Existing waypoints: {len(existing_wp_bytes)}", file=sys.stderr)
    print(f"Importing:          {len(new_wp_bytes)}", file=sys.stderr)
    print(f"Total after import: {len(all_wp_bytes)}", file=sys.stderr)

    if args.dry_run:
        print("\n[DRY RUN] No changes were made.", file=sys.stderr)
        sys.exit(0)

    # ── Backup ──
    if not args.no_backup:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = save_path + f".backup_{timestamp}"
        shutil.copy2(save_path, backup_path)
        print(f"Backup:  {backup_path}", file=sys.stderr)

    # ── Write ──
    new_data = rebuild_gamedata(original_data, new_markers)
    write_gamedata(save_path, new_data)

    print(f"\nDone! {len(new_wp_bytes)} waypoints imported.", file=sys.stderr)


if __name__ == "__main__":
    main()
