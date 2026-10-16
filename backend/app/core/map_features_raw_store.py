"""Private R2 store for per-contributor raw map-features documents.

Each map-features contributor's full combined export (the ``MapExportDocument``
the VSProxy ``--map-export`` writer accumulates: translocators, traders,
rapids, trader claims, player claims) is stored as one gzipped JSON object at
``<MAP_FEATURES_RAW_PREFIX>/<source_id>.json.gz`` in a PRIVATE bucket. A
contribution overwrites only its own object (atomic per-object PUT), so N
contributors keep exactly N objects (+ the ``seed`` object) and no user can
clobber another user's data. The rebuild reads every non-revoked object, merges
them per category, and republishes the public per-category files.

This mirrors ``auction_raw_store`` but stores one JSON document per source
instead of a JSONL stream.

In addition to the base object, a contributor may accumulate an append-only
stream of **delta** objects at ``<prefix>/<source_id>/delta-<seq>.json.gz`` (one
tiny ``{upserts, removals}`` change set per push). The rebuild reconstructs the
contributor's current document from its base + ordered deltas; a full (replace)
upload rewrites the base and clears the delta stream.
"""

from __future__ import annotations

import gzip
import io
import json
import logging
import threading
from typing import Any, Dict, List, Optional

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from ..config import settings

logger = logging.getLogger("uvicorn.error")

# The seed object holds the historical merged export; always included, no key.
SEED_ID = "seed"

# Reuse ONE boto3 client process-wide. Creating a client per call leaked memory
# (~one client's worth of botocore/urllib3 state each rebuild+ingest cycle);
# botocore clients are thread-safe, so a shared singleton is safe here.
_client_singleton = None
_client_lock = threading.Lock()


def _client():
    global _client_singleton
    if _client_singleton is not None:
        return _client_singleton
    if not (
        settings.R2_ACCOUNT_ID
        and settings.R2_ACCESS_KEY_ID
        and settings.R2_SECRET_ACCESS_KEY
    ):
        raise RuntimeError("R2 credentials not configured (R2_ACCOUNT_ID/KEY/SECRET)")
    with _client_lock:
        if _client_singleton is None:
            _client_singleton = boto3.client(
                "s3",
                endpoint_url=settings.R2_ENDPOINT_URL,
                aws_access_key_id=settings.R2_ACCESS_KEY_ID,
                aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
                config=BotoConfig(
                    signature_version="s3v4",
                    retries={"max_attempts": 3, "mode": "standard"},
                ),
                region_name="auto",
            )
    return _client_singleton


def _bucket() -> str:
    b = (settings.R2_PRIVATE_BUCKET_NAME or "").strip()
    if not b:
        raise RuntimeError("R2_PRIVATE_BUCKET_NAME not configured")
    return b


def _prefix() -> str:
    return (settings.MAP_FEATURES_RAW_PREFIX or "map-features/raw").strip("/")


def object_key(source_id: str) -> str:
    return f"{_prefix()}/{source_id}.json.gz"


# Delta objects live UNDER a per-contributor pseudo-folder so they never collide
# with a base object or another contributor: ``<prefix>/<source_id>/delta-<seq>.json.gz``.
# ``seq`` is zero-padded so a lexical R2 listing is already in apply order.
_DELTA_SUFFIX = ".json.gz"


def delta_object_key(source_id: str, seq: int) -> str:
    return f"{_prefix()}/{source_id}/delta-{int(seq):012d}{_DELTA_SUFFIX}"


def _gzip_json(obj: Dict[str, Any]) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(json.dumps(obj, separators=(",", ":")).encode("utf-8"))
    return buf.getvalue()


def put_raw(source_id: str, gz_bytes: bytes) -> None:
    """Store (overwrite) a contributor's gzipped map-features base document."""
    _client().put_object(
        Bucket=_bucket(),
        Key=object_key(source_id),
        Body=gz_bytes,
        ContentType="application/json",
        ContentEncoding="gzip",
        CacheControl="no-store",
    )


def put_delta(source_id: str, seq: int, delta: Dict[str, Any]) -> None:
    """Store one append-only delta object for a contributor (gzipped JSON)."""
    _client().put_object(
        Bucket=_bucket(),
        Key=delta_object_key(source_id, seq),
        Body=_gzip_json(delta),
        ContentType="application/json",
        ContentEncoding="gzip",
        CacheControl="no-store",
    )


def get_raw(source_id: str) -> Optional[bytes]:
    """Return the raw gzipped bytes for a source, or None if absent."""
    try:
        resp = _client().get_object(Bucket=_bucket(), Key=object_key(source_id))
        return resp["Body"].read()
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise


def delete_raw(source_id: str) -> None:
    _client().delete_object(Bucket=_bucket(), Key=object_key(source_id))


