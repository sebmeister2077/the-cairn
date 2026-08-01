"""Extract trader buy/sell wares and price intervals from the Vintage Story game
assets into a static JSON the frontend Market Item page consumes.

Source: ``<assets>/survival/config/tradelists/trader-*.json`` (one file per trader
profession). Each ware entry is ``{code, type, stacksize, stock{avg,var},
price{avg,var}, attributes?}``. ``selling`` = trader sells to the player (player
buys); ``buying`` = trader buys from the player (player sells).

Prices are a Vintage Story ``NatFloat`` with a default uniform distribution, so
the realised range is ``[avg - var, avg + var]`` gears.

Output: ``frontend/src/assets/GameData/trader-wares.json`` keyed by bare item
code (domain prefix stripped), matching the item catalog's ``code`` field.

Run: ``python backend/extract_trader_wares.py`` (auto-detects %APPDATA% on
Windows) or ``--assets-root "<path>/assets"`` to point at another install.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "frontend" / "src" / "assets" / "GameData" / "trader-wares.json"

# tradelist file basename (without extension) -> frontend TraderType key
# (see frontend/src/lib/trader-types.ts).
TRADER_TYPE_BY_FILE: Dict[str, str] = {
    "trader-agriculture": "agriculture",
    "trader-artisan": "artisan",
    "trader-buildmaterials": "building_materials",
    "trader-clothing": "clothing",
    "trader-commodities": "commodities",
    "trader-furniture": "furniture",
    "trader-luxuries": "luxuries",
    "trader-survivalgoods": "survival_goods",
    "trader-treasurehunter": "treasure_hunter",
}

# Named village NPCs (the "Nadiya" village) that also trade. Same file format as
# the profession traders; each is labelled by its in-game name (Alba, Tobias, ...).
# `arzhur` reuses `villager-liga`, so it isn't listed separately.
VILLAGER_FILES = [
    "villager-agnieszka",
    "villager-alba",
    "villager-beata",
    "villager-gerhardt",
    "villager-liga",
    "villager-tad",
    "villager-tobias",
    "villager-wall",
]


def default_assets_root() -> Optional[Path]:
    """Best-effort location of the installed game assets on Windows."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        cand = Path(appdata) / "Vintagestory" / "assets"
        if cand.is_dir():
            return cand
    return None


def load_lenient_json(path: Path) -> dict:
    """Parse a Vintage Story asset file (mostly strict JSON, but tolerate
    ``//`` / ``/* */`` comments and trailing commas just in case)."""
    text = path.read_text(encoding="utf-8-sig")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"(?m)//.*$", "", text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


def bare_code(code: str) -> str:
    """Strip the asset domain prefix (``game:ingot-copper`` -> ``ingot-copper``)."""
    return code.split(":", 1)[-1].strip()


# Generic multi-variant blocks whose real object lives in ``attributes.type``
# (`tapestry-north` sells 20 distinct artworks, `clutter` many objects). The
# market groups these by ``category:base`` (see process_auction_data.type_variant),
# so we key their wares the same way instead of the shared block code — otherwise
# every tapestry/clutter group matches the one collapsed entry.
SPLIT_TYPE_CATEGORIES = {"clutter", "tapestry"}


def _variant_base(variant: str) -> str:
    """Group key for a type variant: the string with any trailing number stripped
    (`ambush1` -> `ambush`, `tobias-lantern` -> `tobias-lantern`). Mirrors the
    backend's ``_variant_base``."""
    base = re.sub(r"\d+$", "", variant).rstrip("-_/")
    return base or variant


def split_category(code: str) -> Optional[str]:
    """Split-type category for a generic block code (`tapestry-north` -> `tapestry`,
    `clutter` -> `clutter`), else None."""
    head = code.split("-", 1)[0].split("/", 1)[0]
    return head if head in SPLIT_TYPE_CATEGORIES else None


def ware_key(code: str, entry: dict) -> str:
    """Lookup key for a ware: ``category:base`` for split-type blocks whose object
    is in ``attributes.type``, otherwise the bare item code."""
    cat = split_category(code)
    if cat:
        vtype = (entry.get("attributes") or {}).get("type")
        if isinstance(vtype, str) and vtype.strip():
            return f"{cat}:{_variant_base(vtype.strip())}"
    return code


