# Vintage Story Waypoint Command Generator
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
Vintage Story Waypoint Command Generator
Takes JSON output from search_waypoints.py and generates /waypoint commands
that can be pasted into the Vintage Story chat to recreate waypoints.

Usage:
    python generate_commands.py waypoints.json
    python generate_commands.py waypoints.json --filter "iron"
    python generate_commands.py waypoints.json --icon star
    python generate_commands.py waypoints.json -o commands.txt
"""

import json
import argparse
import sys
import os


def color_hex_to_vs(color_hex):
    """Convert #AARRGGBB hex to a Vintage Story color format.
    
    VS /waypoint addati expects color as a signed 32-bit integer.
    """
    # Strip '#' and parse as unsigned 32-bit, then convert to signed
    color_uint = int(color_hex.lstrip("#"), 16) & 0xFFFFFFFF
    if color_uint >= 0x80000000:
        color_int = color_uint - 0x100000000
    else:
        color_int = color_uint
    return color_int


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


def main():
    parser = argparse.ArgumentParser(
        description="Generate Vintage Story /waypoint commands from JSON waypoint data."
    )
    parser.add_argument(
        "input",
        help="Path to JSON file (output from search_waypoints.py --json)"
    )
    parser.add_argument(
        "--output", "-o", type=str, default=None,
        help="Write commands to a file instead of stdout"
    )
    parser.add_argument(
        "--filter", "-f", type=str, default=None,
        help="Only include waypoints whose title contains this term (case-insensitive)"
    )
    parser.add_argument(
        "--icon", "-i", type=str, default=None,
        help="Only include waypoints with this icon"
    )
    parser.add_argument(
        "--pinned", "-p", action="store_true", default=False,
        help="Only include pinned waypoints"
    )
    args = parser.parse_args()

    # Read input JSON
    if not os.path.exists(args.input):
        print(f"ERROR: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    with open(args.input, "r", encoding="utf-8") as f:
        try:
            waypoints = json.load(f)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON: {e}", file=sys.stderr)
            sys.exit(1)

    if not isinstance(waypoints, list):
        print("ERROR: Expected a JSON array of waypoints.", file=sys.stderr)
        sys.exit(1)

    # Apply filters
    if args.filter:
        term = args.filter.lower()
        waypoints = [wp for wp in waypoints if term in wp.get("title", "").lower()]
    if args.icon:
        icon = args.icon.lower()
        waypoints = [wp for wp in waypoints if wp.get("icon", "").lower() == icon]
    if args.pinned:
        waypoints = [wp for wp in waypoints if wp.get("pinned")]

    if not waypoints:
        print("No waypoints matched the filters.", file=sys.stderr)
        sys.exit(0)

    # Generate commands
    commands = [generate_command(wp) for wp in waypoints]

    print(f"Generated {len(commands)} commands.", file=sys.stderr)

    # Output
    output_text = "\n".join(commands) + "\n"
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_text)
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(output_text)


if __name__ == "__main__":
    main()
