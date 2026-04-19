"""Read/write gamedata blobs from .vcdbs SQLite databases (in-memory)."""

import io
import sqlite3
import uuid

from .protobuf import (
    parse_protobuf_fields,
    parse_protobuf_raw,
    encode_bytes_field,
    encode_field,
)
from .waypoint import decode_waypoint, encode_waypoint


def read_gamedata_blob(save_bytes):
    """Read the gamedata blob from an in-memory .vcdbs file.

    Args:
        save_bytes: Raw bytes of the .vcdbs SQLite file.

    Returns:
        The raw gamedata blob (bytes), or None if not found.
    """
    import tempfile
    import os

    fd, tmp_path = tempfile.mkstemp(suffix=".vcdbs")
    conn = None
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(save_bytes)
        conn = sqlite3.connect(tmp_path)
        cur = conn.cursor()
        cur.execute("SELECT data FROM gamedata WHERE savegameid=1")
        row = cur.fetchone()
        conn.close()
        conn = None
        if not row:
            return None
        return row[0]
    finally:
        if conn is not None:
            conn.close()
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def write_gamedata_blob(save_bytes, new_data):
    """Write a new gamedata blob into an in-memory .vcdbs file.

    Args:
        save_bytes: Original raw bytes of the .vcdbs SQLite file.
        new_data: The new gamedata blob to write.

    Returns:
        Modified .vcdbs file as bytes.
    """
    import tempfile
    import os

    fd, tmp_path = tempfile.mkstemp(suffix=".vcdbs")
    conn = None
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(save_bytes)
        conn = sqlite3.connect(tmp_path)
        cur = conn.cursor()
        cur.execute("UPDATE gamedata SET data=? WHERE savegameid=1", (new_data,))
        conn.commit()
        conn.close()
        conn = None
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if conn is not None:
            conn.close()
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def extract_markers_data(gamedata_blob):
    """Find and return the raw playerMapMarkers_v2 bytes from a gamedata blob.

    Returns:
        The markers data bytes, or None if not found.
    """
    outer_fields = parse_protobuf_fields(gamedata_blob)
    if 11 in outer_fields:
        for _, entry_bytes in outer_fields[11]:
            entry_fields = parse_protobuf_fields(entry_bytes)
            key = ""
            if 1 in entry_fields:
                key = entry_fields[1][0][1].decode("utf-8", errors="replace")
            if key == "playerMapMarkers_v2" and 2 in entry_fields:
                return entry_fields[2][0][1]
    return None


def get_existing_waypoint_bytes(markers_data):
    """Extract the raw protobuf bytes for each existing waypoint."""
    fields = parse_protobuf_fields(markers_data)
    if 1 in fields:
        return [value for _, value in fields[1]]
    return []


def extract_waypoints_from_blob(gamedata_blob, offset_x, offset_z):
    """Extract all waypoints from a gamedata blob, applying coordinate offsets.

    Returns a list of waypoint dicts with in-game coordinates.
    """
    markers_data = extract_markers_data(gamedata_blob)
    if not markers_data:
        return []

    waypoints = []
    marker_fields = parse_protobuf_fields(markers_data)
    if 1 in marker_fields:
        for _, wp_bytes in marker_fields[1]:
            try:
                wp = decode_waypoint(wp_bytes)
                if 'x' in wp:
                    wp['x'] = wp['x'] - offset_x
                if 'z' in wp:
                    wp['z'] = wp['z'] - offset_z
                waypoints.append(wp)
            except Exception:
                pass  # Skip malformed waypoints

    return waypoints


def encode_markers(waypoint_bytes_list):
    """Encode the markers container: repeated field 1 = waypoint sub-messages."""
    data = b""
    for wp_bytes in waypoint_bytes_list:
        data += encode_bytes_field(1, wp_bytes)
    return data


def rebuild_gamedata(original_data, new_markers_bytes):
    """Rebuild the gamedata blob with new markers data.

    Preserves all other fields exactly. Replaces the playerMapMarkers_v2 value.
    """
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

    if not replaced:
        new_entry = b""
        new_entry += encode_bytes_field(1, b"playerMapMarkers_v2")
        new_entry += encode_bytes_field(2, new_markers_bytes)
        output += encode_bytes_field(11, new_entry)

    return output


