"""Look up which user account(s) an IP address belongs to.

The backend never stores raw client IPs — every IP is passed through
``app.auth._hash_ip`` (HMAC-SHA256, salted with ``IP_HASH_SALT``) and only the
digest is persisted. This tool takes a *raw* IP address, hashes it the exact
same way the API does, and prints the details of every user tied to that hash.

Two independent sources are consulted and merged:

  * ``api_keys.bound_identity`` — the IP a key is *locked* to. Only a minority
    of keys are ever bound, so this alone misses most accounts.
  * ``usage_events.ip_hash`` — the append-only analytics log records the acting
    ``actor_api_key_id`` next to each request's IP hash. This is the reliable
    source for "which accounts actually acted from this IP", and is enriched
    with activity stats (event count, first/last seen).

Each reported user is tagged with the source(s) that matched.

Because the salt is part of the hash, you must run this against the same
environment whose ``IP_HASH_SALT`` produced the stored digests — otherwise the
hashes will never match. Pick the environment with ``APP_ENV`` *before*
running so it loads the right ``.env.<APP_ENV>`` file. For production:

    # PowerShell
    $env:APP_ENV = 'prod'; python backend/lookup_user_by_ip.py 203.0.113.7

    # bash
    APP_ENV=prod python backend/lookup_user_by_ip.py 203.0.113.7

Multiple accounts can share a single IP (household, NAT, shared VPN exit), so
*all* matching users are reported — not just the first one.

Usage:
    python lookup_user_by_ip.py 203.0.113.7            # human-readable
    python lookup_user_by_ip.py 203.0.113.7 --json     # machine-readable
    python lookup_user_by_ip.py 203.0.113.7 --show-key # include the raw api_key

Read-only: issues nothing but ``SELECT`` statements.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional

# Ensure ``backend/`` is on sys.path so ``app.*`` imports resolve from any cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.auth import _hash_ip  # noqa: E402  (after path tweak)
from app.core import accounts_db  # noqa: E402  (after path tweak)
from app.core import database as db  # noqa: E402  (after path tweak)

# Columns we never print in plain text unless explicitly asked for.
_SENSITIVE_COLUMNS = {"api_key"}


def _redact(user: dict, show_key: bool) -> dict:
    """Return a copy of ``user`` with sensitive columns masked unless asked."""
    out = dict(user)
    if not show_key:
        for col in _SENSITIVE_COLUMNS:
            if out.get(col):
                out[col] = "<hidden — pass --show-key to reveal>"
    return out


def _dedupe_key(user: dict) -> str:
    """A stable identity for a user row, used to merge across sources."""
    return str(user.get("id") or user.get("api_key_id") or user.get("api_key"))


def lookup(ip: str) -> List[dict]:
    """Hash ``ip`` and return every matching user (bound + usage-events)."""
    ip_hash = _hash_ip(ip)
    return _merge_sources(
        accounts_db.list_users_for_ip_hash(ip_hash),
        accounts_db.list_users_for_ip_hash_via_usage_events(ip_hash),
    )


def _merge_sources(bound: List[dict], via_events: List[dict]) -> List[dict]:
    """Merge the two source lists, deduping by user identity.

    Each result carries ``match_source`` — ``bound_identity``, ``usage_events``
    or ``both``. Activity stats from ``usage_events`` are preserved. Results
    are ordered by most-recent activity first, then by display name.
    """
    merged: Dict[str, dict] = {}

    for u in bound:
        rec = dict(u)
        rec["match_source"] = "bound_identity"
        merged[_dedupe_key(u)] = rec

    for u in via_events:
        key = _dedupe_key(u)
        if key in merged:
            # Seen in both — keep the activity stats from the usage-events row.
            existing = merged[key]
            existing["match_source"] = "both"
            for col in ("event_count", "first_seen", "last_seen"):
                if u.get(col) is not None:
                    existing[col] = u[col]
        else:
            rec = dict(u)
            rec["match_source"] = "usage_events"
            merged[key] = rec

    rows = list(merged.values())
    # Most recently active first; rows without activity last; name tie-break.
    with_activity = [r for r in rows if r.get("last_seen") is not None]
    without = [r for r in rows if r.get("last_seen") is None]
    with_activity.sort(key=lambda r: r["last_seen"], reverse=True)
    without.sort(key=lambda r: str(r.get("display_name") or ""))
    return with_activity + without


def run(ip: str, *, as_json: bool = False, show_key: bool = False) -> int:
    ip = ip.strip()
    if not ip:
        print("error: an IP address is required", file=sys.stderr)
        return 2

    db.init_db()
    ip_hash = _hash_ip(ip)
    raw = _merge_sources(
        accounts_db.list_users_for_ip_hash(ip_hash),
        accounts_db.list_users_for_ip_hash_via_usage_events(ip_hash),
    )
    users = [_redact(u, show_key) for u in raw]

    if as_json:
        print(
            json.dumps(
                {"ip": ip, "ip_hash": ip_hash, "match_count": len(users), "users": users},
                indent=2,
                default=str,
            )
        )
        return 0 if users else 1

    _print_human(ip, ip_hash, users)
    return 0 if users else 1


def _print_human(ip: str, ip_hash: str, users: List[dict]) -> None:
    print(f"IP:       {ip}")
    print(f"IP hash:  {ip_hash}")
    print("-" * 64)

    if not users:
        print("No user is tied to this IP address (no key binding and no logged activity).")
        return

    noun = "user" if len(users) == 1 else "users"
    print(f"Found {len(users)} {noun} tied to this IP:\n")

    for i, user in enumerate(users, 1):
        name = user.get("display_name") or "(no display name)"
        source = user.get("match_source", "?")
        print(f"[{i}] {name}   (matched via: {source})")
        key_w = max(len(str(k)) for k in user)
        for col in sorted(user):
            if col == "display_name":
                continue
            print(f"      {col:<{key_w}}  {user[col]}")
        if i != len(users):
            print()


def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("ip", help="The raw IP address to look up, e.g. 203.0.113.7")
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    p.add_argument(
        "--show-key",
        action="store_true",
        help="Include the raw api_key in the output (hidden by default)",
    )
    return p.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    raise SystemExit(run(args.ip, as_json=args.json, show_key=args.show_key))