def load_lang(assets_root: Path) -> Dict[str, str]:
    """Game English lang table (strict JSON), used for villager display names."""
    path = assets_root / "game" / "lang" / "en.json"
    if not path.is_file():
        print(f"[warn] lang file not found at {path} — villager names fall back to codes")
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def round2(x: float) -> float:
    return round(float(x), 2)


class WareAgg:
    """Accumulates one item's price range for a single trader type + direction."""

    __slots__ = ("mins", "maxes", "avgs", "stacks")

    def __init__(self) -> None:
        self.mins: List[float] = []
        self.maxes: List[float] = []
        self.avgs: List[float] = []
        self.stacks: List[int] = []

    def add(self, avg: float, var: float, stacksize: int) -> None:
        self.mins.append(avg - var)
        self.maxes.append(avg + var)
        self.avgs.append(avg)
        self.stacks.append(stacksize)

    def result(self) -> Dict[str, float]:
        out: Dict[str, float] = {
            "priceMin": max(0.0, round2(min(self.mins))),
            "priceMax": round2(max(self.maxes)),
            "priceAvg": round2(sum(self.avgs) / len(self.avgs)),
        }
        # Quantity of items exchanged per that price (per-price stack size).
        if self.stacks:
            out["stacksize"] = max(self.stacks)
        return out


def parse_tradelist(path: Path, trader_type: str, out: Dict[str, Dict[str, Dict[str, WareAgg]]]) -> int:
    """Fold one trader file's wares into ``out[code][direction][traderType]``."""
    data = load_lenient_json(path)
    count = 0
    for direction, section in (("sells", "selling"), ("buys", "buying")):
        entries = ((data.get(section) or {}).get("list")) or []
        for entry in entries:
            raw_code = entry.get("code")
            price = entry.get("price") or {}
            if not raw_code or "avg" not in price:
                continue
            key = ware_key(bare_code(raw_code), entry)
            avg = float(price.get("avg", 0))
            var = float(price.get("var", 0) or 0)
            stacksize = int(entry.get("stacksize", 1) or 1)
            agg = out.setdefault(key, {}).setdefault(direction, {}).setdefault(trader_type, WareAgg())
            agg.add(avg, var, stacksize)
            count += 1
    return count


def build(assets_root: Path) -> dict:
    tradelists_dir = assets_root / "survival" / "config" / "tradelists"
    if not tradelists_dir.is_dir():
        raise SystemExit(f"tradelists dir not found: {tradelists_dir}")

    lang = load_lang(assets_root)

    # code -> direction -> traderKey -> WareAgg
    agg: Dict[str, Dict[str, Dict[str, WareAgg]]] = {}
    # traderKey -> {"traderType": str, "label": Optional[str]}
    meta: Dict[str, Dict[str, Optional[str]]] = {}
    seen_files = 0
    total = 0
    for file_stem, trader_type in TRADER_TYPE_BY_FILE.items():
        path = tradelists_dir / f"{file_stem}.json"
        if not path.is_file():
            print(f"[warn] missing tradelist: {path.name}")
            continue
        seen_files += 1
        meta[trader_type] = {"traderType": trader_type, "label": None}
        total += parse_tradelist(path, trader_type, agg)

    for file_stem in VILLAGER_FILES:
        path = tradelists_dir / f"{file_stem}.json"
        if not path.is_file():
            print(f"[warn] missing villager tradelist: {path.name}")
            continue
        seen_files += 1
        suffix = file_stem.split("-", 1)[1]
        name = lang.get(f"nametag-{suffix}") or suffix.title()
        meta[file_stem] = {"traderType": "villager", "label": name}
        total += parse_tradelist(path, file_stem, agg)

    items: Dict[str, dict] = {}
    for code in sorted(agg):
        record: Dict[str, list] = {}
        for direction in ("sells", "buys"):
            by_trader = agg[code].get(direction)
            if not by_trader:
                continue
            rows = []
            for trader_key in sorted(by_trader):
                m = meta[trader_key]
                row: Dict[str, object] = {"traderType": m["traderType"]}
                if m["label"]:
                    row["label"] = m["label"]
                row.update(by_trader[trader_key].result())
                rows.append(row)
            record[direction] = rows
        items[code] = record

    return {
        "generatedUtc": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "source": "vintagestory/assets/survival/config/tradelists",
        "traderFiles": seen_files,
        "wareEntries": total,
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
    print(f"[ok] {len(result['items'])} item codes from {result['traderFiles']} traders "
          f"({result['wareEntries']} ware entries) -> {args.out}")


if __name__ == "__main__":
    main()
