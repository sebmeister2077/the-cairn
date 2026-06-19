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
import copy
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Optional, Tuple

from fastapi import HTTPException

from . import database as db
from . import feature_flags as ff
from . import r2_storage


logger = logging.getLogger("uvicorn.error")

CURRENT_VERSION = 1
_LOCK_RESOURCE = "elk_walkable"

# Snapshot cadence. The store keeps a rolling pre-mutation snapshot of
# ``elk_walkable.json`` in R2 so admins can roll back catastrophic
# damage, but the per-row audit log is the real source of truth for
# replaying individual edits. We reuse the most recent snapshot until
# this many days have elapsed since it was written; admins can override
# the interval via the ``elk_walkable_snapshot_interval_days`` feature
# flag (numeric value_int; 0 forces a snapshot every mutation).
_SNAPSHOT_INTERVAL_FLAG = "elk_walkable_snapshot_interval_days"
_SNAPSHOT_INTERVAL_DEFAULT_DAYS = 14

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


def _latest_snapshot_key() -> Optional[str]:
    """Return the lexicographically newest existing snapshot R2 key, or None.

    Snapshot keys embed an ISO-8601 UTC timestamp so reverse-sorted
    order matches chronological order.
    """
    prefix = r2_storage.ELK_WALKABLE_SNAPSHOTS_PREFIX
    try:
        keys = r2_storage.list_keys_with_prefix(prefix)
    except Exception:
        logger.exception("elk_walkable: snapshot listing failed")
        return None
    if not keys:
        return None
    keys.sort(reverse=True)
    return keys[0]


