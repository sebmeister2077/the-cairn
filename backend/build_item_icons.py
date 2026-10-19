#!/usr/bin/env python3
"""Ingest game-rendered item/block icons into the Auction House explorer.

Vintage Story has a BUILT-IN client command that renders every registered
block/item to a transparent, game-accurate inventory PNG. Run it once in-game
(any world; join a server first if you want that server's exact item set):

    .blockitempngexport all 128

It writes ``icons/block/<code>.png`` and ``icons/item/<code>.png`` under the
game's working directory and prints the absolute path in chat (something like
``…/Vintagestory/icons/``). The PNG filenames are the item's *bare* code path
(domain stripped, ``/`` -> ``-`` for items), which matches the item catalog's
``code`` field — so this script can pair each catalogued item to its icon.

What this does
--------------
1. Reads the item catalog (``items.json`` produced by ``process_auction_data``)
   to learn which ``(code, classType)`` pairs the market actually needs.
2. Finds each one's PNG in the exported ``icons/{item,block}`` trees.
3. Trims transparent margins, fits it onto a square transparent canvas of
   ``--size`` px, and re-encodes an optimized PNG.
4. Writes them to ``frontend/public/auction/icons/`` as ``<class>-<code>.png``
   plus an ``item-images.json`` manifest (a versioned key list the frontend
   uses to know which items have an image, and to cache-bust).
5. Synthesises a per-wood icon for every split crate (``crate-wood-*``): the game
   exports the crate once (in its default ``wood-aged`` render), so all wood
   species would otherwise share that one ``block-crate`` icon. Each is produced
   by recolouring the aged render toward that wood's in-game crate-side texture
   (read from ``--assets-root``), so every wood gets a distinct, plausible icon.
6. Optionally uploads the whole set to the public R2 bucket(s), reusing the
   same immutable-data + no-cache-manifest scheme as the market data.

Run:
    python backend/build_item_icons.py --icons-dir "<…/Vintagestory/icons>"
    python backend/build_item_icons.py --icons-dir "<…>" --publish-r2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ITEMS = REPO_ROOT / "frontend" / "public" / "auction" / "items.json"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "auction" / "icons"
MANIFEST_NAME = "item-images.json"

# The crate block is a single id ("crate") rendered once by the game exporter
# using its default wood (`wood-aged`), so every wood species would share that
# one `block-crate` icon. The market splits crates per wood species (codes like
# `crate-wood-ebony`), so we synthesise a distinct icon for each by recolouring
# the exported aged render toward that wood's in-game crate-side texture — the
# shape/shading is identical across woods, only the plank colour differs.
CRATE_TEX_SUBPATH = Path("survival") / "textures" / "block" / "wood" / "crate"
CRATE_BASE_WOOD = "aged"  # the wood the exported `block/crate.png` is rendered in


def _bare(code: str) -> str:
    """Strip the asset-domain prefix (``game:ingot-copper`` -> ``ingot-copper``)."""
    return code.split(":", 1)[-1].strip()


def image_key(code: str, class_type: str) -> str:
    """Stable per-item image key, matching the frontend's ``itemImageKey``:
    ``<class lower>-<bare code with '/' -> '-'>`` (e.g. ``item-ingot-copper``)."""
    return f"{class_type.lower()}-{_bare(code).replace('/', '-')}"


def index_icons(icons_dir: Path, sub: str) -> Dict[str, Path]:
    """Index one exported icon tree (``item`` or ``block``) by normalized code.

    The game writes items with ``/`` already flattened to ``-`` and blocks into
    real subfolders; normalizing the relative path with ``/`` -> ``-`` makes both
    line up with a catalog code's bare path."""
    root = icons_dir / sub
    out: Dict[str, Path] = {}
    if not root.is_dir():
        return out
    for png in root.rglob("*.png"):
        rel = png.relative_to(root).with_suffix("")
        norm = str(rel).replace("\\", "/").replace("/", "-")
        out.setdefault(norm, png)
    return out


def _trim_fit(im: Image.Image, size: int) -> Optional[bytes]:
    """Trim transparent margins of an RGBA image and fit it onto a square ``size``
    canvas. Returns optimized PNG bytes, or ``None`` if fully transparent."""
    im = im.convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        return None
    cropped = im.crop(bbox)
    w, h = cropped.size
    scale = size / max(w, h)
    # Never upscale past the source (keeps tiny icons crisp, not blurry).
    scale = min(scale, 1.0) if max(w, h) < size else scale
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = cropped.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)

    from io import BytesIO

    buf = BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def process_icon(src: Path, size: int) -> Optional[bytes]:
    """Trim transparent margins and fit the icon onto a square ``size`` canvas.
    Returns optimized PNG bytes, or ``None`` if the source is fully transparent."""
    with Image.open(src) as im:
        return _trim_fit(im, size)


