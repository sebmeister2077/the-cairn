"""One-shot maintenance script: rewrite the ``label`` field of every
feature in ``traders.geojson`` to the canonical display label for its
``trader_type``.

Background: the Contribute Traders chat-log flow used to forward the
raw in-game waypoint title as the trader's label, producing a salad of
free-text values like ``"Agro"``, ``"TREASURE HUNTER"``,
``"Optal the treasure hunter"``, ``"Building Material"``, etc. The
viewer/tooltip and admin tooling expect a consistent label per type,
so this script normalises the existing file to match
``frontend/src/lib/trader-types.ts`` (``TRADER_TYPE_LABELS``).

Usage::

    # Dry-run (default): prints what would change, writes nothing.
    python standardize_trader_labels.py path/to/traders.geojson

    # Apply in place (writes ``<file>.bak`` next to the original).
    python standardize_trader_labels.py path/to/traders.geojson --write

Re-upload the resulting file to the R2 bucket manually.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

# Must mirror ``TRADER_TYPE_LABELS`` in
# ``frontend/src/lib/trader-types.ts``.
TRADER_TYPE_LABELS: dict[str, str] = {
    "agriculture": "Agriculture",
    "artisan": "Artisan",
    "building_materials": "Building Materials",
    "clothing": "Clothing",
    "commodities": "Commodities",
    "furniture": "Furniture",
    "luxuries": "Luxuries",
    "survival_goods": "Survival Goods",
    "treasure_hunter": "Treasure Hunter",
}


def standardize(data: dict) -> tuple[int, int, list[str]]:
    """Mutate ``data`` in place. Returns (changed, skipped, warnings)."""
    changed = 0
    skipped = 0
    warnings: list[str] = []
    features = data.get("features") or []
    for i, feat in enumerate(features):
        props = feat.get("properties") or {}
        trader_type = props.get("trader_type")
        if trader_type not in TRADER_TYPE_LABELS:
            warnings.append(
                f"feature[{i}] id={props.get('id')!r}: unknown trader_type "
                f"{trader_type!r}; left untouched"
            )
            skipped += 1
            continue
        canonical = TRADER_TYPE_LABELS[trader_type]
        current = props.get("label")
        if current == canonical:
            skipped += 1
            continue
        warnings.append(
            f"feature[{i}] id={props.get('id')!r}: "
            f"{current!r} -> {canonical!r}"
        )
        props["label"] = canonical
        feat["properties"] = props
        changed += 1
    return changed, skipped, warnings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", type=Path, help="Path to traders.geojson")
    ap.add_argument(
        "--write",
        action="store_true",
        help="Write changes back in place (default: dry-run).",
    )
    args = ap.parse_args(argv)

    src: Path = args.path
    if not src.is_file():
        print(f"error: {src} is not a file", file=sys.stderr)
        return 2

    raw = src.read_text(encoding="utf-8")
    data = json.loads(raw)
    changed, skipped, warnings = standardize(data)

    for w in warnings:
        print(w)
    print(
        f"\n{changed} feature(s) would be updated, "
        f"{skipped} left as-is."
    )

    if not args.write:
        print("Dry-run; pass --write to apply.")
        return 0

    if changed == 0:
        print("Nothing to write.")
        return 0

    backup = src.with_suffix(src.suffix + ".bak")
    shutil.copy2(src, backup)
    print(f"Backup written to {backup}")

    with src.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {src}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