def _parse_snapshot_key_ts(key: str) -> Optional[datetime]:
    """Recover the UTC timestamp encoded in a snapshot R2 key.

    Mirrors :func:`r2_storage.elk_walkable_snapshot_key` which munges the
    ISO timestamp by stripping ``:`` and rewriting ``+`` as ``Z`` so the
    key is safe to use as a filename.
    """
    prefix = r2_storage.ELK_WALKABLE_SNAPSHOTS_PREFIX
    if not key.startswith(prefix) or not key.endswith(".json"):
        return None
    body = key[len(prefix):-len(".json")]
    # ``change_id`` is a 32-char uuid hex with no dashes; safe_ts does
    # contain dashes (in the date part) so rsplit once.
    safe_ts, _, _change_id = body.rpartition("-")
    if not safe_ts:
        return None
    for fmt in ("%Y-%m-%dT%H%M%S.%fZ%H%M", "%Y-%m-%dT%H%M%SZ%H%M"):
        try:
            return datetime.strptime(safe_ts, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _snapshot_interval() -> timedelta:
    days = ff.get_int(_SNAPSHOT_INTERVAL_FLAG, _SNAPSHOT_INTERVAL_DEFAULT_DAYS)
    return timedelta(days=max(0, days))


def _resolve_snapshot_key(pre_mutation: dict, change_id: str) -> str:
    """Reuse the most recent snapshot if it's still inside the configured
    interval; otherwise upload a fresh snapshot of ``pre_mutation``.

    The audit row ``snapshot_key`` references the baseline from which
    the chain of audits up to (and including) the row can be replayed.
    """
    interval = _snapshot_interval()
    latest_key = _latest_snapshot_key()
    if latest_key and interval.total_seconds() > 0:
        latest_ts = _parse_snapshot_key_ts(latest_key)
        if latest_ts is not None:
            age = datetime.now(timezone.utc) - latest_ts
            if age < interval:
                return latest_key
    return _write_snapshot(pre_mutation, change_id)


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
    # Deep-copy the pre-mutation state up-front so we can defer the
    # snapshot upload until we know there are actual changes to persist
    # and the configured interval has elapsed. Mutations below happen on
    # the edge dicts inside ``data``.
    pre_mutation = copy.deepcopy(data)
    by_key = _edges_by_key(data)
    change_id = uuid.uuid4().hex
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
        # No-op batch: nothing to persist, no snapshot needed.
        return {
            "change_id": change_id,
            "snapshot_key": None,
            "applied": [],
            "audit_ids": [],
        }

    data["edges"] = sorted(by_key.values(), key=lambda e: e["key"])
    data["version"] = CURRENT_VERSION
    _save_live(data)
    snapshot_key = _resolve_snapshot_key(pre_mutation, change_id)

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
    pre_mutation = copy.deepcopy(data)
    by_key = _edges_by_key(data)
    change_id = uuid.uuid4().hex

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
    snapshot_key = _resolve_snapshot_key(pre_mutation, change_id)

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

    restored["version"] = CURRENT_VERSION
    _save_live(restored)
    # Restore is destructive and unique, but we still honour the same
    # cadence: with the default 14-day interval the latest snapshot is
    # already a viable rollback target.
    pre_restore_snapshot_key = _resolve_snapshot_key(current, change_id)

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


# ---------------------------------------------------------------------------
# Reports (user-flagged wrongly-attested edges)
# ---------------------------------------------------------------------------

# Validation enum for the user-supplied "why is this edge wrong?" field.
# Kept tight on purpose so the admin queue doesn't accumulate free-form
# garbage; ``other`` exists as the escape hatch.
VALID_REPORT_REASONS = (
    "not_walkable",
    "dangerous_terrain",
    "incorrect_endpoints",
    "other",
)

_REPORT_DETAILS_MAX_LEN = 500


def submit_report(
    *,
    edge_key: str,
    reporter_api_key_id: Optional[str],
    reporter_display_name: Optional[str],
    reason: str,
    details: Optional[str],
) -> dict:
    """Insert a user-flagged report against a confirmed elk-walkable edge.

    Validates: ``reason`` against the enum, ``edge_key`` exists in the
    live JSON file (404 otherwise), and that the same reporter has no
    other open report for this edge (409 otherwise — the existing report
    id is returned in the detail body so the UI can deep-link).
    """
    if reason not in VALID_REPORT_REASONS:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_reason",
                "message": f"reason must be one of {list(VALID_REPORT_REASONS)}",
            },
        )

    trimmed: Optional[str] = None
    if details is not None:
        trimmed = details.strip()
        if len(trimmed) > _REPORT_DETAILS_MAX_LEN:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "details_too_long",
                    "message": f"details must be \u2264 {_REPORT_DETAILS_MAX_LEN} chars",
                },
            )
        if not trimmed:
            trimmed = None

    # Existence check against the live file. ``edges`` is small enough
    # (a few hundred entries) that a linear scan is fine.
    data = load_live()
    if not any(e.get("key") == edge_key for e in (data.get("edges") or [])):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "edge_not_found",
                "message": "That edge is not currently in the elk-walkable set.",
            },
        )

    existing_id = db.find_open_elk_walkable_report(
        edge_key=edge_key, reporter_api_key_id=reporter_api_key_id
    )
    if existing_id is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_open_report",
                "message": "You already have an open report for this edge.",
                "existing_report_id": existing_id,
            },
        )

    report_id = db.insert_elk_walkable_report(
        edge_key=edge_key,
        reporter_api_key_id=reporter_api_key_id,
        reporter_display_name=reporter_display_name,
        reason=reason,
        details=trimmed,
    )
    return {"report_id": report_id, "status": "open"}