# --------------------------------------------------------------------------- #
# Per-wood crate icons (recoloured from the single exported aged crate render)
# --------------------------------------------------------------------------- #
def default_assets_root() -> Optional[Path]:
    """The game's ``assets`` dir on Windows (``%APPDATA%/Vintagestory/assets``),
    used to read the per-wood crate-side textures. ``None`` if not found."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        cand = Path(appdata) / "Vintagestory" / "assets"
        if cand.is_dir():
            return cand
    return None


def _mean_opaque_rgb(path: Path) -> Optional[Tuple[float, float, float]]:
    """Average RGB of a texture over its opaque pixels, or ``None`` if unreadable
    or fully transparent."""
    try:
        with Image.open(path) as im:
            im = im.convert("RGBA")
            px = list(im.getdata())
    except (OSError, ValueError):
        return None
    r = g = b = 0.0
    n = 0
    for pr, pg, pb, pa in px:
        if pa == 0:
            continue
        r += pr
        g += pg
        b += pb
        n += 1
    if n == 0:
        return None
    return (r / n, g / n, b / n)


def recolor_crate(base: Image.Image, ratio: Tuple[float, float, float]) -> Image.Image:
    """Recolour the aged crate render toward another wood by scaling each RGB
    channel by ``ratio`` (target-wood mean / aged mean), preserving the shape's
    shading, detail and alpha."""
    base = base.convert("RGBA")
    r, g, b, a = base.split()
    r = r.point(lambda v: min(255, round(v * ratio[0])))
    g = g.point(lambda v: min(255, round(v * ratio[1])))
    b = b.point(lambda v: min(255, round(v * ratio[2])))
    return Image.merge("RGBA", (r, g, b, a))


def _crate_wood_from_code(icon_code: str) -> Optional[str]:
    """Wood species of a per-type crate icon code, e.g. ``crate-wood-ebony`` ->
    ``ebony``; ``None`` when it isn't a split crate icon code."""
    bare = _bare(icon_code)
    if bare.startswith("crate-wood-"):
        return bare[len("crate-wood-"):] or None
    return None


def build_crate_icons(
    catalog: dict,
    block_idx: Dict[str, Path],
    assets_root: Optional[Path],
    out_dir: Path,
    size: int,
) -> Dict[str, str]:
    """Synthesise a recoloured icon for every per-wood crate in the catalog from
    the exported aged render + that wood's crate-side texture. Writes the PNGs and
    returns ``{image_key: content_hash}`` for the manifest. Skips gracefully when
    the base render or textures aren't available."""
    woods = sorted(
        {
            w
            for e in catalog.values()
            if (w := _crate_wood_from_code(e.get("iconCode") or "")) is not None
        }
    )
    if not woods:
        return {}
    base_src = block_idx.get("crate")
    tex_dir = (assets_root / CRATE_TEX_SUBPATH) if assets_root else None
    if base_src is None or tex_dir is None or not tex_dir.is_dir():
        print(
            "  [warn] crate recolour skipped (need exported block/crate.png and "
            "game crate textures; pass --assets-root)"
        )
        return {}
    aged_mean = _mean_opaque_rgb(tex_dir / f"{CRATE_BASE_WOOD}-sides.png")
    if aged_mean is None or min(aged_mean) <= 0:
        print("  [warn] crate recolour skipped (unreadable aged-sides texture)")
        return {}

    out: Dict[str, str] = {}
    with Image.open(base_src) as base_im:
        base_im = base_im.convert("RGBA")
        for wood in woods:
            key = f"block-crate-wood-{wood}"
            if wood == CRATE_BASE_WOOD:
                png = _trim_fit(base_im.copy(), size)  # aged IS the base render
            else:
                target_mean = _mean_opaque_rgb(tex_dir / f"{wood}-sides.png")
                if target_mean is None:
                    print(f"  [warn] no crate-side texture for '{wood}' — skipping")
                    continue
                ratio = tuple(t / a for t, a in zip(target_mean, aged_mean))
                png = _trim_fit(recolor_crate(base_im, ratio), size)
            if png is None:
                continue
            (out_dir / f"{key}.png").write_bytes(png)
            out[key] = hashlib.sha1(png).hexdigest()[:12]
    return out


