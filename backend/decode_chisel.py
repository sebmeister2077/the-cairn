"""Validate chiseled/microblock decoding straight from auction-events.jsonl.

Proves that everything needed to render a chiseled block (geometry `cuboids`,
`materials`, custom `blockName`, `rotation`) is already present in each auction's
`Item.RawHex` — no separate proxy /captures data is required. Also handy as a
quick eyeball of the designs and material palette currently on the market.

Usage:
    python backend/decode_chisel.py                 # default input + registry
    python backend/decode_chisel.py --limit 40      # cap printed designs
    python backend/decode_chisel.py --input path\\to\\auction-events.jsonl
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from process_auction_data import (
    DEFAULT_INPUT,
    DEFAULT_REGISTRY,
    _chisel_signature,
    decode_chisel,
    decode_itemstack,
    load_registry,
    resolve_item,
)


def _self_test() -> None:
    """The attachment's l-dungeon example: cuboids [16773120] with materials
    [263] must decode to a single full (0,0,0)-(16,16,16) cube on material 0."""
    reg = {"Block": {"263": "somerock"}}
    chisel = decode_chisel(
        {"cuboids": [16773120], "materials": [263], "blockName": "l-dungeon", "rotation": 368640},
        reg,
    )
    assert chisel is not None, "expected a chisel payload"
    assert chisel["boxes"] == [
        {"x0": 0, "y0": 0, "z0": 0, "x1": 16, "y1": 16, "z1": 16, "mat": 0}
    ], chisel["boxes"]
    assert chisel["rotationY"] == 0, chisel["rotationY"]
    assert chisel["materials"] == ["somerock"], chisel["materials"]
    assert chisel["blockName"] == "l-dungeon"
    print("[self-test] l-dungeon example decoded correctly (full cube, rotationY 0)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    ap.add_argument("--limit", type=int, default=25, help="max designs to print")
    args = ap.parse_args()

    _self_test()

    if not args.input.exists():
        print(f"[error] input not found: {args.input}")
        return

    registry = load_registry(args.registry)

    total = chiseled = named = 0
    name_counts: Counter[str] = Counter()
    mat_counts: Counter[str] = Counter()
    seen_designs: dict[str, dict] = {}

    with args.input.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            total += 1
            raw = (row.get("Item") or {}).get("RawHex")
            stack = decode_itemstack(raw)
            if stack is None:
                continue
            item = resolve_item(stack, row.get("Item") or {}, {}, registry)
            if item.get("category") not in {"chiseledblock", "microblock"}:
                continue
            chisel = decode_chisel(stack["attributes"] or None, registry)
            if chisel is None:
                continue
            chiseled += 1
            for code in chisel["materials"]:
                mat_counts[code] += 1
            if chisel["blockName"]:
                named += 1
                name_counts[chisel["blockName"]] += 1
                key = f"name:{chisel['blockName'].lower()}"
            else:
                key = f"sig:{_chisel_signature(chisel)}"
            seen_designs.setdefault(key, chisel)

    print(f"\nScanned {total:,} auction rows.")
    print(f"Chiseled/microblock listings decoded: {chiseled:,}")
    print(f"  named designs: {named:,}  |  distinct designs: {len(seen_designs):,}")

    if name_counts:
        print("\nTop custom block names:")
        for name, n in name_counts.most_common(15):
            print(f"  {n:>5}  {name}")

    if mat_counts:
        print("\nTop materials used:")
        for code, n in mat_counts.most_common(15):
            print(f"  {n:>5}  {code}")

    print(f"\nSample designs (up to {args.limit}):")
    for i, (key, chisel) in enumerate(seen_designs.items()):
        if i >= args.limit:
            break
        label = chisel["blockName"] or f"design {key.split(':', 1)[-1]}"
        print(f"  [{label}] {len(chisel['boxes'])} boxes, materials={chisel['materials']}")


if __name__ == "__main__":
    main()
