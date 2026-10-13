"""Extract every weighted loot pool (and a per-item rarity tier) from the Vintage
Story loot assets into a static, pool-centric JSON the "Loot Pool" rarity page
reads.

Unlike ``extract_item_sources.py`` (which is item-centric and only covers the
main ruins ``stackrandomizer.json``), this walks ALL the game's weighted loot
tables and keeps them grouped by pool:

* ``itemtypes/meta/stackrandomizer.json``          -> ruins loot randomizers
* ``itemtypes/meta/stackrandomizer-clutter.json``  -> story-structure clutter
* ``itemtypes/meta/stackrandomizer-library.json``  -> library randomizer
* ``itemtypes/meta/stackrandomizer-mines.json``    -> abandoned-mine randomizer
* ``blocktypes/clay/lootvessel.json``              -> cracked loot vessels

Fishing (basket traps) is intentionally excluded: it draws by food-tag / bait
weight rather than a weighted item table, so it has no comparable rarity pool.

Output: ``frontend/src/assets/GameData/loot-pools.json``.

Run: ``python backend/extract_loot_pools.py`` (auto-detects %APPDATA%) or
``--assets-root "<path>/assets"``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

from extract_item_sources import (
    DEFAULT_OUT as ITEM_SOURCES_OUT,
    bare_code,
    default_assets_root,
    load_lang,
    load_vs_json,
    pool_key,
    rarity_for,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ITEM_SOURCES_OUT.parent / "loot-pools.json"

# Each category maps to one source asset. ``prefix`` keeps pool ids unique across
# files that reuse a key; ``itembase`` is the randomizer item's code stem used to
# reconstruct the full ``stackrandomizer-...`` code worldgen schematics reference
# (``None`` for physical blocks like loot vessels, which are never once-per-server).
CATEGORIES = [
    {
        "id": "ruins",
        "prefix": "ruins",
        "source": "survival/itemtypes/meta/stackrandomizer.json",
        "kind": "stackrandomizer",
        "itembase": "stackrandomizer",
    },
    {
        "id": "clutter",
        "prefix": "clutter",
        "source": "survival/itemtypes/meta/stackrandomizer-clutter.json",
        "kind": "stackrandomizer",
        "itembase": "stackrandomizer-clutter",
    },
    {
        "id": "library",
        "prefix": "library",
        "source": "survival/itemtypes/meta/stackrandomizer-library.json",
        "kind": "stackrandomizer",
        "itembase": "stackrandomizer",
    },
    {
        "id": "mines",
        "prefix": "mines",
        "source": "survival/itemtypes/meta/stackrandomizer-mines.json",
        "kind": "stackrandomizer",
        "itembase": "stackrandomizer",
    },
    {
        "id": "vessel",
        "prefix": "vessel",
        "source": "survival/blocktypes/clay/lootvessel.json",
        "kind": "lootvessel",
        "itembase": None,
    },
    {
        "id": "fishing",
        "prefix": "fishing",
        "source": "survival/entities/nonliving/bobber.json",
        "kind": "bobber",
        "itembase": None,
    },
]

# A loot pool is "once per server" when the only world structures that place it
# generate exactly once per world. Those live in `worldgen/schematics/story/`
# (The Lazaret, Tobias Cave, the Resonance Archive, Devastation, ...). We detect
# this from the assets rather than hard-coding it (so it survives game updates):
# a pool's `stackrandomizer-<code>` token must appear ONLY in story schematics
# and never in a repeatable ruin. If the worldgen assets are unavailable the scan
# falls back to the codes known to be exclusive at time of writing.
STORY_SCHEMATIC_SUBPATH = Path("survival/worldgen/schematics/story")
WORLDGEN_SUBPATH = Path("survival/worldgen")
STACKRANDOMIZER_TOKEN_RE = re.compile(r"stackrandomizer-[a-z0-9-]+")
DEFAULT_ONCE_PER_SERVER_CODES = {"stackrandomizer-lazaret", "stackrandomizer-clutter-tobias"}


def once_per_server_codes(assets_root: Path) -> set:
    """Set of ``stackrandomizer-<code>`` item codes whose loot is only ever placed
    by once-per-world "story" structures (so an item found only there is unique)."""
    wg = assets_root / WORLDGEN_SUBPATH
    if not wg.is_dir():
        print(f"[warn] worldgen not found at {wg} — using default once-per-server codes")
        return set(DEFAULT_ONCE_PER_SERVER_CODES)
    story_dir = assets_root / STORY_SCHEMATIC_SUBPATH
    all_codes: set = set()
    repeatable: set = set()
    for path in wg.rglob("*.json"):
        try:
            text = path.read_text(encoding="utf-8-sig", errors="ignore")
        except OSError:
            continue
        tokens = set(STACKRANDOMIZER_TOKEN_RE.findall(text))
        if not tokens:
            continue
        all_codes |= tokens
        if story_dir not in path.parents:
            repeatable |= tokens
    exclusive = all_codes - repeatable
    return exclusive or set(DEFAULT_ONCE_PER_SERVER_CODES)


def _quantity_bounds(stack: dict) -> tuple:
    """(min, max) item count for a stackrandomizer ``quantity: {avg, var}`` block
    (defaults to a single item)."""
    q = stack.get("quantity")
    if not isinstance(q, dict):
        return 1, 1
    avg = float(q.get("avg", 1) or 1)
    var = float(q.get("var", 0) or 0)
    return max(0, round(avg - var)), round(avg + var)


def _stack_code(code: str, stack: dict) -> str:
    """Effective item code for a loot stack. The ``clutter`` / ``tapestry`` blocks
    are single codes whose real variant lives in ``attributes.type`` (e.g. a
    "Broken anvil" is ``clutter`` + ``{type: "anvil-broken1"}``); without this
    they'd all collapse into one bland "clutter" row, so fold the variant into the
    code (``clutter-anvil-broken1``)."""
    bc = bare_code(code)
    attrs = stack.get("attributes")
    if bc in ("clutter", "tapestry") and isinstance(attrs, dict) and attrs.get("type"):
        return f"{bc}-{attrs['type']}"
    return bc


def _label_for(kind: str, key: str, lang: Dict[str, str]) -> str:
    """In-game randomizer / vessel name, falling back to a title-cased key."""
    if kind == "lootvessel":
        return lang.get(f"block-lootvessel-{key}") or f"Cracked vessel ({key.title()})"
    return lang.get(f"item-stackrandomizer-{key}") or key.replace("-", " ").title()


def _build_stackrandomizer_pools(data: dict, cat: dict, lang: Dict[str, str]) -> List[dict]:
    pools: List[dict] = []
    by_type = data.get("attributesByType") or {}
    for raw_key, pool in by_type.items():
        stacks = (pool or {}).get("stacks") or []
        # Sum weights (and keep the widest quantity span) per code so multi-variant
        # entries collapse into a single row.
        weight_by_code: Dict[str, float] = defaultdict(float)
        qty_by_code: Dict[str, list] = {}
        total = 0.0
        for st in stacks:
            code = st.get("code")
            chance = float(st.get("chance", 0) or 0)
            if not code or chance <= 0:
                continue
            bc = _stack_code(code, st)
            weight_by_code[bc] += chance
            total += chance
            lo, hi = _quantity_bounds(st)
            prev = qty_by_code.get(bc)
            qty_by_code[bc] = [lo, hi] if prev is None else [min(prev[0], lo), max(prev[1], hi)]
        if total <= 0:
            continue
        key = pool_key(raw_key)
        items = _finish_pool_items(weight_by_code, total, qty_by_code)
        itembase = cat.get("itembase")
        pools.append({
            "id": f"{cat['prefix']}-{key}",
            "key": key,
            "label": _label_for(cat["kind"], key, lang),
            "category": cat["id"],
            "itemCount": len(items),
            "items": items,
            "wgcode": f"{itembase}-{key}" if itembase else None,
        })
    return pools


def _build_lootvessel_pools(data: dict, cat: dict, lang: Dict[str, str]) -> List[dict]:
    pools: List[dict] = []
    attrs = data.get("attributes") or {}
    by_type = attrs.get("lootListByType") or {}
    tries_by_type = attrs.get("lootTriesByType") or {}
    for raw_key, entries in by_type.items():
        entries = entries or []
        weight_by_code: Dict[str, float] = defaultdict(float)
        qty_by_code: Dict[str, list] = {}
        total = 0.0
        for en in entries:
            chance = float(en.get("chance", 0) or 0)
            codes = en.get("codes") or []
            if chance <= 0 or not codes:
                continue
            total += chance
            # The vessel picks ONE code (uniformly) from the entry's list, so each
            # code shares the entry's weight.
            share = chance / len(codes)
            lo = int(en.get("minQuantity", 1) or 1)
            hi = int(en.get("maxQuantity", lo) or lo)
            for raw in codes:
                bc = bare_code(raw)
                weight_by_code[bc] += share
                prev = qty_by_code.get(bc)
                qty_by_code[bc] = [lo, hi] if prev is None else [min(prev[0], lo), max(prev[1], hi)]
        if total <= 0:
            continue
        key = pool_key(raw_key)
        items = _finish_pool_items(weight_by_code, total, qty_by_code)
        pool = {
            "id": f"{cat['prefix']}-{key}",
            "key": key,
            "label": _label_for(cat["kind"], key, lang),
            "category": cat["id"],
            "itemCount": len(items),
            "items": items,
            "wgcode": None,
        }
        tries = tries_by_type.get(raw_key)
        if tries is not None:
            pool["draws"] = float(tries)
        pools.append(pool)
    return pools


def _build_bobber_pools(data: dict, cat: dict, lang: Dict[str, str]) -> List[dict]:
    """The fishing bobber's ``junkCatches`` — the weighted "garbage" bycatch
    (old boot, counterfeit gear, cursed gemstone, ...) you can hook instead of a
    fish. Deliberately excludes the actual caught animals, which are not part of
    this weighted item table."""
    attrs = data.get("attributes") or {}
    catches = attrs.get("junkCatches") or []
    weight_by_code: Dict[str, float] = defaultdict(float)
    qty_by_code: Dict[str, list] = {}
    total = 0.0
    for en in catches:
        code = en.get("code")
        weight = float(en.get("weight", 0) or 0)
        if not code or weight <= 0:
            continue
        bc = bare_code(code)
        weight_by_code[bc] += weight
        total += weight
        lo, hi = _quantity_bounds(en)
        prev = qty_by_code.get(bc)
        qty_by_code[bc] = [lo, hi] if prev is None else [min(prev[0], lo), max(prev[1], hi)]
    if total <= 0:
        return []
    items = _finish_pool_items(weight_by_code, total, qty_by_code)
    pool = {
        "id": f"{cat['prefix']}-junk",
        "key": "junk",
        "label": lang.get("item-bobber-junk") or "Fishing junk (bycatch)",
        "category": cat["id"],
        "itemCount": len(items),
        "items": items,
        "wgcode": None,
    }
    jc = attrs.get("junkCatchChance")
    if jc is not None:
        pool["junkChancePct"] = round(float(jc) * 100.0, 2)
    return [pool]


def _finish_pool_items(weight_by_code: Dict[str, float], total: float, qty_by_code: Dict[str, list]) -> List[dict]:
    """Turn per-code weights into sorted {code, chancePct, rarity, minQty, maxQty}."""
    items: List[dict] = []
    for code, weight in weight_by_code.items():
        pct = round(weight / total * 100.0, 2)
        lo, hi = qty_by_code.get(code, [1, 1])
        items.append({
            "code": code,
            "chancePct": pct,
            "rarity": rarity_for(pct),
            "minQty": lo,
            "maxQty": hi,
        })
    items.sort(key=lambda r: (-r["chancePct"], r["code"]))
    return items


def build(assets_root: Path) -> dict:
    lang = load_lang(assets_root)
    pools: List[dict] = []
    sources: List[str] = []
    for cat in CATEGORIES:
        path = assets_root / Path(cat["source"])
        if not path.is_file():
            print(f"[warn] missing loot asset, skipping: {path}")
            continue
        data = load_vs_json(path)
        sources.append(cat["source"])
        if cat["kind"] == "lootvessel":
            pools.extend(_build_lootvessel_pools(data, cat, lang))
        elif cat["kind"] == "bobber":
            pools.extend(_build_bobber_pools(data, cat, lang))
        else:
            pools.extend(_build_stackrandomizer_pools(data, cat, lang))

    pools.sort(key=lambda p: (p["category"], p["label"].lower()))

    # Flag pools that only ever generate once per server, then flag the items that
    # appear EXCLUSIVELY in such pools (so they are genuinely one-of-a-kind on a
    # world). Items shared with any repeatable pool keep their normal rarity only.
    ops_codes = once_per_server_codes(assets_root)
    once_pool_ids: set = set()
    for p in pools:
        if p.get("wgcode") and p["wgcode"] in ops_codes:
            p["oncePerServer"] = True
            once_pool_ids.add(p["id"])

    pool_ids_by_item: Dict[str, set] = defaultdict(set)
    for p in pools:
        for it in p["items"]:
            pool_ids_by_item[it["code"]].add(p["id"])
    for p in pools:
        for it in p["items"]:
            ids = pool_ids_by_item[it["code"]]
            if ids and ids <= once_pool_ids:
                it["uniquePerServer"] = True

    # `wgcode` is an internal join key — drop it from the shipped JSON.
    for p in pools:
        p.pop("wgcode", None)

    unique_items = len({it["code"] for p in pools for it in p["items"] if it.get("uniquePerServer")})
    return {
        "generatedUtc": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "sources": sources,
        "poolCount": len(pools),
        "oncePerServerPoolCount": len(once_pool_ids),
        "uniqueItemCount": unique_items,
        "pools": pools,
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
    item_rows = sum(p["itemCount"] for p in result["pools"])
    print(
        f"[ok] {result['poolCount']} loot pools ({item_rows} item rows); "
        f"{result['oncePerServerPoolCount']} once-per-server pools, "
        f"{result['uniqueItemCount']} server-unique items -> {args.out}"
    )


if __name__ == "__main__":
    main()
