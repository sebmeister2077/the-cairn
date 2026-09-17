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
5. Optionally uploads the whole set to the public R2 bucket(s), reusing the
   same immutable-data + no-cache-manifest scheme as the market data.

Run:
    python backend/build_item_icons.py --icons-dir "<…/Vintagestory/icons>"
    python backend/build_item_icons.py --icons-dir "<…>" --publish-r2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ITEMS = REPO_ROOT / "frontend" / "public" / "auction" / "items.json"
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "auction" / "icons"
MANIFEST_NAME = "item-images.json"


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


def process_icon(src: Path, size: int) -> Optional[bytes]:
    """Trim transparent margins and fit the icon onto a square ``size`` canvas.
    Returns optimized PNG bytes, or ``None`` if the source is fully transparent."""
    with Image.open(src) as im:
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


def build(items_path: Path, icons_dir: Path, out_dir: Path, size: int) -> Tuple[List[str], List[str]]:
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
        "printed in chat by '.blockitempngexport'.",
    )
    ap.add_argument("--items", type=Path, default=DEFAULT_ITEMS, help="items.json catalog path")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output icons folder")
    ap.add_argument("--size", type=int, default=96, help="square icon size in px (default 96)")
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

    print(f"Reading catalog {args.items}")
    print(f"Scanning icons  {args.icons_dir}")
    matched, missing = build(args.items, args.icons_dir, args.out, args.size)
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
