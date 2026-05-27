"""One-shot preprocessing for the Tops oceans overlay image.

The artist-generated source ``frontend/src/assets/Oceans/oceans.png`` is an
8751x8751 PNG where ocean pixels are shades of blue (red channel == 0) and
land pixels are a single olive colour ``(80, 100, 40)``. The frontend
ships the processed result as a translucent "where do oceans exist in
unexplored areas" background for the Tops map viewer.

This script loads the PNG, marks every "land" pixel (any pixel whose red
channel exceeds the ocean palette, which tops out at red == 0) as fully
transparent, and writes ``oceans_transparent.png`` next to the source.

Run once; commit the output. Re-run after replacing the source PNG.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSET_DIR = REPO_ROOT / "frontend" / "src" / "assets" / "Oceans"
SOURCE_PNG = ASSET_DIR / "oceans.png"
OUTPUT_PNG = ASSET_DIR / "oceans_transparent.png"

# Land pixels have red == 80, ocean pixels have red == 0. A threshold of
# 20 cleanly separates them while leaving headroom for any future ocean
# shades that creep slightly above pure zero.
LAND_RED_THRESHOLD = 20


def main() -> None:
    if not SOURCE_PNG.exists():
        raise SystemExit(f"Source PNG not found: {SOURCE_PNG}")

    print(f"Loading {SOURCE_PNG} ...")
    src = Image.open(SOURCE_PNG).convert("RGB")
    w, h = src.size
    print(f"  size = {w}x{h}")

    arr = np.array(src, dtype=np.uint8)  # (H, W, 3)
    land_mask = arr[..., 0] > LAND_RED_THRESHOLD

    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = arr
    rgba[..., 3] = np.where(land_mask, 0, 255).astype(np.uint8)
    # Zero out RGB on transparent pixels so a browser doesn't fringe them
    # when blending at non-integer scales.
    rgba[land_mask] = (0, 0, 0, 0)

    transparent_pct = float(land_mask.mean()) * 100.0
    print(f"  transparent pixels: {transparent_pct:.1f}%")

    Image.fromarray(rgba, mode="RGBA").save(OUTPUT_PNG, format="PNG", optimize=True)
    print(f"Wrote {OUTPUT_PNG}")


if __name__ == "__main__":
    main()
