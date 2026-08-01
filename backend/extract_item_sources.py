"""Extract item loot sources + a derived rarity tier from the Vintage Story
``ItemStackRandomizer`` game asset into a static JSON the Market Item page uses.

Source: ``<assets>/survival/itemtypes/meta/stackrandomizer.json``. It defines a
set of named loot pools (``attributesByType["*-<pool>"]``), each a weighted list
of ``{type, code, chance}`` stacks. An item's drop chance within a pool is its
weight over the pool's total weight; ruin chests draw from these pools.

Rarity tier is derived from the best (highest) per-pool drop chance an item has.

Output: ``frontend/src/assets/GameData/item-sources.json`` keyed by bare item
code (domain prefix stripped), matching the item catalog's ``code`` field.

Run: ``python backend/extract_item_sources.py`` (auto-detects %APPDATA%) or
``--assets-root "<path>/assets"``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "frontend" / "src" / "assets" / "GameData" / "item-sources.json"

# Human labels for the stackrandomizer pools (bare pool code, no "*-" prefix).
# The status tiers are the loot placed in ruin/story-structure chests.
POOL_LABELS: Dict[str, str] = {
    "cloth-lowstatus": "Low-status ruin chest (clothing)",
    "cloth-mediumstatus": "Medium-status ruin chest (clothing)",
    "cloth-highstatus": "High-status ruin chest (clothing)",
    "accessory-lowstatus": "Low-status ruin chest (accessory)",
    "accessory-mediumstatus": "Medium-status ruin chest (accessory)",
    "accessory-highstatus": "High-status ruin chest (accessory)",
    "lore-villager": "Ruin bookshelf (villager lore)",
    "lore-tobias": "Ruin bookshelf (Tobias' notes)",
    "lore-research": "Ruin bookshelf (research)",
    "lore-diaries": "Ruin bookshelf (diaries)",
    "lore-jonas": "Ruin bookshelf (Jonas lore)",
    "gear": "Loot cache (temporal gears)",
    "ore": "Loot cache (ore)",
    "fuel": "Loot cache (fuel)",
    "ingot": "Loot cache (metal ingots)",
    "seed": "Loot cache (seeds)",
    "coppertool": "Ruined tool cache (copper)",
    "copperweapon": "Ruined weapon cache (copper)",
    "ruinedweapon": "Ruined weapon cache",
    "resource": "Loot cache (resources)",
    "tuningcylinder": "Loot cache (tuning cylinders)",
    "lantern": "Loot cache (lanterns)",
    "painting": "Loot cache (paintings)",
    "jonasparts": "Jonas locus (parts)",
    "jonasframes": "Jonas locus (frames)",
    "alljonas": "Jonas locus",
    "materials-building": "Loot cache (building materials)",
    "materials-mining": "Loot cache (mining materials)",
    "kitchen": "Loot cache (kitchenware)",
    "armor": "Ruin armor cache",
    "lazaret": "Lazaret cache",
    "butterfly": "Butterfly jar",
    "theater": "Theater cache",
}

# Rarity buckets by best (max) per-pool drop chance, in percent.
RARITY_THRESHOLDS = [
    (12.0, "common"),
    (5.0, "uncommon"),
    (1.5, "rare"),
    (0.0, "very_rare"),
]


def default_assets_root() -> Optional[Path]:
    appdata = os.environ.get("APPDATA")
    if appdata:
        cand = Path(appdata) / "Vintagestory" / "assets"
        if cand.is_dir():
            return cand
    return None


def load_vs_json(path: Path) -> dict:
    """Parse a relaxed Vintage Story asset file (comments, trailing commas and
    unquoted object keys)."""
    text = path.read_text(encoding="utf-8-sig")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"(?m)//.*$", "", text)
    # Quote bare identifier keys that follow '{' or ',' (skips already-quoted keys).
    text = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*):", r'\1"\2"\3:', text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


def bare_code(code: str) -> str:
    return code.split(":", 1)[-1].strip()


def pool_key(raw_key: str) -> str:
    """`*-cloth-highstatus` -> `cloth-highstatus`."""
    return raw_key.split("-", 1)[1] if raw_key.startswith("*-") else raw_key


def rarity_for(max_pct: float) -> str:
    for threshold, tier in RARITY_THRESHOLDS:
        if max_pct >= threshold:
            return tier
    return "very_rare"


def build(assets_root: Path) -> dict:
    path = assets_root / "survival" / "itemtypes" / "meta" / "stackrandomizer.json"
    if not path.is_file():
        raise SystemExit(f"stackrandomizer not found: {path}")
    data = load_vs_json(path)
    by_type = data.get("attributesByType") or {}

    # code -> list of {pool, label, chancePct}
    sources: Dict[str, List[dict]] = defaultdict(list)

    for raw_key, pool in by_type.items():
        stacks = (pool or {}).get("stacks") or []
        # Sum weights per code so multi-variant entries collapse into one chance.
        weight_by_code: Dict[str, float] = defaultdict(float)
        total = 0.0
        for st in stacks:
            code = st.get("code")
            chance = float(st.get("chance", 0) or 0)
            if not code or chance <= 0:
                continue
            weight_by_code[bare_code(code)] += chance
            total += chance
        if total <= 0:
            continue
        pk = pool_key(raw_key)
        label = POOL_LABELS.get(pk, pk.replace("-", " ").title())
        for code, weight in weight_by_code.items():
            sources[code].append({
                "pool": pk,
                "label": label,
                "chancePct": round(weight / total * 100.0, 2),
            })

    items: Dict[str, dict] = {}
    for code in sorted(sources):
        rows = sorted(sources[code], key=lambda r: r["chancePct"], reverse=True)
        max_pct = rows[0]["chancePct"]
        items[code] = {"rarity": rarity_for(max_pct), "sources": rows}

    return {
        "generatedUtc": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "source": "vintagestory/assets/survival/itemtypes/meta/stackrandomizer.json",
        "poolCount": len(by_type),
        "items": items,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--assets-root", type=Path, default=None,
                    help="Path to the game 'assets' dir (defaults to %APPDATA%/Vintagestory/assets).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output JSON path.")
    args = ap.parse_args()

    assets_root: Optional[Path] = args.assets_root or default_assets_root()
    if not assets_root or not assets_root.is_dir():
        raise SystemExit("could not locate game assets; pass --assets-root <path>/assets")

    result = build(assets_root)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] {len(result['items'])} item codes from {result['poolCount']} loot pools -> {args.out}")


if __name__ == "__main__":
    main()
