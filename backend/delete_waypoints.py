# Vintage Story Waypoint Remover
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
Vintage Story Waypoint Remover
Removes waypoints from a .vcdbs save file. By default removes all waypoints.
Use filter options to selectively remove only matching waypoints.

Usage:
    python delete_waypoints.py <save_file>
    python delete_waypoints.py <save_file> --filter "trader"
    python delete_waypoints.py <save_file> --icon circle --unpinned
    python delete_waypoints.py <save_file> --dry-run
"""

import sqlite3
import struct
import argparse
import json
import os
import sys
import shutil
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

        fields.setdefault(field_number, []).append((wire_type, value))

    return fields


def parse_protobuf_raw(data):
    """Parse protobuf bytes, preserving raw field entries in order."""
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
    if value < 0:
        value = value + (1 << 64)
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def encode_tag(field_number, wire_type):
    return encode_varint((field_number << 3) | wire_type)


def encode_bytes_field(field_number, data):
    return encode_tag(field_number, 2) + encode_varint(len(data)) + data


def encode_field(field_number, wire_type, value):
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


# ─── Waypoint decoder (lightweight) ──────────────────────────────────────────

def decode_color(varint_val):
    if varint_val >= (1 << 63):
        varint_val -= (1 << 64)
    return varint_val


def color_to_hex(color_int):
    color_uint = color_int & 0xFFFFFFFF
    return f"#{color_uint:08X}"


def decode_position(pos_bytes):
    fields = parse_protobuf_fields(pos_bytes)
    x = y = z = 0.0
    if 1 in fields:
        x = struct.unpack('<d', fields[1][0][1])[0]
    if 2 in fields:
        y = struct.unpack('<d', fields[2][0][1])[0]
    if 3 in fields:
        z = struct.unpack('<d', fields[3][0][1])[0]
    return x, y, z


def decode_waypoint_summary(wp_bytes):
    """Decode enough waypoint fields for filtering decisions."""
    fields = parse_protobuf_fields(wp_bytes)
    wp = {}

    if 1 in fields:
        wp['color'] = color_to_hex(decode_color(fields[1][0][1]))
    if 2 in fields:
        wp['icon'] = fields[2][0][1].decode('utf-8', errors='replace')
    if 4 in fields:
        wp['owner'] = fields[4][0][1].decode('utf-8', errors='replace')
    if 5 in fields:
        wp['pinned'] = bool(fields[5][0][1])
    if 6 in fields:
        x, y, z = decode_position(fields[6][0][1])
        wp['x'] = x
        wp['y'] = y
        wp['z'] = z
    if 10 in fields:
        wp['title'] = fields[10][0][1].decode('utf-8', errors='replace')
    if 11 in fields:
        wp['guid'] = fields[11][0][1].decode('utf-8', errors='replace')

    return wp


# ─── Server config / coordinate helpers ──────────────────────────────────────

def find_server_config(save_path):
    saves_dir = os.path.dirname(os.path.abspath(save_path))
    data_dir = os.path.dirname(saves_dir)
    candidate = os.path.join(data_dir, "serverconfig.json")
    if os.path.isfile(candidate):
        return candidate
    return None


def get_map_offsets(config_path=None):
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
    conn = sqlite3.connect(save_path)
    cur = conn.cursor()
    cur.execute("SELECT data FROM gamedata WHERE savegameid=1")
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return row[0]


def write_gamedata(save_path, data):
    conn = sqlite3.connect(save_path)
    cur = conn.cursor()
    cur.execute("UPDATE gamedata SET data=? WHERE savegameid=1", (data,))
    conn.commit()
    conn.close()


def rebuild_gamedata(original_data, new_markers_bytes):
    """Rebuild the gamedata blob with new markers data."""
    outer_entries = parse_protobuf_raw(original_data)
    output = b""

    replaced = False
    for field_number, wire_type, value in outer_entries:
        if field_number == 11 and wire_type == 2 and not replaced:
            entry_fields = parse_protobuf_fields(value)
            key = ""
            if 1 in entry_fields:
                key = entry_fields[1][0][1].decode("utf-8", errors="replace")
            if key == "playerMapMarkers_v2":
                new_entry = b""
                new_entry += encode_bytes_field(1, b"playerMapMarkers_v2")
                new_entry += encode_bytes_field(2, new_markers_bytes)
                output += encode_field(field_number, wire_type, new_entry)
                replaced = True
                continue

        output += encode_field(field_number, wire_type, value)

    return output


def encode_markers(waypoint_bytes_list):
    data = b""
    for wp_bytes in waypoint_bytes_list:
        data += encode_bytes_field(1, wp_bytes)
    return data


# ─── Matching logic ──────────────────────────────────────────────────────────

def waypoint_matches(wp, args, offset_x, offset_z):
    """Return True if the waypoint matches ALL provided filter criteria.
    
    A waypoint with no filters active always matches (i.e. will be deleted).
    """
    if args.filter:
        if args.filter.lower() not in wp.get("title", "").lower():
            return False

    if args.icon:
        if wp.get("icon", "").lower() != args.icon.lower():
            return False

    if args.owner:
        if args.owner.lower() not in wp.get("owner", "").lower():
            return False

    if args.pinned and args.unpinned:
        pass  # both set = no pin filter
    elif args.pinned:
        if not wp.get("pinned"):
            return False
    elif args.unpinned:
        if wp.get("pinned"):
            return False

    if args.color:
        if wp.get("color", "").upper() != args.color.upper().lstrip("#"):
            # Normalize both to compare
            wp_color = wp.get("color", "").upper().lstrip("#")
            arg_color = args.color.upper().lstrip("#")
            if wp_color != arg_color:
                return False

    if args.guid:
        if wp.get("guid", "").lower() != args.guid.lower():
            return False

    return True


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Remove waypoints from a Vintage Story save file. "
                    "By default removes ALL waypoints. Use filters to target specific ones."
    )
    parser.add_argument(
        "save_file",
        help="Path to the .vcdbs save file"
    )

    filt = parser.add_argument_group("filters", "Narrow which waypoints to delete. "
                                     "When no filters are set, ALL waypoints are removed.")
    filt.add_argument(
        "--filter", "-f", type=str, default=None,
        help="Delete waypoints whose title contains this term (case-insensitive)"
    )
    filt.add_argument(
        "--icon", "-i", type=str, default=None,
        help="Delete waypoints with this icon (e.g. circle, bee, home)"
    )
    filt.add_argument(
        "--owner", "-o", type=str, default=None,
        help="Delete waypoints owned by this player UID (substring match)"
    )
    filt.add_argument(
        "--pinned", action="store_true", default=False,
        help="Delete only pinned waypoints"
    )
    filt.add_argument(
        "--unpinned", action="store_true", default=False,
        help="Delete only unpinned waypoints"
    )
    filt.add_argument(
        "--color", type=str, default=None,
        help="Delete waypoints with this color (e.g. #FFFF6600)"
    )
    filt.add_argument(
        "--guid", type=str, default=None,
        help="Delete the single waypoint with this exact GUID"
    )

    parser.add_argument(
        "--config", "-c", type=str, default=None,
        help="Path to serverconfig.json (auto-detected from save location if omitted)"
    )
    parser.add_argument(
        "--no-backup", action="store_true", default=False,
        help="Skip creating a backup of the save file"
    )
    parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Show what would be deleted without modifying the save"
    )
    args = parser.parse_args()

    # ── Resolve save file ──
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

    # ── Resolve config ──
    config_path = args.config
    if config_path is None:
        config_path = find_server_config(save_path)
    offset_x, offset_z = get_map_offsets(config_path)

    # ── Read existing waypoints ──
    original_data = read_gamedata(save_path)
    if original_data is None:
        print("ERROR: No gamedata found in save.", file=sys.stderr)
        sys.exit(1)

    outer_fields = parse_protobuf_fields(original_data)
    markers_data = None
    if 11 in outer_fields:
        for _, entry_bytes in outer_fields[11]:
            entry_fields = parse_protobuf_fields(entry_bytes)
            key = ""
            if 1 in entry_fields:
                key = entry_fields[1][0][1].decode("utf-8", errors="replace")
            if key == "playerMapMarkers_v2" and 2 in entry_fields:
                markers_data = entry_fields[2][0][1]
                break

    if not markers_data:
        print("No waypoints found in save.", file=sys.stderr)
        sys.exit(0)

    # Parse individual waypoints (keep raw bytes for survivors)
    marker_fields = parse_protobuf_fields(markers_data)
    raw_waypoints = []  # list of (decoded_summary, raw_bytes)
    if 1 in marker_fields:
        for _, wp_bytes in marker_fields[1]:
            try:
                summary = decode_waypoint_summary(wp_bytes)
                # Convert coords for display
                display = dict(summary)
                if 'x' in display:
                    display['x'] = display['x'] - offset_x
                if 'z' in display:
                    display['z'] = display['z'] - offset_z
                raw_waypoints.append((summary, display, wp_bytes))
            except Exception as e:
                print(f"WARNING: Failed to decode a waypoint: {e}", file=sys.stderr)
                raw_waypoints.append(({}, {}, wp_bytes))

    # ── Determine which to delete vs keep ──
    has_filters = any([args.filter, args.icon, args.owner, args.pinned, args.unpinned, args.color, args.guid])

    to_delete = []
    to_keep = []
    for summary, display, wp_bytes in raw_waypoints:
        if waypoint_matches(summary, args, offset_x, offset_z):
            to_delete.append((summary, display, wp_bytes))
        else:
            to_keep.append((summary, display, wp_bytes))

    # ── Summary ──
    print(f"\nSave:    {os.path.basename(save_path)}", file=sys.stderr)
    if has_filters:
        print(f"Filters: ", end="", file=sys.stderr)
        parts = []
        if args.filter:
            parts.append(f"title contains \"{args.filter}\"")
        if args.icon:
            parts.append(f"icon={args.icon}")
        if args.owner:
            parts.append(f"owner contains \"{args.owner}\"")
        if args.pinned:
            parts.append("pinned only")
        if args.unpinned:
            parts.append("unpinned only")
        if args.color:
            parts.append(f"color={args.color}")
        if args.guid:
            parts.append(f"guid={args.guid}")
        print(", ".join(parts), file=sys.stderr)
    else:
        print("Filters: none (deleting ALL waypoints)", file=sys.stderr)

    print(f"\nTotal waypoints:   {len(raw_waypoints)}", file=sys.stderr)
    print(f"To be deleted:     {len(to_delete)}", file=sys.stderr)
    print(f"Remaining after:   {len(to_keep)}", file=sys.stderr)

    if to_delete:
        print(f"\nWaypoints to delete:", file=sys.stderr)
        for _, display, _ in to_delete:
            title = display.get("title", "???")
            icon = display.get("icon", "?")
            x = display.get("x", 0)
            y = display.get("y", 0)
            z = display.get("z", 0)
            pinned = "pinned" if display.get("pinned") else "unpinned"
            print(f"  - {title}  ({icon}, {x:.0f} {y:.0f} {z:.0f}, {pinned})", file=sys.stderr)

    if not to_delete:
        print("\nNo waypoints matched the filters. Nothing to do.", file=sys.stderr)
        sys.exit(0)

    if args.dry_run:
        print(f"\n[DRY RUN] No changes were made.", file=sys.stderr)
        sys.exit(0)

    # ── Backup ──
    if not args.no_backup:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = save_path + f".backup_{timestamp}"
        shutil.copy2(save_path, backup_path)
        print(f"\nBackup:  {backup_path}", file=sys.stderr)

    # ── Write ──
    surviving_bytes = [wp_bytes for _, _, wp_bytes in to_keep]
    new_markers = encode_markers(surviving_bytes)
    new_data = rebuild_gamedata(original_data, new_markers)
    write_gamedata(save_path, new_data)

    print(f"Done! Deleted {len(to_delete)} waypoints. {len(to_keep)} remaining.", file=sys.stderr)


if __name__ == "__main__":
    main()
