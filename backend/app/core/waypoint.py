"""Waypoint encode/decode, filtering, and command generation."""

import struct
import uuid

from .protobuf import (
    parse_protobuf_fields,
    encode_varint_field,
    encode_bytes_field,
    encode_double_field,
)


# ─── Decode helpers ───────────────────────────────────────────────────────────

def decode_color(varint_val):
    """Convert protobuf varint (unsigned) to ARGB color int."""
    if varint_val >= (1 << 63):
        varint_val -= (1 << 64)
    return varint_val


def color_to_hex(color_int):
    """Convert signed int color to #AARRGGBB hex string."""
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
    """Decode a single waypoint protobuf message into a dict."""
    fields = parse_protobuf_fields(wp_bytes)
    wp = {}

    if 1 in fields:
        wp['color'] = color_to_hex(decode_color(fields[1][0][1]))
    if 2 in fields:
        wp['icon'] = fields[2][0][1].decode('utf-8', errors='replace')
    if 3 in fields:
        val = fields[3][0][1]
        if val >= (1 << 63):
            val -= (1 << 64)
        wp['field3'] = val
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


# ─── Encode helpers ───────────────────────────────────────────────────────────

def hex_to_color_varint(color_hex):
    """Convert #AARRGGBB hex string to the unsigned varint value used in protobuf."""
    color_uint = int(color_hex.lstrip("#"), 16) & 0xFFFFFFFF
    if color_uint >= 0x80000000:
        color_signed = color_uint - 0x100000000
    else:
        color_signed = color_uint
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

    if "color" in wp:
        color_val = hex_to_color_varint(wp["color"])
        data += encode_varint_field(1, color_val)

    icon = wp.get("icon", "circle")
    data += encode_bytes_field(2, icon.encode("utf-8"))

    if "field3" in wp:
        val = wp["field3"]
        if val < 0:
            val = val + (1 << 64)
        data += encode_varint_field(3, val)

    if "owner" in wp:
        data += encode_bytes_field(4, wp["owner"].encode("utf-8"))

    if "pinned" in wp:
        data += encode_varint_field(5, 1 if wp["pinned"] else 0)

    x = wp.get("x", 0.0)
    y = wp.get("y", 0.0)
    z = wp.get("z", 0.0)
    pos_bytes = encode_position(x, y, z)
    data += encode_bytes_field(6, pos_bytes)

    if "title" in wp:
        data += encode_bytes_field(10, wp["title"].encode("utf-8"))

    guid = wp.get("guid", str(uuid.uuid4()))
    data += encode_bytes_field(11, guid.encode("utf-8"))

    return data


# ─── Filtering ────────────────────────────────────────────────────────────────

def filter_waypoints(waypoints, *, title=None, icon=None, owner=None,
                     pinned=None, color=None, guid=None):
    """Filter a list of waypoint dicts. Returns matching waypoints."""
    result = waypoints
    if title:
        term = title.lower()
        result = [wp for wp in result if term in wp.get('title', '').lower()]
    if icon:
        icon_lower = icon.lower()
        result = [wp for wp in result if wp.get('icon', '').lower() == icon_lower]
    if owner:
        owner_lower = owner.lower()
        result = [wp for wp in result if owner_lower in wp.get('owner', '').lower()]
    if pinned is not None:
        result = [wp for wp in result if wp.get('pinned', False) == pinned]
    if color:
        color_upper = color.upper().lstrip("#")
        result = [wp for wp in result if wp.get('color', '').upper().lstrip("#") == color_upper]
    if guid:
        guid_lower = guid.lower()
        result = [wp for wp in result if wp.get('guid', '').lower() == guid_lower]
    return result


def waypoint_matches_delete(wp, *, title=None, icon=None, owner=None,
                            pinned_only=False, unpinned_only=False,
                            color=None, guid=None):
    """Return True if a waypoint matches ALL provided delete criteria.

    With no criteria, everything matches (will be deleted).
    """
    if title:
        if title.lower() not in wp.get("title", "").lower():
            return False
    if icon:
        if wp.get("icon", "").lower() != icon.lower():
            return False
    if owner:
        if owner.lower() not in wp.get("owner", "").lower():
            return False
    if pinned_only and unpinned_only:
        pass  # both set = no pin filter
    elif pinned_only:
        if not wp.get("pinned"):
            return False
    elif unpinned_only:
        if wp.get("pinned"):
            return False
    if color:
        wp_color = wp.get("color", "").upper().lstrip("#")
        arg_color = color.upper().lstrip("#")
        if wp_color != arg_color:
            return False
    if guid:
        if wp.get("guid", "").lower() != guid.lower():
            return False
    return True


# ─── Command generation ──────────────────────────────────────────────────────

def color_hex_to_vs(color_hex):
    """Convert #AARRGGBB hex to VS signed 32-bit color int."""
    color_uint = int(color_hex.lstrip("#"), 16) & 0xFFFFFFFF
    if color_uint >= 0x80000000:
        return color_uint - 0x100000000
    return color_uint


def generate_command(wp):
    """Generate a /waypoint addati command for a single waypoint."""
    icon = wp.get("icon", "circle")
    x = int(round(wp.get("x", 0)))
    y = int(round(wp.get("y", 0)))
    z = int(round(wp.get("z", 0)))
    pinned = str(wp.get("pinned", False)).lower()
    color = color_hex_to_vs(wp.get("color", "#FFFFFFFF"))
    title = wp.get("title", "Waypoint")
    return f"/waypoint addati {icon} {x} {y} {z} {pinned} {color} {title}"
