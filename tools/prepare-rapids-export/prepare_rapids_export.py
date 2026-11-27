"""Derive webmap assets from a Rapids Exporter mod output folder.

Input: the mod's `ModData/rapidsexporter/<savegame-id>/` folder (see
docs/multiplayer/rapids-exporter-format.md). It must contain a
`rapids_<timestamp>.json` export and/or a `heightmap_<timestamp>/` folder.

Outputs (under frontend/src/assets/):
  GeneratedRapids/<rapids_ts>/rapids.compact.json      tracked, bundled
  Elevation/<heightmap_ts>/<heightmap_ts>.webp          R2 (gitignored)
  Elevation/<heightmap_ts>/<heightmap_ts>.h8.png        R2 (gitignored)
  Elevation/<heightmap_ts>/<heightmap_ts>.world.json    tracked (color georef)
  Elevation/<heightmap_ts>/<heightmap_ts>.h8.world.json tracked (raw georef)

After running, bump the base-name constants in
frontend/src/lib/rapids/generated.ts and frontend/src/lib/elevation/loader.ts
and upload the two Elevation rasters to R2 under `elevation/<heightmap_ts>/`.

Usage:
  python prepare_rapids_export.py <export-folder> [--color-px 4000] [--raw-px 2000]

Requires Pillow + numpy.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS = REPO_ROOT / "frontend" / "src" / "assets"
TOPS_SEED = 421943594
OUTFLOW_INDEX = {"n": 0, "e": 1, "s": 2, "w": 3}


def newest(paths: list[Path]) -> Path | None:
    return max(paths, key=lambda p: p.name) if paths else None


def prepare_rapids(src: Path) -> None:
    # Full exports only: skip `_latest` (a copy) and `_min<L>` (pre-filtered).
    candidates = [p for p in src.glob("rapids_*.json") if re.fullmatch(r"rapids_\d{8}_\d{6}\.json", p.name)]
    path = newest(candidates)
    if path is None:
        print("rapids: no rapids_<timestamp>.json found, skipping")
        return
    doc = json.loads(path.read_text(encoding="utf-8"))
    scan = doc.get("scan", {})
    if doc.get("seed") != TOPS_SEED:
        sys.exit(f"rapids: seed {doc.get('seed')} != TOPS seed {TOPS_SEED}; refusing to convert")
    if not scan.get("complete", False):
        print("rapids: WARNING scan.complete is false (partial export)")

    rows = []
    for f in doc["features"]:
        rows.append(
            [
                int(f["rel"]["x"]),
                int(f["abs"]["y"]),
                int(f["rel"]["z"]),
                OUTFLOW_INDEX[f["outflow"]],
                int(round(float(f["likelihood"]) * 1000)),
            ]
        )
    compact = {
        "v": 1,
        "generatedUtc": doc.get("generatedUtc"),
        "seed": doc.get("seed"),
        "worldSpawn": doc.get("worldSpawn"),
        "scan": {k: scan.get(k) for k in ("mode", "center", "radiusBlocks", "complete")},
        "fields": ["relX", "absY", "relZ", "outflow", "likelihoodPermille"],
        "outflow": ["n", "e", "s", "w"],
        "rows": rows,
    }
    base = path.stem
    out_dir = ASSETS / "GeneratedRapids" / base
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "rapids.compact.json"
    out.write_text(json.dumps(compact, separators=(",", ":")), encoding="utf-8")
    print(f"rapids: {len(rows)} features -> {out.relative_to(REPO_ROOT)} ({out.stat().st_size / 1e6:.2f} MB)")
    print(f"rapids: set GENERATED_RAPIDS_BASE_NAME = \"{base}\"")


def prepare_heightmap(src: Path, color_px: int, raw_px: int) -> None:
    folder = newest([p for p in src.glob("heightmap_*") if p.is_dir()])
    if folder is None:
        print("heightmap: no heightmap_<timestamp>/ folder found, skipping")
        return
    base = folder.name
    world = json.loads((folder / f"{base}.world.json").read_text(encoding="utf-8"))
    width, height = world["widthPx"], world["heightPx"]
    if width != height or width % raw_px != 0:
        sys.exit(f"heightmap: {width}x{height} must be square and a multiple of --raw-px {raw_px}")
    extent_x = width * world["blocksPerPixelX"]
    extent_z = height * world["blocksPerPixelZ"]

    out_dir = ASSETS / "Elevation" / base
    out_dir.mkdir(parents=True, exist_ok=True)

    color = Image.open(folder / world["imagePngRelative"]).convert("RGB")
    if color_px != width:
        color = color.resize((color_px, color_px), Image.LANCZOS)
    color_out = out_dir / f"{base}.webp"
    color.save(color_out, "WEBP", quality=80, method=4)
    print(f"heightmap: color -> {color_out.relative_to(REPO_ROOT)} ({color_out.stat().st_size / 1e6:.1f} MB)")

    raw = np.asarray(Image.open(folder / world["imageRawPngRelative"]).convert("RGB"))
    heights = raw[..., 0].astype(np.int32) * 256 + raw[..., 1]
    if heights.max() > 255:
        sys.exit("heightmap: heights exceed 255, an 8-bit raw cannot hold them")
    # Point-sample the centre pixel of each step x step block, matching the
    # exporter's point-sample semantics (an average would invent heights).
    step = width // raw_px
    sub = heights[step // 2 :: step, step // 2 :: step][:raw_px, :raw_px].astype(np.uint8)
    raw_out = out_dir / f"{base}.h8.png"
    Image.fromarray(sub, "L").save(raw_out, optimize=True)
    print(f"heightmap: raw -> {raw_out.relative_to(REPO_ROOT)} ({raw_out.stat().st_size / 1e6:.1f} MB)")

    def georef(px: int, image: str, raw_image: str) -> dict:
        w = dict(world)
        w.update(
            {
                "widthPx": px,
                "heightPx": px,
                "blocksPerPixelX": extent_x / px,
                "blocksPerPixelZ": extent_z / px,
                "imagePngRelative": image,
                "imageRawPngRelative": raw_image,
                "rawDecodeFormula": "height = R  (8-bit greyscale; Y of the highest solid terrain block)",
                "sourceWidthPx": width,
            }
        )
        return w

    (out_dir / f"{base}.world.json").write_text(
        json.dumps(georef(color_px, color_out.name, raw_out.name), indent=2), encoding="utf-8"
    )
    (out_dir / f"{base}.h8.world.json").write_text(
        json.dumps(georef(raw_px, raw_out.name, raw_out.name), indent=2), encoding="utf-8"
    )
    print(f"heightmap: set ELEVATION_BASE_NAME = \"{base}\"")
    print(f"heightmap: upload {color_out.name} + {raw_out.name} to R2 under elevation/{base}/")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export_folder", type=Path)
    ap.add_argument("--color-px", type=int, default=4000)
    ap.add_argument("--raw-px", type=int, default=2000)
    args = ap.parse_args()
    src: Path = args.export_folder
    if not src.is_dir():
        sys.exit(f"not a folder: {src}")
    prepare_rapids(src)
    prepare_heightmap(src, args.color_px, args.raw_px)


if __name__ == "__main__":
    main()
