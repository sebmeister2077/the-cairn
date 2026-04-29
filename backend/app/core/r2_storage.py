"""Cloudflare R2 storage client (S3-compatible).

Stores:
  - globalservermap.db   → the combined community map
  - pending/{id}.db      → individual pending contribution databases
    - pending/{id}.png     → rendered preview images for pending contributions
    - cache/tops-map-*.png → pre-rendered TOPS map viewer images
"""

import os
import threading
import time

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from ..config import settings

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
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
    return _client


def _bucket() -> str:
    return settings.R2_BUCKET_NAME


def upload_bytes(key: str, data: bytes, content_type: str = "application/octet-stream"):
    """Upload raw bytes to R2."""
    _get_client().put_object(
        Bucket=_bucket(),
        Key=key,
        Body=data,
        ContentType=content_type,
    )


def upload_file(local_path: str, key: str, content_type: str = "application/octet-stream"):
    """Upload a local file to R2 without reading it all into memory."""
    with open(local_path, "rb") as file_obj:
        _get_client().upload_fileobj(
            file_obj,
            _bucket(),
            key,
            ExtraArgs={"ContentType": content_type},
        )


def download_bytes(key: str) -> bytes:
    """Download an object from R2 as bytes. Raises FileNotFoundError if missing."""
    try:
        resp = _get_client().get_object(Bucket=_bucket(), Key=key)
        return resp["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise


def download_range(key: str, start: int, length: int) -> bytes:
    """Download a byte range ``[start, start+length)`` from an R2 object.

    Used to validate huge uploads (e.g. the SQLite header on a 4 GB file)
    without pulling the whole object onto the small Render instance.
    """
    if length <= 0:
        return b""
    end_inclusive = start + length - 1
    try:
        resp = _get_client().get_object(
            Bucket=_bucket(),
            Key=key,
            Range=f"bytes={start}-{end_inclusive}",
        )
        return resp["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise


def download_to_path(key: str, local_path: str):
    """Download an object from R2 to a local file path."""
    try:
        with open(local_path, "wb") as file_obj:
            _get_client().download_fileobj(_bucket(), key, file_obj)
    except ClientError as e:
        try:
            os.unlink(local_path)
        except OSError:
            pass
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise


def get_object_size(key: str) -> int:
    """Return object size in bytes. Raises FileNotFoundError if missing."""
    try:
        resp = _get_client().head_object(Bucket=_bucket(), Key=key)
        return int(resp.get("ContentLength", 0))
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise


def get_object_etag(key: str) -> str:
    """Return the ETag header for an R2 object (quotes stripped). Used as a
    content fingerprint for local file caching — if the ETag matches what
    we cached previously, the local copy is up-to-date and we can skip the
    download. Raises FileNotFoundError if the object is missing."""
    try:
        resp = _get_client().head_object(Bucket=_bucket(), Key=key)
        return (resp.get("ETag") or "").strip('"')
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise


def generate_presigned_upload_url(
    key: str,
    *,
    expires_seconds: int = 900,
    content_type: str = "application/octet-stream",
) -> str:
    """Generate a presigned PUT URL for direct browser uploads to R2."""
    return _get_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": _bucket(),
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=expires_seconds,
    )


# S3v4 presigned GET URLs are capped at 7 days (604800 s).
_MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60

# In-process cache for presigned download URLs.
#
# Why: the contribute /info endpoint is polled every 5s while a
# contribution is being validated/merged, and each poll regenerated a
# fresh signed URL for every history thumbnail and pending preview. The
# resulting URL strings differ only in their `X-Amz-Signature`/expires
# query params, but that's enough to bust frontend memoisation and
# break browser image caching (each new URL is a new resource).
#
# We cache the generated URL keyed by (key, content_type, expires_seconds)
# and reuse it until ~75% of its TTL has elapsed, then mint a fresh one.
# This keeps URLs stable for the whole polling lifetime of a normal
# admin session while still rotating well before the signature expires.
_presigned_cache: dict[tuple[str, str, int], tuple[str, float]] = {}
_presigned_cache_lock = threading.Lock()


def _cached_presigned_download_url(
    key: str,
    *,
    expires_seconds: int,
    content_type: str,
) -> str:
    cache_key = (key, content_type, expires_seconds)
    now = time.monotonic()
    with _presigned_cache_lock:
        cached = _presigned_cache.get(cache_key)
        if cached is not None:
            url, expires_at = cached
            if now < expires_at:
                return url
        url = _get_client().generate_presigned_url(
            "get_object",
            Params={
                "Bucket": _bucket(),
                "Key": key,
                "ResponseContentType": content_type,
            },
            ExpiresIn=min(expires_seconds, _MAX_PRESIGN_SECONDS),
        )
        # Refresh well before the signature actually expires (75% of TTL,
        # capped at 1 day so very long signatures still get rotated daily).
        reuse_for = min(int(expires_seconds * 0.75), 24 * 60 * 60)
        _presigned_cache[cache_key] = (url, now + reuse_for)
        # Opportunistic GC — drop expired entries so the dict doesn't grow
        # unboundedly across the lifetime of the process.
        if len(_presigned_cache) > 1024:
            stale = [k for k, (_, exp) in _presigned_cache.items() if exp <= now]
            for k in stale:
                _presigned_cache.pop(k, None)
        return url


def invalidate_presigned_download_url(key: str) -> None:
    """Drop any cached presigned URLs for ``key`` (e.g. after re-uploading
    or deleting the underlying object). Safe to call for unknown keys."""
    with _presigned_cache_lock:
        for cache_key in [k for k in _presigned_cache if k[0] == key]:
            _presigned_cache.pop(cache_key, None)


def generate_presigned_download_url(
    key: str,
    *,
    expires_seconds: int,
    content_type: str = "image/png",
    verify_exists: bool = True,
) -> str:
    """Generate a presigned GET URL so clients can fetch an R2 object directly.

    The URL is self-contained — no API key is required by the client.
    Expiry is clamped to 7 days (S3v4 maximum).
    When ``verify_exists`` is True, returns an empty string if the object does
    not exist (one HEAD round-trip per call). Pass False when the caller has
    already established existence (e.g. via a single bulk LIST) to skip the
    HEAD round-trip entirely.

    Generated URLs are cached in-process keyed by (key, content_type,
    expires_seconds) and reused for ~75% of their TTL so repeated calls
    (e.g. polling the /contribute/info endpoint) return the same string,
    which keeps frontend memoisation and the browser image cache stable.
    """
    if verify_exists and not object_exists(key):
        return ""
    return _cached_presigned_download_url(
        key,
        expires_seconds=expires_seconds,
        content_type=content_type,
    )


def delete_object(key: str):
    """Delete an object from R2. Silently ignores missing keys."""
    try:
        _get_client().delete_object(Bucket=_bucket(), Key=key)
    except ClientError:
        pass
    # Drop any cached presigned URLs so we don't keep handing out links
    # to a deleted object until their natural expiry.
    invalidate_presigned_download_url(key)


def object_exists(key: str) -> bool:
    """Check if an object exists in R2."""
    try:
        _get_client().head_object(Bucket=_bucket(), Key=key)
        return True
    except ClientError:
        return False


def copy_object(source_key: str, destination_key: str):
    """Copy an object within R2. Raises FileNotFoundError if source is missing."""
    try:
        _get_client().copy_object(
            Bucket=_bucket(),
            Key=destination_key,
            CopySource={"Bucket": _bucket(), "Key": source_key},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {source_key}")
        raise


def move_object(source_key: str, destination_key: str):
    """Move an object within R2 by copying then deleting the source."""
    copy_object(source_key, destination_key)
    delete_object(source_key)


# ---------------------------------------------------------------------------
# Key helpers — centralise path conventions
# ---------------------------------------------------------------------------

COMBINED_DB_KEY = "globalservermap.db"
TOPS_MAP_CACHE_DIM = 4096


def pending_db_key(contribution_id: str) -> str:
    return f"pending/{contribution_id}.db"


def pending_preview_key(contribution_id: str) -> str:
    return f"pending/{contribution_id}.png"


def archived_db_key(contribution_id: str) -> str:
    return f"archived/{contribution_id}.db"


def history_preview_key(contribution_id: str) -> str:
    """Long-lived preview PNG kept for the public history window (Phase 3)."""
    return f"history/{contribution_id}.png"


# ---------------------------------------------------------------------------
# Phase 2 — region-overwrite before/after preview pair
# ---------------------------------------------------------------------------

def region_before_preview_key(contribution_id: str) -> str:
    """PNG of the combined map cropped to the contribution's region BEFORE
    the merge would be applied."""
    return f"pending/{contribution_id}.before.png"


def region_after_preview_key(contribution_id: str) -> str:
    """PNG of the in-memory merged map cropped to the contribution's region —
    what the combined map would look like AFTER approval. Newly-added tiles
    tint green; overwritten tiles tint orange."""
    return f"pending/{contribution_id}.after.png"


# ---------------------------------------------------------------------------
# Phase 4b — per-contribution revert undo data
# ---------------------------------------------------------------------------

UNDO_KEY_PREFIX = "undo/"


def undo_added_key(contribution_id: str) -> str:
    """R2 key for the little-endian uint64 stream of positions inserted by
    a contribution's approval (gap-fill + region-overwrite both populate this)."""
    return f"{UNDO_KEY_PREFIX}{contribution_id}.added.bin"


def undo_replaced_key(contribution_id: str) -> str:
    """R2 key for the SQLite blob carrying ``(position, old_data)`` rows for
    every tile this contribution overwrote (region/overwrite mode only)."""
    return f"{UNDO_KEY_PREFIX}{contribution_id}.replaced.db"


# ---------------------------------------------------------------------------
# Phase 4a — weekly backups of the combined map .db
# ---------------------------------------------------------------------------

BACKUP_KEY_PREFIX = "backups/"


def backup_scheduled_key(iso_year: int, iso_week: int) -> str:
    """Key for the auto-snapshot of ISO calendar week ``iso_year``/``iso_week``.

    Naming follows ISO 8601: week 01 contains the first Thursday of the year,
    weeks always start on Monday (Python ``datetime.isocalendar()``).
    """
    return f"{BACKUP_KEY_PREFIX}backup-{iso_year:04d}-W{iso_week:02d}.db"


def backup_manual_key(iso_year: int, iso_week: int, unix_timestamp: int) -> str:
    """Key for an admin-triggered on-demand snapshot."""
    return (
        f"{BACKUP_KEY_PREFIX}backup-{iso_year:04d}-W{iso_week:02d}"
        f"-manual-{unix_timestamp}.db"
    )


def list_backup_objects() -> list:
    """Return raw R2 listing for ``backups/`` — dicts with Key, Size, LastModified."""
    out = []
    paginator = _get_client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=_bucket(), Prefix=BACKUP_KEY_PREFIX):
        for obj in page.get("Contents", []) or []:
            out.append(
                {
                    "key": obj["Key"],
                    "size": int(obj.get("Size", 0)),
                    "last_modified": obj.get("LastModified"),
                }
            )
    return out


def tops_map_cache_key(max_dimension: int = TOPS_MAP_CACHE_DIM) -> str:
    return f"cache/tops-map-{max_dimension}.png"


# ---------------------------------------------------------------------------
# Multi-resolution TOPS map cache (chunked)
# ---------------------------------------------------------------------------

def tops_map_level_assembled_key(level: int) -> str:
    """Final assembled PNG for a resolution level."""
    return f"cache/tops-map-level{level}.png"


def tops_map_level_chunk_key(level: int, cx: int, cy: int) -> str:
    """Per-chunk PNG within a resolution level (16×16 grid)."""
    return f"cache/tops-map-level{level}/chunk-{cx}-{cy}.png"


def tops_map_level_metadata_key(level: int) -> str:
    """JSON metadata describing a generated level (geometry, timestamps)."""
    return f"cache/tops-map-level{level}/metadata.json"


def list_keys_with_prefix(prefix: str) -> list:
    """Return a list of all object keys under the given prefix."""
    keys = []
    paginator = _get_client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=_bucket(), Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            keys.append(obj["Key"])
    return keys


def delete_keys(keys: list):
    """Delete a batch of object keys (best-effort, ignores missing)."""
    if not keys:
        return
    # S3 delete supports batches of up to 1000 keys per request.
    client = _get_client()
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        try:
            client.delete_objects(
                Bucket=_bucket(),
                Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True},
            )
        except ClientError:
            for k in chunk:
                delete_object(k)
