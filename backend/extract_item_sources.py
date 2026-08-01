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

# Pool labels come straight from the game's lang file (`item-stackrandomizer-<pool>`,
# e.g. "Cloth randomizer (High status)") so they read exactly like the in-game
# handbook / Extra Info mod. See `pool_label()`.

# Rarity buckets by best (max) per-pool drop chance, in percent.
RARITY_THRESHOLDS = [
    (12.0, "common"),
    (5.0, "uncommon"),
    (1.5, "rare"),
    (0.5, "very_rare"),
    (0.0, "legendary"),
]

# The Lazaret chest can only be looted once per server, so an item found ONLY
# there is effectively legendary. When the same item also drops from another
# pool (e.g. the Jade amulet is in Accessory (High status) too), that other pool
# drives the rarity and the Lazaret line is kept only as an annotated source.
LAZARET_POOL = "lazaret"

# Items handed to every player as a reward for completing the Lore (not random
# loot), so they aren't rare despite appearing in a randomizer pool. Extend as
# more are found; these render a "Lore reward" chip instead of a rarity/drop %.
LORE_REWARD_CODES = {
    "clothes-butterflypin-alchemical",
    "clothes-butterflypin-darkbluepansy",
}


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


def load_lang(assets_root: Path) -> Dict[str, str]:
    """Game English lang table (strict JSON), used for the randomizer pool names."""
    path = assets_root / "game" / "lang" / "en.json"
    if not path.is_file():
        print(f"[warn] lang file not found at {path} — pool labels will fall back to codes")
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def pool_key(raw_key: str) -> str:
    """`*-cloth-highstatus` -> `cloth-highstatus`."""
    return raw_key.split("-", 1)[1] if raw_key.startswith("*-") else raw_key


def pool_label(pk: str, lang: Dict[str, str]) -> str:
    """In-game randomizer name (e.g. "Cloth randomizer (High status)")."""
    return lang.get(f"item-stackrandomizer-{pk}") or pk.replace("-", " ").title()


def _collect_output_codes(node: object, out: set) -> None:
    """Recursively gather every grid-recipe ``output.code`` in a parsed file."""
    if isinstance(node, dict):
        o = node.get("output")
        if isinstance(o, dict) and isinstance(o.get("code"), str):
            out.add(o["code"])
        for v in node.values():
            _collect_output_codes(v, out)
    elif isinstance(node, list):
        for v in node:
            _collect_output_codes(v, out)


def load_craftable_clothes(assets_root: Path):
    """Set of exact + wildcard-regex clothes codes that have a crafting recipe
    (from ``survival/recipes/grid/clothes/*.json``)."""
    recipe_dir = assets_root / "survival" / "recipes" / "grid" / "clothes"
    exact: set = set()
    patterns: list = []
    if not recipe_dir.is_dir():
        print(f"[warn] clothes recipes not found at {recipe_dir} — craftable flag skipped")
        return exact, patterns
    for path in sorted(recipe_dir.glob("*.json")):
        try:
            data = load_vs_json(path)
        except Exception as exc:  # noqa: BLE001 - a single bad file shouldn't abort
            print(f"[warn] could not parse {path.name}: {exc}")
            continue
        codes: set = set()
        _collect_output_codes(data, codes)
        for raw in codes:
            code = bare_code(raw)
            if not code.startswith("clothes-"):
                continue
            if "{" in code:
                # `{color}` variant placeholder -> match any variant token.
                parts = re.split(r"\{[^}]*\}", code)
                patterns.append(re.compile("^" + "[A-Za-z0-9-]*".join(re.escape(p) for p in parts) + "$"))
            else:
                exact.add(code)
    return exact, patterns


def is_craftable(code: str, exact: set, patterns: list) -> bool:
    return code in exact or any(p.match(code) for p in patterns)



def rarity_for(max_pct: float) -> str:
    for threshold, tier in RARITY_THRESHOLDS:
        if max_pct >= threshold:
            return tier
    return "legendary"


def build(assets_root: Path) -> dict:
    path = assets_root / "survival" / "itemtypes" / "meta" / "stackrandomizer.json"
    if not path.is_file():
        raise SystemExit(f"stackrandomizer not found: {path}")
    data = load_vs_json(path)
    by_type = data.get("attributesByType") or {}
    lang = load_lang(assets_root)
    craft_exact, craft_patterns = load_craftable_clothes(assets_root)

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
        label = pool_label(pk, lang)
        for code, weight in weight_by_code.items():
            sources[code].append({
                "pool": pk,
                "label": label,
                "chancePct": round(weight / total * 100.0, 2),
            })

    items: Dict[str, dict] = {}
    for code in sorted(sources):
        rows = sorted(sources[code], key=lambda r: r["chancePct"], reverse=True)
        # Lore-reward items aren't rare loot: show a chip, hide rarity + drop %.
        if code in LORE_REWARD_CODES:
            items[code] = {"loreReward": True, "rarity": "common", "sources": []}
            continue
        for r in rows:
            if r["pool"] == LAZARET_POOL:
                r["oncePerServer"] = True
        # Lazaret-only -> legendary (once per server); otherwise the non-Lazaret
        # pools decide the tier so a still-findable item keeps its real rarity.
        non_lazaret = [r for r in rows if r["pool"] != LAZARET_POOL]
        rarity = rarity_for(max(r["chancePct"] for r in non_lazaret)) if non_lazaret else "legendary"
        entry: Dict[str, object] = {"rarity": rarity, "sources": rows}
        # Craftable flag only for dungeon-loot clothing that has a recipe.
        if code.startswith("clothes-") and is_craftable(code, craft_exact, craft_patterns):
            entry["craftable"] = True
        items[code] = entry

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
