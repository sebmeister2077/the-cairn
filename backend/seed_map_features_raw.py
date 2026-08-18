#!/usr/bin/env python3
"""Seed the private R2 raw map-features store with the committed bundle.

Assembles the split ``map-features.<category>.json`` assets currently committed
under ``frontend/src/assets/MapFeaturesJson/`` into one combined
``MapExportDocument`` and uploads it to ``map-features/raw/seed.json.gz`` in the
PRIVATE bucket. The rebuild always includes this trusted seed alongside live
contributor files, so the merged public dataset starts from the existing data.
Run once during cutover.

Credentials come from ``--env-file`` (default ``backend/.env.prod``); the
private bucket name comes from ``--private-bucket`` or ``R2_PRIVATE_BUCKET_NAME``.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

_BACKEND_DIR = Path(__file__).resolve().parent
_ASSETS_DIR = _BACKEND_DIR.parent / "frontend" / "src" / "assets" / "MapFeaturesJson"

# split-file category -> MapExportDocument key
_CATS = {
    "translocators": "translocators",
    "traders": "traders",
    "rapids": "rapids",
    "traderclaims": "traderClaims",
    "playerclaims": "playerClaims",
}


def _load_split(assets_dir: Path) -> dict:
    doc: dict = {}
    for cat, doc_key in _CATS.items():
        path = assets_dir / f"map-features.{cat}.json"
        if not path.is_file():
            doc[doc_key] = []
            continue
        env = json.loads(path.read_text(encoding="utf-8"))
        doc[doc_key] = env.get("features") or []
        if env.get("upstream") and not doc.get("upstream"):
            doc["upstream"] = env["upstream"]
        if env.get("worldSpawn") is not None and doc.get("worldSpawn") is None:
            doc["worldSpawn"] = env["worldSpawn"]
        if env.get("generatedUtc") and not doc.get("generatedUtc"):
            doc["generatedUtc"] = env["generatedUtc"]
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--assets-dir", type=Path, default=_ASSETS_DIR)
    ap.add_argument("--env-file", type=Path, default=_BACKEND_DIR / ".env.prod")
    ap.add_argument(
        "--private-bucket",
        default=os.environ.get("R2_PRIVATE_BUCKET_NAME", ""),
        help="Overrides R2_PRIVATE_BUCKET_NAME.",
    )
    args = ap.parse_args()

    if not args.assets_dir.is_dir():
        raise SystemExit(f"assets dir not found: {args.assets_dir}")

    if args.env_file.is_file():
        for k, v in dotenv_values(args.env_file).items():
            if k.startswith("R2_") and v and not os.environ.get(k):
                os.environ[k] = v
    if args.private_bucket:
        os.environ["R2_PRIVATE_BUCKET_NAME"] = args.private_bucket

    doc = _load_split(args.assets_dir)
    counts = {k: len(doc.get(v, [])) for k, v in _CATS.items()}
    if sum(counts.values()) == 0:
        raise SystemExit(f"no features found under {args.assets_dir}")

    sys.path.insert(0, str(_BACKEND_DIR))
    from app.core import map_features_raw_store  # noqa: E402 — after env setup

    gz = gzip.compress(json.dumps(doc, separators=(",", ":")).encode("utf-8"), mtime=0)
    map_features_raw_store.put_raw(map_features_raw_store.SEED_ID, gz)
    print(
        f"seeded {map_features_raw_store.object_key(map_features_raw_store.SEED_ID)} "
        f"({len(gz) / 1024:,.1f} KB gz) {counts}"
    )


if __name__ == "__main__":
    main()
