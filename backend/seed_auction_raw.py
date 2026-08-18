#!/usr/bin/env python3
"""Seed the private R2 raw-auction store with the existing merged capture.

Uploads ``auction-events.jsonl`` (the ~25k-id file already merged across your
machines) to ``auction/raw/seed.jsonl.gz`` in the PRIVATE bucket. The rebuild
always includes this trusted seed alongside live contributor files. Run once
during cutover.

Credentials come from ``--env-file`` (default ``backend/.env.prod``) so you can
run it locally without exporting R2 vars; the private bucket name comes from
``--private-bucket`` or ``R2_PRIVATE_BUCKET_NAME``.

Pass ``--registry`` to also upload the game registry (id -> code/name) to
``auction/registry.json.gz``. The API host doesn't ship the ``frontend/`` folder,
so without this object the server-side rebuild can't resolve item names and
publishes id-only listings.
"""

from __future__ import annotations

import argparse
import gzip
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

_BACKEND_DIR = Path(__file__).resolve().parent
_DEFAULT_INPUT = (
    _BACKEND_DIR.parent / "frontend" / "src" / "assets" / "Auction" / "auction-events.jsonl"
)
_DEFAULT_REGISTRY = (
    _BACKEND_DIR.parent / "frontend" / "src" / "assets" / "Auction" / "registry-tops.vintagestory.at.json"
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    ap.add_argument(
        "--registry",
        type=Path,
        nargs="?",
        const=_DEFAULT_REGISTRY,
        default=None,
        help="Also upload this game registry (id->code/name) to the private bucket so "
        "the server-side rebuild can resolve item names. Bare flag uses the default "
        "frontend registry file.",
    )
    ap.add_argument("--env-file", type=Path, default=_BACKEND_DIR / ".env.prod")
    ap.add_argument(
        "--private-bucket",
        default=os.environ.get("R2_PRIVATE_BUCKET_NAME", ""),
        help="Overrides R2_PRIVATE_BUCKET_NAME.",
    )
    args = ap.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"input not found: {args.input}")
    if args.registry is not None and not args.registry.is_file():
        raise SystemExit(f"registry not found: {args.registry}")

    # Populate R2 credentials from the env file (without clobbering a value that
    # is already exported) BEFORE importing app.config, which reads them once.
    if args.env_file.is_file():
        for k, v in dotenv_values(args.env_file).items():
            if k.startswith("R2_") and v and not os.environ.get(k):
                os.environ[k] = v
    if args.private_bucket:
        os.environ["R2_PRIVATE_BUCKET_NAME"] = args.private_bucket

    sys.path.insert(0, str(_BACKEND_DIR))
    from app.core import auction_raw_store  # noqa: E402 — after env setup

    raw = args.input.read_bytes()
    gz = gzip.compress(raw, mtime=0)
    line_count = sum(1 for _ in raw.splitlines() if _.strip())
    auction_raw_store.put_raw(auction_raw_store.SEED_ID, gz)
    print(
        f"seeded {auction_raw_store.object_key(auction_raw_store.SEED_ID)} "
        f"({line_count:,} records, {len(gz) / 1024:,.1f} KB gz)"
    )

    if args.registry is not None:
        reg_gz = gzip.compress(args.registry.read_bytes(), mtime=0)
        auction_raw_store.put_registry(reg_gz)
        print(
            f"seeded {auction_raw_store._registry_key()} "
            f"(registry, {len(reg_gz) / 1024:,.1f} KB gz)"
        )



if __name__ == "__main__":
    main()