def build(
    items_path: Path,
    icons_dir: Path,
    out_dir: Path,
    size: int,
    assets_root: Optional[Path] = None,
) -> Tuple[List[str], List[str]]:
    """Produce optimized icons + the manifest. Returns ``(matched, missing)`` keys."""
    catalog = json.loads(items_path.read_text(encoding="utf-8"))
    item_idx = index_icons(icons_dir, "item")
    block_idx = index_icons(icons_dir, "block")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # De-dupe by image key: many catalog ids (ore host-rock variants, clutter
    # groups) resolve to the same underlying block code / icon.
    seen: Dict[str, Path] = {}
    for entry in catalog.values():
        code = entry.get("code")
        cls = entry.get("classType")
        if not code or cls not in ("Item", "Block"):
            continue
        seen.setdefault(image_key(code, cls), None)  # register the key
        norm = _bare(code).replace("/", "-")
        src = (item_idx if cls == "Item" else block_idx).get(norm)
        if src is not None:
            seen[image_key(code, cls)] = src

    matched: Dict[str, str] = {}  # key -> content hash
    missing: List[str] = []
    for key, src in sorted(seen.items()):
        if src is None:
            missing.append(key)
            continue
        png = process_icon(src, size)
        if png is None:
            missing.append(key)
            continue
        (out_dir / f"{key}.png").write_bytes(png)
        matched[key] = hashlib.sha1(png).hexdigest()[:12]

    # Caught-animal market items (Pig, Chicken, Goat, ...) are keyed by a
    # creature code, which the game's block/item exporter never renders. If the
    # export dir carries a `creature/` tree (creature PNGs dropped in by hand or
    # by an entity-render tool), ingest every one under an `item-creature-<code>`
    # key so both the species image and each breed/age/sex image resolve through
    # the same manifest. These are ingested wholesale (not gated by the catalog)
    # since individual breeds aren't their own catalog items.
    for norm, src in index_icons(icons_dir, "creature").items():
        bare = norm[len("creature-"):] if norm.startswith("creature-") else norm
        key = f"item-creature-{bare}"
        if key in matched:
            continue
        png = process_icon(src, size)
        if png is None:
            continue
        (out_dir / f"{key}.png").write_bytes(png)
        matched[key] = hashlib.sha1(png).hexdigest()[:12]

    # Per-wood crate icons: the exporter renders the crate once (aged wood), so
    # every split crate (`crate-wood-*`) would otherwise share that one icon.
    # Recolour the aged render toward each wood's crate-side texture instead.
    crate_icons = build_crate_icons(catalog, block_idx, assets_root, out_dir, size)
    if crate_icons:
        matched.update(crate_icons)
        missing = [k for k in missing if k not in crate_icons]

    # Version = hash of the sorted (key, content-hash) pairs, so any pixel change
    # from a re-export flips the version and busts the frontend/CDN cache.
    fingerprint = hashlib.sha1(
        "\n".join(f"{k}:{h}" for k, h in sorted(matched.items())).encode("utf-8")
    ).hexdigest()[:12]
    manifest = {
        "version": fingerprint,
        "size": size,
        "count": len(matched),
        "keys": sorted(matched.keys()),
    }
    (out_dir / MANIFEST_NAME).write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
    )
    return sorted(matched.keys()), missing


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--icons-dir",
        type=Path,
        required=True,
        help="The game's exported 'icons' folder (contains item/ and block/), "
        "printed in chat by '.blockitempngexport'. An optional creature/ subfolder "
        "of entity PNGs is ingested for the caught-animal market items.",
    )
    ap.add_argument("--items", type=Path, default=DEFAULT_ITEMS, help="items.json catalog path")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output icons folder")
    ap.add_argument("--size", type=int, default=96, help="square icon size in px (default 96)")
    ap.add_argument(
        "--assets-root",
        type=Path,
        default=None,
        help="Path to the game 'assets' dir (defaults to %%APPDATA%%/Vintagestory/assets). "
        "Used to read per-wood crate-side textures for the recoloured crate icons.",
    )
    ap.add_argument(
        "--publish-r2",
        action="store_true",
        help="Upload the icon set to the dev + prod public R2 buckets.",
    )
    ap.add_argument(
        "--publish-r2-dev",
        action="store_true",
        help="Like --publish-r2, but upload only to the dev (local) bucket.",
    )
    args = ap.parse_args()

    if not args.icons_dir.is_dir():
        raise SystemExit(f"[error] --icons-dir not found: {args.icons_dir}")
    if not args.items.is_file():
        raise SystemExit(
            f"[error] items.json not found: {args.items}\n"
            "        Run process_auction_data.py first to generate the catalog."
        )

    assets_root: Optional[Path] = args.assets_root or default_assets_root()
    print(f"Reading catalog {args.items}")
    print(f"Scanning icons  {args.icons_dir}")
    if assets_root:
        print(f"Game assets     {assets_root}")
    matched, missing = build(args.items, args.icons_dir, args.out, args.size, assets_root)
    print(f"  matched {len(matched):,} icons, {len(missing):,} without an image")
    if missing:
        sample = ", ".join(missing[:20])
        more = "" if len(missing) <= 20 else f" (+{len(missing) - 20} more)"
        print(f"  missing: {sample}{more}")
    print(f"Wrote {args.out}")

    if args.publish_r2 or args.publish_r2_dev:
        dev_only = args.publish_r2_dev and not args.publish_r2
        print("Publishing icons to R2 (dev only)…" if dev_only else "Publishing icons to R2 (dev + prod)…")
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from auction_r2_publish import publish_auction_files

        files = sorted(args.out.glob("*.png")) + [args.out / MANIFEST_NAME]
        publish_auction_files(
            files,
            manifest_name=MANIFEST_NAME,
            prefix="auction/icons",
            envs=("local",) if dev_only else ("local", "prod"),
        )

    print("Done.")


if __name__ == "__main__":
    main()
