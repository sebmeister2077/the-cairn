"""Elk-walkable edges store — read/write helpers around the
``elk_walkable.json`` R2 object and the ``elk_walkable_audit`` table.

Edges identify a pair of TL endpoints by their stable ``id`` (assigned
by the translocator migration). Canonical key is the two
``"<tl_id>:<endpoint_idx>"`` strings sorted lexicographically and joined
with ``|`` so direction is irrelevant.

Mutations always:
  1. Snapshot the current ``elk_walkable.json`` to
     ``elk_walkable/snapshots/<ts>-<change_id>.json`` (so the file can be
     restored to any prior state).
  2. Apply the change to an in-memory copy.
  3. Re-upload the live file.
  4. Append one ``elk_walkable_audit`` row per logical change in the
     batch — all rows share the same ``change_id`` and ``snapshot_key``.

Concurrency: callers wrap calls in :func:`elk_walkable_write_lock` which
combines the in-process asyncio lock with the cross-instance
``geojson_lock`` lease (resource = ``elk_walkable``). See
``app/routes/contribute_tls.py`` for the same pattern.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Iterable, List, Optional, Tuple

from fastapi import HTTPException

from . import database as db
from . import r2_storage


logger = logging.getLogger("uvicorn.error")

CURRENT_VERSION = 1
_LOCK_RESOURCE = "elk_walkable"

_inproc_lock = asyncio.Lock()

# Mirrors ``contribute_tls._GEOJSON_LOCK_*`` knobs — keep behaviour
# consistent so users see the same "retry in a few seconds" UX.
_LOCK_WAIT_SECONDS = 15.0
_LOCK_POLL_SECONDS = 0.1


# ---------------------------------------------------------------------------
# Canonical edge key
# ---------------------------------------------------------------------------

def endpoint_token(tl_id: str, endpoint_idx: int) -> str:
    if not isinstance(tl_id, str) or not tl_id:
        raise ValueError("tl_id must be a non-empty string")
    if endpoint_idx not in (0, 1):
        raise ValueError("endpoint_idx must be 0 or 1")
    return f"{tl_id}:{endpoint_idx}"


def canonical_edge_key(
    a_tl_id: str, a_ep: int, b_tl_id: str, b_ep: int,
) -> str:
    a = endpoint_token(a_tl_id, a_ep)
    b = endpoint_token(b_tl_id, b_ep)
    if a == b:
        raise ValueError("edge endpoints must differ")
    lo, hi = (a, b) if a < b else (b, a)
    return f"{lo}|{hi}"


def parse_edge_key(key: str) -> Tuple[Tuple[str, int], Tuple[str, int]]:
    try:
        lo, hi = key.split("|", 1)
        lo_id, lo_ep = lo.rsplit(":", 1)
        hi_id, hi_ep = hi.rsplit(":", 1)
        return (lo_id, int(lo_ep)), (hi_id, int(hi_ep))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"invalid edge key {key!r}") from exc


# ---------------------------------------------------------------------------
# Lock
# ---------------------------------------------------------------------------

@contextlib.asynccontextmanager
async def elk_walkable_write_lock(action: str):
    async with _inproc_lock:
        token: Optional[str] = None
        deadline = time.monotonic() + _LOCK_WAIT_SECONDS
        while True:
            try:
                token = await asyncio.to_thread(
                    db.try_acquire_geojson_lock, _LOCK_RESOURCE, action
                )
            except Exception:
                logger.exception("elk_walkable: DB lock acquisition raised")
                raise HTTPException(
                    status_code=503,
                    detail="elk_walkable lock backend unavailable; retry",
                )
            if token:
                break
            if time.monotonic() >= deadline:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "elk_walkable.json is locked by another writer; "
                        "retry in a few seconds"
                    ),
                )
            await asyncio.sleep(_LOCK_POLL_SECONDS)
        try:
            yield token
        finally:
            try:
                await asyncio.to_thread(
                    db.release_geojson_lock, _LOCK_RESOURCE, token
                )
            except Exception:
                logger.exception("elk_walkable: DB lock release raised")


# ---------------------------------------------------------------------------
# File IO
# ---------------------------------------------------------------------------

def _empty_file() -> dict:
    return {"version": CURRENT_VERSION, "edges": []}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_live() -> dict:
    """Download + parse ``elk_walkable.json`` from R2. Returns an empty
    file shape if the object does not yet exist (first run)."""
    key = r2_storage.elk_walkable_live_key()
    try:
        raw = r2_storage.download_bytes(key)
    except FileNotFoundError:
        return _empty_file()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        logger.exception("elk_walkable: failed to parse R2 file")
        raise HTTPException(
            status_code=500, detail=f"Corrupt elk_walkable file: {exc}"
        )
    if not isinstance(data, dict) or not isinstance(data.get("edges"), list):
        raise HTTPException(
            status_code=500,
            detail="Corrupt elk_walkable file (no edges array)",
        )
    return data


def _save_live(data: dict) -> None:
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    key = r2_storage.elk_walkable_live_key()
    r2_storage.upload_bytes(key, body, content_type="application/json")
    r2_storage.invalidate_presigned_download_url(key)


def _write_snapshot(current: dict, change_id: str) -> str:
    """Upload a pre-mutation snapshot of ``current`` to R2. Returns the key."""
    ts = _now_iso()
    key = r2_storage.elk_walkable_snapshot_key(ts, change_id)
    body = json.dumps(current, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    r2_storage.upload_bytes(key, body, content_type="application/json")
    return key


def list_snapshots(limit: int = 200) -> List[dict]:
    prefix = r2_storage.ELK_WALKABLE_SNAPSHOTS_PREFIX
    try:
        keys = r2_storage.list_keys_with_prefix(prefix)
    except Exception:
        logger.exception("elk_walkable: snapshot listing failed")
        return []
    keys.sort(reverse=True)
    return [{"key": k} for k in keys[:limit]]


# ---------------------------------------------------------------------------
# In-memory mutation helpers
# ---------------------------------------------------------------------------

def _edges_by_key(data: dict) -> dict:
    by_key: dict = {}
    for e in data.get("edges") or []:
        if isinstance(e, dict) and isinstance(e.get("key"), str):
            by_key[e["key"]] = e
    return by_key


import re

# `xz:x1,z1,x2,z2` fallback ids are self-describing: they encode the
# segment's world coordinates directly (see `useOverlayData.parseTranslocators`).
# We accept them without checking the live R2 geojson because the user may
# be viewing a WebCartographer map whose translocators are sourced from a
# different host. Assigned `properties.id` strings still go through the
# membership check.
_XZ_FALLBACK_RE = re.compile(r"^xz:-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$")


def _validate_tl_ids(
    valid_tl_ids: Iterable[str],
    refs: Iterable[dict],
) -> None:
    s = set(valid_tl_ids)
    for r in refs:
        for side in ("a", "b"):
            ref = r.get(side) or {}
            tl_id = ref.get("tl_id")
            if not isinstance(tl_id, str) or not tl_id:
                raise HTTPException(
                    status_code=422,
                    detail=f"unknown translocator id: {tl_id!r}",
                )
            if tl_id in s:
                continue
            if _XZ_FALLBACK_RE.match(tl_id):
                continue
            raise HTTPException(
                status_code=422,
                detail=f"unknown translocator id: {tl_id!r}",
            )


# ---------------------------------------------------------------------------
# Public mutation API
# ---------------------------------------------------------------------------

def apply_changes(
    *,
    actor_api_key_id: Optional[str],
    actor_user_id: Optional[str],
    actor_display_name: Optional[str],
    attest: List[dict],
    unattest: List[dict],
    valid_tl_ids: Iterable[str],
    note: Optional[str] = None,
) -> dict:
    """Apply a batch of attest / unattest changes.

    ``attest`` / ``unattest`` entries are dicts of the form
    ``{"a": {"tl_id": str, "ep": 0|1}, "b": {"tl_id": str, "ep": 0|1}}``.

    Returns ``{change_id, snapshot_key, applied: [{key, action}], audit_ids}``.

    Caller must hold :func:`elk_walkable_write_lock`.
    """
    _validate_tl_ids(valid_tl_ids, attest)
    _validate_tl_ids(valid_tl_ids, unattest)

    # Normalise + dedupe within the batch.
    attest_keys: List[Tuple[str, dict]] = []
    seen: set = set()
    for r in attest:
        a, b = r["a"], r["b"]
        k = canonical_edge_key(a["tl_id"], int(a["ep"]), b["tl_id"], int(b["ep"]))
        if k in seen:
            continue
        seen.add(k)
        attest_keys.append((k, r))

    unattest_keys: List[Tuple[str, dict]] = []
    seen.clear()
    for r in unattest:
        a, b = r["a"], r["b"]
        k = canonical_edge_key(a["tl_id"], int(a["ep"]), b["tl_id"], int(b["ep"]))
        if k in seen:
            continue
        seen.add(k)
        unattest_keys.append((k, r))

    data = load_live()
    by_key = _edges_by_key(data)
    change_id = uuid.uuid4().hex
    snapshot_key = _write_snapshot(data, change_id)
    now_iso = _now_iso()

    applied: List[dict] = []
    before_states: dict = {}

    for k, r in attest_keys:
        prev = by_key.get(k)
        before_states[k] = json.loads(json.dumps(prev)) if prev else None
        if prev is None:
            edge = {
                "key": k,
                "a": {"tl_id": r["a"]["tl_id"], "ep": int(r["a"]["ep"])},
                "b": {"tl_id": r["b"]["tl_id"], "ep": int(r["b"]["ep"])},
                "attested_by": [],
                "first_attested_at": now_iso,
                "last_updated_at": now_iso,
            }
            by_key[k] = edge
            prev = edge
        attesters = prev.setdefault("attested_by", [])
        already = any(
            isinstance(a, dict) and a.get("user_id") == actor_user_id
            for a in attesters
        )
        if not already:
            entry = {
                "user_id": actor_user_id,
                "display_name": actor_display_name,
                "at": now_iso,
            }
            if note:
                entry["note"] = note
            attesters.append(entry)
            prev["last_updated_at"] = now_iso
            applied.append({"key": k, "action": "attest"})

    for k, _r in unattest_keys:
        prev = by_key.get(k)
        if prev is None:
            continue
        before_states[k] = json.loads(json.dumps(prev))
        attesters = prev.get("attested_by") or []
        new_attesters = [
            a for a in attesters
            if not (isinstance(a, dict) and a.get("user_id") == actor_user_id)
        ]
        if len(new_attesters) == len(attesters):
            # Caller hasn't attested this edge; nothing to remove.
            continue
        if new_attesters:
            prev["attested_by"] = new_attesters
            prev["last_updated_at"] = now_iso
        else:
            by_key.pop(k, None)
        applied.append({"key": k, "action": "unattest"})

    if not applied:
        # No-op batch: still wrote a snapshot but that's harmless.
        return {
            "change_id": change_id,
            "snapshot_key": snapshot_key,
            "applied": [],
            "audit_ids": [],
        }

    data["edges"] = sorted(by_key.values(), key=lambda e: e["key"])
    data["version"] = CURRENT_VERSION
    _save_live(data)

    audit_ids: List[int] = []
    for change in applied:
        k = change["key"]
        action = change["action"]
        after = by_key.get(k)
        audit_id = db.insert_elk_walkable_audit(
            change_id=change_id,
            action=action,
            edge_key=k,
            actor_api_key_id=actor_api_key_id,
            actor_display_name=actor_display_name,
            before_payload=before_states.get(k),
            after_payload=json.loads(json.dumps(after)) if after else None,
            snapshot_key=snapshot_key,
        )
        audit_ids.append(audit_id)

    return {
        "change_id": change_id,
        "snapshot_key": snapshot_key,
        "applied": applied,
        "audit_ids": audit_ids,
    }


# ---------------------------------------------------------------------------
# Admin: per-row revert + full-file snapshot restore
# ---------------------------------------------------------------------------

def revert_audit_row(
    audit_id: int,
    *,
    actor_api_key_id: Optional[str],
    actor_display_name: Optional[str],
) -> dict:
    """Invert one audit row's mutation. Records a new ``admin_revert`` row.

    Caller must hold :func:`elk_walkable_write_lock`.
    """
    row = db.get_elk_walkable_audit(audit_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"audit {audit_id} not found")
    action = row["action"]
    if action not in ("attest", "unattest"):
        raise HTTPException(
            status_code=400,
            detail=f"cannot revert audit row with action={action!r}",
        )

    data = load_live()
    by_key = _edges_by_key(data)
    change_id = uuid.uuid4().hex
    snapshot_key = _write_snapshot(data, change_id)

    edge_key = row["edge_key"]
    before_state = row.get("before_payload")
    current = by_key.get(edge_key)

    # Invert: restore the before state for this edge.
    before_after = json.loads(json.dumps(current)) if current else None
    if before_state is None:
        by_key.pop(edge_key, None)
    else:
        by_key[edge_key] = json.loads(json.dumps(before_state))

    data["edges"] = sorted(by_key.values(), key=lambda e: e["key"])
    _save_live(data)

    audit_id_new = db.insert_elk_walkable_audit(
        change_id=change_id,
        action="admin_revert",
        edge_key=edge_key,
        actor_api_key_id=actor_api_key_id,
        actor_display_name=actor_display_name,
        before_payload=before_after,
        after_payload=by_key.get(edge_key),
        snapshot_key=snapshot_key,
    )
    return {
        "change_id": change_id,
        "snapshot_key": snapshot_key,
        "audit_id": audit_id_new,
        "reverted_audit_id": audit_id,
    }


def restore_snapshot(
    snapshot_key: str,
    *,
    actor_api_key_id: Optional[str],
    actor_display_name: Optional[str],
) -> dict:
    """Replace the live file with a previously-snapshotted version.

    Writes a fresh pre-restore snapshot first so the operation is itself
    reversible, then records one ``admin_restore_snapshot`` audit row.

    Caller must hold :func:`elk_walkable_write_lock`.
    """
    if not snapshot_key.startswith(r2_storage.ELK_WALKABLE_SNAPSHOTS_PREFIX):
        raise HTTPException(status_code=400, detail="invalid snapshot key")
    try:
        raw = r2_storage.download_bytes(snapshot_key)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"snapshot {snapshot_key} not found")
    try:
        restored = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"corrupt snapshot {snapshot_key}: {exc}"
        )
    if not isinstance(restored, dict) or not isinstance(restored.get("edges"), list):
        raise HTTPException(
            status_code=500,
            detail=f"snapshot {snapshot_key} is not a valid elk_walkable file",
        )

    current = load_live()
    change_id = uuid.uuid4().hex
    pre_restore_snapshot_key = _write_snapshot(current, change_id)

    restored["version"] = CURRENT_VERSION
    _save_live(restored)

    audit_id_new = db.insert_elk_walkable_audit(
        change_id=change_id,
        action="admin_restore_snapshot",
        edge_key=None,
        actor_api_key_id=actor_api_key_id,
        actor_display_name=actor_display_name,
        before_payload={"edge_count": len(current.get("edges") or [])},
        after_payload={
            "edge_count": len(restored.get("edges") or []),
            "restored_from": snapshot_key,
        },
        snapshot_key=pre_restore_snapshot_key,
    )
    return {
        "change_id": change_id,
        "snapshot_key": pre_restore_snapshot_key,
        "audit_id": audit_id_new,
        "restored_from": snapshot_key,
    }