def import_waypoints_into_blob(save_bytes, waypoints, offset_x, offset_z,
                                mode="append", owner=None, new_guids=False):
    """Import waypoints into a .vcdbs file (in memory).

    Args:
        save_bytes: Raw bytes of the .vcdbs file.
        waypoints: List of waypoint dicts (in-game coordinates).
        offset_x, offset_z: Map center offsets.
        mode: 'append' or 'replace'.
        owner: Override owner UID for all waypoints.
        new_guids: Generate new GUIDs if True.

    Returns:
        Tuple of (modified_save_bytes, existing_count, imported_count).
    """
    # Convert in-game coords back to internal absolute coords
    for wp in waypoints:
        if "x" in wp:
            wp["x"] = wp["x"] + offset_x
        if "z" in wp:
            wp["z"] = wp["z"] + offset_z
        if owner:
            wp["owner"] = owner
        if new_guids:
            wp["guid"] = str(uuid.uuid4())

    gamedata_blob = read_gamedata_blob(save_bytes)
    if gamedata_blob is None:
        raise ValueError("No gamedata found in save file")

    # Get existing waypoints for append mode
    existing_wp_bytes = []
    if mode == "append":
        markers_data = extract_markers_data(gamedata_blob)
        if markers_data:
            existing_wp_bytes = get_existing_waypoint_bytes(markers_data)

    new_wp_bytes = [encode_waypoint(wp) for wp in waypoints]

    if mode == "append":
        all_wp_bytes = existing_wp_bytes + new_wp_bytes
    else:
        all_wp_bytes = new_wp_bytes

    new_markers = encode_markers(all_wp_bytes)
    new_gamedata = rebuild_gamedata(gamedata_blob, new_markers)
    modified_save = write_gamedata_blob(save_bytes, new_gamedata)

    return modified_save, len(existing_wp_bytes), len(new_wp_bytes)


def delete_waypoints_from_blob(save_bytes, offset_x, offset_z, *,
                                title=None, icon=None, owner=None,
                                pinned_only=False, unpinned_only=False,
                                color=None, guid=None):
    """Delete matching waypoints from a .vcdbs file (in memory).

    Returns:
        Tuple of (modified_save_bytes, deleted_count, remaining_count,
                  deleted_waypoints, remaining_waypoints).
    """
    from .waypoint import waypoint_matches_delete

    gamedata_blob = read_gamedata_blob(save_bytes)
    if gamedata_blob is None:
        raise ValueError("No gamedata found in save file")

    markers_data = extract_markers_data(gamedata_blob)
    if not markers_data:
        return save_bytes, 0, 0, [], []

    marker_fields = parse_protobuf_fields(markers_data)
    if 1 not in marker_fields:
        return save_bytes, 0, 0, [], []

    to_keep_bytes = []
    deleted_wps = []
    kept_wps = []

    for _, wp_bytes in marker_fields[1]:
        try:
            summary = decode_waypoint(wp_bytes)
            display = dict(summary)
            if 'x' in display:
                display['x'] = display['x'] - offset_x
            if 'z' in display:
                display['z'] = display['z'] - offset_z

            if waypoint_matches_delete(summary, title=title, icon=icon,
                                        owner=owner, pinned_only=pinned_only,
                                        unpinned_only=unpinned_only,
                                        color=color, guid=guid):
                deleted_wps.append(display)
            else:
                to_keep_bytes.append(wp_bytes)
                kept_wps.append(display)
        except Exception:
            to_keep_bytes.append(wp_bytes)  # Preserve malformed entries

    new_markers = encode_markers(to_keep_bytes)
    new_gamedata = rebuild_gamedata(gamedata_blob, new_markers)
    modified_save = write_gamedata_blob(save_bytes, new_gamedata)

    return modified_save, len(deleted_wps), len(to_keep_bytes), deleted_wps, kept_wps