def _iter_objects(prefix: str):
    """Yield every object under ``prefix`` (paginated)."""
    client = _client()
    token = None
    while True:
        kwargs = {"Bucket": _bucket(), "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            yield obj
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break


def _parse_delta_seq(name: str) -> Optional[int]:
    """``<sid>/delta-<seq>.json.gz`` -> ``seq`` (or None if it isn't a delta)."""
    try:
        _sid, fname = name.split("/", 1)
    except ValueError:
        return None
    if not (fname.startswith("delta-") and fname.endswith(_DELTA_SUFFIX)):
        return None
    try:
        return int(fname[len("delta-"): -len(_DELTA_SUFFIX)])
    except ValueError:
        return None


def list_raw_objects() -> List[Dict[str, Any]]:
    """Return ``{id, etag, last_modified}`` for every BASE source object.

    Delta objects (which live under ``<id>/delta-*``) are excluded — use
    :func:`list_grouped_objects` to get a contributor's deltas. The rebuild uses
    ``etag`` to detect (cheaply, without downloading) whether a source changed
    and ``last_modified`` to order sources for the last-writer-wins merge."""
    prefix = _prefix() + "/"
    out: List[Dict[str, Any]] = []
    for obj in _iter_objects(prefix):
        name = obj["Key"][len(prefix):]
        # Base objects are a flat ``<id>.json.gz`` — never nested under a folder.
        if "/" in name or not name.endswith(".json.gz"):
            continue
        out.append(
            {
                "id": name[: -len(".json.gz")],
                "etag": (obj.get("ETag") or "").strip('"'),
                "last_modified": obj.get("LastModified"),
            }
        )
    return out


def list_deltas(source_id: str) -> List[Dict[str, Any]]:
    """Return ``{seq, etag, last_modified}`` for a contributor's delta objects,
    ordered by ``seq`` (ascending apply order)."""
    prefix = f"{_prefix()}/{source_id}/"
    out: List[Dict[str, Any]] = []
    for obj in _iter_objects(prefix):
        name = obj["Key"][len(_prefix()) + 1:]  # strip ``<prefix>/``
        seq = _parse_delta_seq(name)
        if seq is None:
            continue
        out.append(
            {
                "seq": seq,
                "etag": (obj.get("ETag") or "").strip('"'),
                "last_modified": obj.get("LastModified"),
            }
        )
    out.sort(key=lambda d: d["seq"])
    return out


def list_grouped_objects() -> Dict[str, Dict[str, Any]]:
    """Single-listing grouping of the whole raw prefix into per-contributor
    ``{id: {"base": {etag,last_modified}|None, "deltas": [{seq,etag,last_modified}]}}``.

    One ``list_objects_v2`` pass feeds both the rebuild fold and the ETag
    fingerprint, so a contributor's base + every delta are discovered together."""
    prefix = _prefix() + "/"
    groups: Dict[str, Dict[str, Any]] = {}

    def _slot(sid: str) -> Dict[str, Any]:
        return groups.setdefault(sid, {"base": None, "deltas": []})

    for obj in _iter_objects(prefix):
        name = obj["Key"][len(prefix):]
        if not name.endswith(".json.gz"):
            continue
        info = {
            "etag": (obj.get("ETag") or "").strip('"'),
            "last_modified": obj.get("LastModified"),
        }
        if "/" in name:
            sid = name.split("/", 1)[0]
            seq = _parse_delta_seq(name)
            if seq is None:
                continue
            _slot(sid)["deltas"].append({"seq": seq, **info})
        else:
            _slot(name[: -len(".json.gz")])["base"] = info
    for slot in groups.values():
        slot["deltas"].sort(key=lambda d: d["seq"])
    return groups


def delete_deltas(source_id: str) -> int:
    """Delete every delta object for a contributor (used on a full replace /
    compaction). Returns the number of objects removed."""
    client = _client()
    prefix = f"{_prefix()}/{source_id}/"
    keys = [
        {"Key": obj["Key"]}
        for obj in _iter_objects(prefix)
        if _parse_delta_seq(obj["Key"][len(_prefix()) + 1:]) is not None
    ]
    removed = 0
    for i in range(0, len(keys), 1000):  # S3/R2 delete_objects caps at 1000
        batch = keys[i: i + 1000]
        client.delete_objects(Bucket=_bucket(), Delete={"Objects": batch, "Quiet": True})
        removed += len(batch)
    return removed


def list_raw_ids() -> List[str]:
    """Return the base source ids present under the raw prefix (no prefix/suffix)."""
    return [o["id"] for o in list_raw_objects()]


def get_document(source_id: str) -> Optional[Dict[str, Any]]:
    """Return a source's stored ``MapExportDocument`` (parsed), or None."""
    gz = get_raw(source_id)
    if not gz:
        return None
    try:
        obj = json.loads(gzip.decompress(gz).decode("utf-8"))
    except (OSError, EOFError, ValueError) as exc:
        logger.warning("[map-features] could not parse raw source %s: %s", source_id, exc)
        return None
    return obj if isinstance(obj, dict) else None


def get_delta_document(source_id: str, seq: int) -> Optional[Dict[str, Any]]:
    """Return one parsed delta object for a contributor, or None if absent."""
    try:
        resp = _client().get_object(
            Bucket=_bucket(), Key=delta_object_key(source_id, seq)
        )
        gz = resp["Body"].read()
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    try:
        obj = json.loads(gzip.decompress(gz).decode("utf-8"))
    except (OSError, EOFError, ValueError) as exc:
        logger.warning(
            "[map-features] could not parse delta %s/%s: %s", source_id, seq, exc
        )
        return None
    return obj if isinstance(obj, dict) else None
