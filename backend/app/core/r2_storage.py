"""Cloudflare R2 storage client (S3-compatible).

Stores:
  - globalservermap.db   → the combined community map
  - pending/{id}.db      → individual pending contribution databases
    - pending/{id}.png     → rendered preview images for pending contributions
    - cache/tops-map-*.png → pre-rendered TOPS map viewer images
"""

import os

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


def generate_presigned_download_url(
    key: str,
    *,
    expires_seconds: int,
    content_type: str = "image/png",
) -> str:
    """Generate a presigned GET URL so clients can fetch an R2 object directly.

    The URL is self-contained — no API key is required by the client.
    Expiry is clamped to 7 days (S3v4 maximum).
    Returns an empty string if the object does not exist.
    """
    if not object_exists(key):
        return ""
    clamped = min(expires_seconds, _MAX_PRESIGN_SECONDS)
    return _get_client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": key,
            "ResponseContentType": content_type,
        },
        ExpiresIn=clamped,
    )


def delete_object(key: str):
    """Delete an object from R2. Silently ignores missing keys."""
    try:
        _get_client().delete_object(Bucket=_bucket(), Key=key)
    except ClientError:
        pass


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