def list_reports(
    *,
    status: Optional[str] = "open",
    edge_key: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[dict]:
    """Admin queue lookup. Returns reports newest-first."""
    rows = db.list_elk_walkable_reports(
        status=status, edge_key=edge_key, limit=limit, offset=offset
    )
    out: List[dict] = []
    for r in rows:
        created = r.get("created_at")
        resolved = r.get("resolved_at")
        out.append({
            "id": int(r["id"]),
            "edge_key": r["edge_key"],
            "reporter_api_key_id": r.get("reporter_api_key_id"),
            "reporter_display_name": r.get("reporter_display_name"),
            "reason": r["reason"],
            "details": r.get("details"),
            "status": r["status"],
            "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
            "resolved_at": resolved.isoformat() if hasattr(resolved, "isoformat") else resolved,
            "resolved_by_api_key_id": r.get("resolved_by_api_key_id"),
            "resolution_note": r.get("resolution_note"),
        })
    return out


def remove_all_attestations(
    edge_key: str,
    *,
    actor_api_key_id: Optional[str],
    actor_display_name: Optional[str],
    note: Optional[str] = None,
) -> dict:
    """Strip every attester from ``edge_key`` and drop the edge.

    Used by the admin "resolve report → remove attestations" path. Behaves
    like ``apply_changes`` but doesn't require the actor to be on the
    attestation list. Writes one ``report_resolution`` audit row with the
    pre-mutation edge state in ``before_payload`` so a later admin can
    revert the removal via the existing audit-revert flow.

    Caller must hold :func:`elk_walkable_write_lock`.
    """
    data = load_live()
    by_key = _edges_by_key(data)
    prev = by_key.get(edge_key)
    if prev is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "edge_not_found",
                "message": "Edge is not in the live elk-walkable set.",
            },
        )

    change_id = uuid.uuid4().hex
    snapshot_key = _write_snapshot(data, change_id)

    before_payload = json.loads(json.dumps(prev))
    by_key.pop(edge_key, None)
    data["edges"] = sorted(by_key.values(), key=lambda e: e["key"])
    data["version"] = CURRENT_VERSION
    _save_live(data)

    after_payload: dict = {"removed": True}
    if note:
        after_payload["note"] = note
    audit_id = db.insert_elk_walkable_audit(
        change_id=change_id,
        action="report_resolution",
        edge_key=edge_key,
        actor_api_key_id=actor_api_key_id,
        actor_display_name=actor_display_name,
        before_payload=before_payload,
        after_payload=after_payload,
        snapshot_key=snapshot_key,
    )
    return {
        "change_id": change_id,
        "snapshot_key": snapshot_key,
        "audit_id": audit_id,
        "removed_attesters": len(before_payload.get("attested_by") or []),
    }


def resolve_report(
    report_id: int,
    *,
    admin_api_key_id: Optional[str],
    admin_display_name: Optional[str],
    action: str,
    note: Optional[str] = None,
) -> dict:
    """Transition an open report. ``action`` is ``dismiss`` or ``remove_attestations``.

    ``remove_attestations`` strips every attester from the edge via
    :func:`remove_all_attestations` (caller must hold the write lock) and
    tags the resulting audit row so the action is traceable from both
    the report row and the audit log.
    """
    if action not in ("dismiss", "remove_attestations"):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_action",
                "message": "action must be 'dismiss' or 'remove_attestations'",
            },
        )
    report = db.get_elk_walkable_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="report not found")
    if report["status"] != "open":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "already_resolved",
                "message": f"report is already {report['status']}",
            },
        )

    audit_id: Optional[int] = None
    removed_attesters = 0
    if action == "remove_attestations":
        result = remove_all_attestations(
            report["edge_key"],
            actor_api_key_id=admin_api_key_id,
            actor_display_name=admin_display_name,
            note=note or f"report_id={report_id}",
        )
        audit_id = result["audit_id"]
        removed_attesters = result["removed_attesters"]

    new_status = "dismissed" if action == "dismiss" else "resolved"
    updated = db.resolve_elk_walkable_report(
        report_id,
        resolver_api_key_id=admin_api_key_id,
        new_status=new_status,
        note=note,
    )
    if not updated:
        # Race lost — someone resolved it between get + update.
        raise HTTPException(
            status_code=409,
            detail={"code": "already_resolved", "message": "report was just resolved"},
        )

    return {
        "report_id": report_id,
        "status": new_status,
        "audit_id": audit_id,
        "removed_attesters": removed_attesters,
    }

