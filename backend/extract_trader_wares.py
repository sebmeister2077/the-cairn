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
            code = bare_code(raw_code)
            avg = float(price.get("avg", 0))
            var = float(price.get("var", 0) or 0)
            stacksize = int(entry.get("stacksize", 1) or 1)
            agg = out.setdefault(code, {}).setdefault(direction, {}).setdefault(trader_type, WareAgg())
            agg.add(avg, var, stacksize)
            count += 1
    return count


def build(assets_root: Path) -> dict:
    tradelists_dir = assets_root / "survival" / "config" / "tradelists"
    if not tradelists_dir.is_dir():
        raise SystemExit(f"tradelists dir not found: {tradelists_dir}")

    # code -> direction -> traderType -> WareAgg
    agg: Dict[str, Dict[str, Dict[str, WareAgg]]] = {}
    seen_files = 0
    total = 0
    for file_stem, trader_type in TRADER_TYPE_BY_FILE.items():
        path = tradelists_dir / f"{file_stem}.json"
        if not path.is_file():
            print(f"[warn] missing tradelist: {path.name}")
            continue
        seen_files += 1
        total += parse_tradelist(path, trader_type, agg)

    items: Dict[str, dict] = {}
    for code in sorted(agg):
        record: Dict[str, list] = {}
        for direction in ("sells", "buys"):
            by_trader = agg[code].get(direction)
            if not by_trader:
                continue
            rows = []
            for trader_type in sorted(by_trader):
                row = {"traderType": trader_type}
                row.update(by_trader[trader_type].result())
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
