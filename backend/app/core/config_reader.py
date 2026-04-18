"""Parse serverconfig.json for map size offsets."""

import json


def get_map_offsets(config_content=None):
    """Calculate map center offsets from serverconfig.json content.

    Args:
        config_content: Raw bytes or string of serverconfig.json, or None.

    Returns:
        Tuple of (offset_x, offset_z).
    """
    offset_x = 512000  # default for 1,024,000 map
    offset_z = 512000

    if config_content is None:
        return offset_x, offset_z

    try:
        if isinstance(config_content, bytes):
            config_content = config_content.decode("utf-8")
        config = json.loads(config_content)
        offset_x = config.get("MapSizeX", 1024000) // 2
        offset_z = config.get("MapSizeZ", 1024000) // 2
    except (json.JSONDecodeError, KeyError, ValueError):
        pass

    return offset_x, offset_z
