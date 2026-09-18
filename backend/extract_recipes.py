"""Extract grid-crafting recipes into a small bundled dataset the market pages
use to show an "ingredient fair price" — the summed market value of the items a
thing is crafted from.

Source: ``<assets>/survival/recipes/grid/**/*.json`` (relaxed VS JSON: comments,
trailing commas, bare keys, embedded tabs). Each recipe declares an
``ingredientPattern`` grid, an ``ingredients`` map (letter -> {type, code,
quantity}) and an ``output``. The total amount of an ingredient a recipe consumes
is the number of times its letter appears in the pattern (``_`` and spaces are
empty slots) times that ingredient's per-slot ``quantity``.

Only recipes whose output AND every ingredient are *concrete* codes are kept —
recipes with ``{variant}`` placeholders or ``*`` wildcards are skipped, because
resolving them to specific tradeable items (and prices) isn't reliable here. This
still covers the many multi-ingredient crafts (bags, tools assembled from parts,
furniture, food) the fair-price hint is most useful for. Anvil smithing / clay
forming / knapping recipes are a separate pipeline and out of scope.

Output: ``frontend/src/assets/GameData/recipes.json`` keyed by bare output code:

    { "recipes": { "backpack-sturdy": [ { "output": 1,
        "ingredients": [ {"code": "leather-sturdy-plain", "quantity": 10} ] } ] } }

A code may have several recipes (alternate ingredient sets); all concrete ones
are kept and the frontend picks the cheapest it can price.

Usage: ``python backend/extract_recipes.py`` (auto-detects
``%APPDATA%/Vintagestory/assets``), or pass ``--assets-root "<path>/assets"``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "frontend" / "src" / "assets" / "GameData" / "recipes.json"


def default_assets_root() -> Optional[Path]:
    appdata = os.environ.get("APPDATA")
    if appdata:
        cand = Path(appdata) / "Vintagestory" / "assets"
        if cand.is_dir():
            return cand
    return None


def load_vs_json(path: Path) -> object:
    """Parse a relaxed Vintage Story asset file (comments, trailing commas,
    unquoted keys, embedded control chars). Returns a dict or list."""
    text = path.read_text(encoding="utf-8-sig")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"(?m)//.*$", "", text)
    text = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*):", r'\1"\2"\3:', text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    # VS allows single-quoted string values (e.g. `copyAttributesFrom: 'H'`);
    # convert them to double-quoted so strict json.loads accepts them.
    text = re.sub(r":(\s*)'([^']*)'", r':\1"\2"', text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\t]", " ", text)
    return json.loads(text)


def bare_code(code: str) -> str:
    return code.split(":", 1)[-1].strip()


def _is_concrete(code: str) -> bool:
    """A code with no variant placeholder / wildcard (so it names one item)."""
    return "{" not in code and "}" not in code and "*" not in code


def _ingredient_ok(code: str) -> bool:
    """An ingredient code we can resolve later: concrete, or a `*` wildcard the
    frontend can match against the catalog. Variant `{...}` placeholders can't be
    resolved without a variant context, so they disqualify the recipe."""
    return "{" not in code and "}" not in code


def _iter_recipes(node: object):
    """Yield every recipe-like dict (has ``output`` + an ingredient spec) in a
    parsed file, however it's nested (top-level list, single object, grouped)."""
    if isinstance(node, dict):
        if "output" in node and ("ingredientPattern" in node or "ingredients" in node):
            yield node
        else:
            for v in node.values():
                yield from _iter_recipes(v)
    elif isinstance(node, list):
        for v in node:
            yield from _iter_recipes(v)


def _output_qty(output: object) -> int:
    if isinstance(output, dict):
        q = output.get("quantity")
        if isinstance(q, (int, float)) and q > 0:
            return int(q)
    return 1


def _parse_recipe(recipe: dict) -> Optional[dict]:
    """Turn one recipe dict into ``{output, ingredients:[{code, quantity, allowed?}]}``
    with total ingredient amounts, or None when the OUTPUT isn't a concrete item.
    Wildcard (`*`) ingredient codes are kept (with any ``allowedVariants``) for the
    frontend to resolve against the catalog; ``{variant}`` ingredients disqualify."""
    output = recipe.get("output")
    if not isinstance(output, dict) or not isinstance(output.get("code"), str):
        return None
    out_code = bare_code(output["code"])
    if not _is_concrete(out_code):
        return None

    # code -> {"quantity": int, "allowed": Optional[list[str]]}
    totals: Dict[str, dict] = {}
    ingredients = recipe.get("ingredients")
    pattern = recipe.get("ingredientPattern")

    def add(spec: dict, occurrences: int) -> bool:
        if not isinstance(spec, dict) or not isinstance(spec.get("code"), str):
            return False
        code = bare_code(spec["code"])
        if not _ingredient_ok(code):
            return False
        per = spec.get("quantity")
        per = int(per) if isinstance(per, (int, float)) and per > 0 else 1
        entry = totals.setdefault(code, {"quantity": 0, "allowed": None})
        entry["quantity"] += occurrences * per
        allowed = spec.get("allowedVariants")
        if isinstance(allowed, list) and allowed and entry["allowed"] is None:
            entry["allowed"] = [str(a) for a in allowed]
        return True

    if isinstance(pattern, str) and isinstance(ingredients, dict):
        counts: Dict[str, int] = {}
        for ch in pattern:
            if ch in ("_", " "):
                continue
            counts[ch] = counts.get(ch, 0) + 1
        for key, spec in ingredients.items():
            if not add(spec, counts.get(key, 0)):
                return None
    elif isinstance(ingredients, list):
        # Shapeless-style: a flat list of ingredient specs.
        for spec in ingredients:
            if not add(spec, 1):
                return None
    else:
        return None

    ing = []
    for code, e in sorted(totals.items()):
        if e["quantity"] <= 0:
            continue
        row: dict = {"code": code, "quantity": e["quantity"]}
        if e["allowed"]:
            row["allowed"] = e["allowed"]
        ing.append(row)
    if not ing:
        return None
    return {"output": _output_qty(output), "ingredients": ing}


def build(assets_root: Path) -> dict:
    recipe_dir = assets_root / "survival" / "recipes" / "grid"
    if not recipe_dir.is_dir():
        raise SystemExit(f"grid recipes not found at {recipe_dir}")

    recipes: Dict[str, List[dict]] = {}
    files = 0
    kept = 0
    for path in sorted(recipe_dir.rglob("*.json")):
        try:
            data = load_vs_json(path)
        except Exception as exc:  # noqa: BLE001 - one bad file shouldn't abort
            print(f"[warn] could not parse {path.name}: {exc}")
            continue
        files += 1
        for raw in _iter_recipes(data):
            parsed = _parse_recipe(raw)
            if not parsed:
                continue
            out_code = bare_code(raw["output"]["code"])
            bucket = recipes.setdefault(out_code, [])
            # De-dupe identical ingredient sets (same recipe declared per-file).
            sig = json.dumps(parsed, sort_keys=True)
            if any(json.dumps(r, sort_keys=True) == sig for r in bucket):
                continue
            bucket.append(parsed)
            kept += 1

    print(f"parsed {files} recipe files, kept {kept} concrete recipes for {len(recipes)} items")
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "vintagestory/assets/survival/recipes/grid",
        "recipes": recipes,
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
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
