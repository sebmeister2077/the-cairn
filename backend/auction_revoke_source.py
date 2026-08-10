#!/usr/bin/env python3
"""Revoke an auction contributor source and re-derive the public data without it.

Because a rebuild reads only NON-revoked raw objects, revoking a source drops its
data out of the published artifacts: auctions only it reported disappear, and any
it shared with others fall back to the best remaining evidence.

Usage:
    python auction_revoke_source.py <key_id> [--check] [--purge] [--env-file PATH]

``--check`` is a dry run: it reports how many auction ids would be removed /
changed WITHOUT revoking or publishing.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

_BACKEND_DIR = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("key_id")
    ap.add_argument("--check", action="store_true", help="dry run — report impact only")
    ap.add_argument("--purge", action="store_true", help="also delete the R2 object")
    ap.add_argument("--env-file", type=Path, default=_BACKEND_DIR / ".env.prod")
    args = ap.parse_args()

    if args.env_file.is_file():
        for k, v in dotenv_values(args.env_file).items():
            if v and not os.environ.get(k) and (k.startswith("R2_") or k == "SUPABASE_DB_URL"):
                os.environ[k] = v

    sys.path.insert(0, str(_BACKEND_DIR))
    from app.core import auction_raw_store, auction_rebuild  # noqa: E402
    from app.core import database as db  # noqa: E402

    row = db.get_api_key_by_id(args.key_id)
    if not row or not row.get("auction_contributor"):
        raise SystemExit(f"auction source not found: {args.key_id}")

    if args.check:
        impact = auction_rebuild.source_impact(args.key_id)
        print(f"dry-run impact of excluding {args.key_id}: {impact}")
        return

    db.revoke_api_key(row["key"])
    print(f"revoked {args.key_id}")
    if args.purge:
        auction_raw_store.delete_raw(args.key_id)
        print(f"purged {auction_raw_store.object_key(args.key_id)}")

    result = asyncio.run(auction_rebuild.rebuild_now())
    print(f"rebuilt + published: {result}")


if __name__ == "__main__":
    main()
