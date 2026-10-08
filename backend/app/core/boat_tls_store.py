"""Boat-friendly translocators store.

A tiny admin-curated list of translocators that a sailboat route planner is
allowed to traverse (a TL that connects two water bodies). Persisted as a
single JSON object in R2 — there is no audit trail, moderation queue or
snapshots (unlike ``elk_walkable.json``); it's an admin-only toggle over a
handful of ids.

File shape (``boat_friendly_tls.json``)::

    {"version": 1, "tl_ids": ["x1,z1,x2,z2", ...]}

Each ``tl_id`` is the orientation-agnostic canonical id of a translocator
segment — the two endpoints sorted so either click orientation maps to the
same string. This mirrors the frontend ``tlIdForSegment`` in
``src/lib/tl-routing.ts``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import List

from . import r2_storage


logger = logging.getLogger("uvicorn.error")

CURRENT_VERSION = 1
BOAT_FRIENDLY_TLS_KEY = "boat_friendly_tls.json"

# Serialises read-modify-write so concurrent admin toggles can't clobber each
# other. In-process only — the list is admin-only and writes are rare, so a
# cross-instance lease (as elk-walkable uses) is overkill here.
_write_lock = asyncio.Lock()


def boat_friendly_tls_write_lock() -> asyncio.Lock:
    return _write_lock


def canonical_tl_id(tl_id: str) -> str:
    """Normalise ``"x1,z1,x2,z2"`` to an orientation-agnostic form.

    Matches ``tlIdForSegment`` in the frontend: the endpoint with the smaller
    (x, then z) comes first. Raises ``ValueError`` on malformed input.
    """
    parts = [p.strip() for p in tl_id.split(",")]
    if len(parts) != 4:
        raise ValueError(f"tl_id must have 4 comma-separated numbers: {tl_id!r}")
    try:
        x1, z1, x2, z2 = (int(float(p)) for p in parts)
    except ValueError as exc:
        raise ValueError(f"tl_id has non-numeric component: {tl_id!r}") from exc
    if x1 < x2 or (x1 == x2 and z1 <= z2):
        return f"{x1},{z1},{x2},{z2}"
    return f"{x2},{z2},{x1},{z1}"


def _read_raw() -> dict:
    try:
        raw = r2_storage.download_bytes(BOAT_FRIENDLY_TLS_KEY)
    except FileNotFoundError:
        return {"version": CURRENT_VERSION, "tl_ids": []}
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001 - corrupt file falls back to empty
        logger.warning("boat_friendly_tls.json is corrupt; treating as empty")
        return {"version": CURRENT_VERSION, "tl_ids": []}
    ids = data.get("tl_ids")
    if not isinstance(ids, list):
        ids = []
    return {"version": CURRENT_VERSION, "tl_ids": [str(i) for i in ids]}


def list_boat_friendly_tls() -> List[str]:
    """Return the current canonical boat-friendly TL ids (deduped, sorted)."""
    data = _read_raw()
    out: set[str] = set()
    for tl_id in data["tl_ids"]:
        try:
            out.add(canonical_tl_id(tl_id))
        except ValueError:
            continue
    return sorted(out)


def _write(tl_ids: List[str]) -> None:
    payload = json.dumps(
        {"version": CURRENT_VERSION, "tl_ids": tl_ids},
        separators=(",", ":"),
    ).encode("utf-8")
    r2_storage.upload_bytes(
        BOAT_FRIENDLY_TLS_KEY, payload, content_type="application/json"
    )


def toggle_boat_friendly_tl(tl_id: str, enabled: bool) -> List[str]:
    """Add or remove ``tl_id`` from the list, returning the new list.

    Must be called while holding :func:`boat_friendly_tls_write_lock`.
    """
    canonical = canonical_tl_id(tl_id)
    current = set(list_boat_friendly_tls())
    if enabled:
        current.add(canonical)
    else:
        current.discard(canonical)
    new_list = sorted(current)
    _write(new_list)
    return new_list
