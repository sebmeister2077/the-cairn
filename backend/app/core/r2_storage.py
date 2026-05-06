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
from typing import Optional

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


def upload_file_with_metadata(
    local_path: str,
    key: str,
    *,
    metadata: dict,
    content_type: str = "application/octet-stream",
):
    """Like :func:`upload_file` but attaches user metadata (sent as
    ``x-amz-meta-*`` headers). All values are coerced to strings — boto3
    requires that. Used by the compressed combined-DB writer to embed the
    raw object's ETag so readers can detect a stale .zst sibling.
    """
    extra: dict = {"ContentType": content_type}
    if metadata:
        extra["Metadata"] = {str(k): str(v) for k, v in metadata.items()}
    with open(local_path, "rb") as file_obj:
        _get_client().upload_fileobj(file_obj, _bucket(), key, ExtraArgs=extra)


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


# ---------------------------------------------------------------------------
# Multipart upload helpers (browser → R2 direct, used for files >5 GiB which
# exceed the single-PUT cap, and recommended for any large upload to get
# resumability and parallel parts).
# ---------------------------------------------------------------------------

def create_multipart_upload(
    key: str,
    *,
    content_type: str = "application/octet-stream",
) -> str:
    """Initiate a multipart upload. Returns the ``UploadId`` to feed into
    subsequent ``upload_part``/``complete``/``abort`` calls."""
    resp = _get_client().create_multipart_upload(
        Bucket=_bucket(),
        Key=key,
        ContentType=content_type,
    )
    return resp["UploadId"]


def generate_presigned_upload_part_url(
    key: str,
    *,
    upload_id: str,
    part_number: int,
    expires_seconds: int = 900,
) -> str:
    """Generate a presigned PUT URL for a single multipart-upload part.

    The browser PUTs the part body to this URL and reads the ``ETag``
    response header (R2 CORS must expose ``ETag``). The frontend then
    sends ``{PartNumber, ETag}`` back to /multipart/complete."""
    return _get_client().generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": _bucket(),
            "Key": key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=expires_seconds,
    )


def complete_multipart_upload(
    key: str,
    *,
    upload_id: str,
    parts: list,
) -> None:
    """Finish a multipart upload. ``parts`` is a list of
    ``{"PartNumber": int, "ETag": str}`` dicts in ascending part order."""
    if not parts:
        raise ValueError("complete_multipart_upload requires at least one part")
    sorted_parts = sorted(parts, key=lambda p: p["PartNumber"])
    _get_client().complete_multipart_upload(
        Bucket=_bucket(),
        Key=key,
        UploadId=upload_id,
        MultipartUpload={"Parts": sorted_parts},
    )


def abort_multipart_upload(key: str, *, upload_id: str) -> None:
    """Abort an in-progress multipart upload, freeing its uploaded parts."""
    try:
        _get_client().abort_multipart_upload(
            Bucket=_bucket(),
            Key=key,
            UploadId=upload_id,
        )
    except ClientError:
        # Already aborted/completed — treat as success.
        pass


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
_presigned_cache: dict[tuple[str, str, int, str], tuple[str, float]] = {}
_presigned_cache_lock = threading.Lock()


def _cached_presigned_download_url(
    key: str,
    *,
    expires_seconds: int,
    content_type: str,
    content_disposition: Optional[str] = None,
) -> str:
    cache_key = (key, content_type, expires_seconds, content_disposition or "")
    now = time.monotonic()
    with _presigned_cache_lock:
        cached = _presigned_cache.get(cache_key)
        if cached is not None:
            url, expires_at = cached
            if now < expires_at:
                return url
        params: dict = {
            "Bucket": _bucket(),
            "Key": key,
            "ResponseContentType": content_type,
        }
        if content_disposition:
            params["ResponseContentDisposition"] = content_disposition
        url = _get_client().generate_presigned_url(
            "get_object",
            Params=params,
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
    content_disposition: Optional[str] = None,
) -> str:
    """Generate a presigned GET URL so clients can fetch an R2 object directly.

    The URL is self-contained — no API key is required by the client.
    Expiry is clamped to 7 days (S3v4 maximum).
    When ``verify_exists`` is True, returns an empty string if the object does
    not exist (one HEAD round-trip per call). Pass False when the caller has
    already established existence (e.g. via a single bulk LIST) to skip the
    HEAD round-trip entirely.

    ``content_disposition`` is forwarded as ``ResponseContentDisposition`` so
    callers can force the browser to download with a specific filename
    (e.g. ``attachment; filename="backup-2026-W17.db"``).

    Generated URLs are cached in-process keyed by (key, content_type,
    expires_seconds, content_disposition) and reused for ~75% of their TTL so
    repeated calls (e.g. polling the /contribute/info endpoint) return the
    same string, which keeps frontend memoisation and the browser image
    cache stable.
    """
    if verify_exists and not object_exists(key):
        return ""
    return _cached_presigned_download_url(
        key,
        expires_seconds=expires_seconds,
        content_type=content_type,
        content_disposition=content_disposition,
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


def head_artefact_with_format(raw_key: str) -> tuple[str, bool]:
    """Discover whether an artefact is stored raw or zstd-compressed.

    Given the **raw** key (e.g. ``archived/<id>.db``), HEADs both the raw
    key and its ``.zst`` sibling and returns ``(actual_key, is_compressed)``
    for whichever exists. ``.zst`` is preferred when both happen to exist
    (only possible during a migration window).

    Raises :class:`FileNotFoundError` when neither form is present.

    Used by the revert / restore read paths so the caller doesn't need to
    know whether the ``compress_artefacts`` flag was on at write time.
    """
    zstd_key = raw_key + ZSTD_SUFFIX
    if object_exists(zstd_key):
        return zstd_key, True
    if object_exists(raw_key):
        return raw_key, False
    raise FileNotFoundError(
        f"R2 artefact missing in both raw and zstd forms: {raw_key}"
    )


def head_object_metadata(key: str) -> dict:
    """Return the object's user metadata (lower-cased keys, str values).

    Wrapper around ``head_object`` that hides the boto3 response shape.
    Raises :class:`FileNotFoundError` if the object is missing.
    """
    try:
        resp = _get_client().head_object(Bucket=_bucket(), Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise
    return dict(resp.get("Metadata") or {})


def download_artefact_to_raw_path(raw_key: str, dst_raw_path: str) -> bool:
    """Download whichever form of ``raw_key`` exists (raw or ``.zst``) and
    deliver the raw bytes at ``dst_raw_path``. Returns True if the source
    was compressed, False if it was already raw. Raises :class:`FileNotFoundError`
    when neither form is present.

    Lets revert / restore code paths read archived artefacts without caring
    whether ``compress_artefacts`` was on at write time.
    """
    actual_key, is_compressed = head_artefact_with_format(raw_key)
    if not is_compressed:
        download_to_path(actual_key, dst_raw_path)
        return False
    # Compressed: stream into a temp .zst then decompress to dst.
    import tempfile as _tempfile  # local import keeps module init cheap
    fd, zst_path = _tempfile.mkstemp(suffix=".zst")
    os.close(fd)
    try:
        download_to_path(actual_key, zst_path)
        from .compression import decompress_file
        decompress_file(zst_path, dst_raw_path)
    finally:
        try:
            os.unlink(zst_path)
        except OSError:
            pass
    return True


def abort_stale_multipart_uploads(prefix: str, older_than_seconds: int = 3600) -> int:
    """Abort in-progress multipart uploads under ``prefix`` older than the cutoff.

    Crashes mid-``_multipart_copy`` leave parts that R2 keeps billing storage
    for until the upload is completed or aborted. Run this on startup (and
    after a manual backup) to reclaim that space.

    Returns the number of multipart uploads aborted.
    """
    client = _get_client()
    bucket = _bucket()
    now = time.time()
    aborted = 0
    paginator = client.get_paginator("list_multipart_uploads")
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for upload in page.get("Uploads", []) or []:
                initiated = upload.get("Initiated")
                if initiated is None:
                    continue
                age = now - initiated.timestamp()
                if age < older_than_seconds:
                    continue
                try:
                    client.abort_multipart_upload(
                        Bucket=bucket,
                        Key=upload["Key"],
                        UploadId=upload["UploadId"],
                    )
                    aborted += 1
                except ClientError:
                    # Another process may have aborted/completed it concurrently.
                    pass
    except ClientError:
        # ListMultipartUploads itself failed — nothing to do.
        return aborted
    return aborted


# S3/R2 single-shot CopyObject is limited to 5 GiB. For larger sources we
# must fall back to a server-side multipart copy (UploadPartCopy with byte
# ranges). We pick a threshold safely below the hard limit so we don't ever
# bump into "EntityTooLarge" errors at the boundary.
_SINGLE_COPY_MAX_BYTES = 4 * 1024 * 1024 * 1024  # 4 GiB
_MULTIPART_COPY_PART_BYTES = 512 * 1024 * 1024   # 512 MiB per part


def _multipart_copy(source_key: str, destination_key: str, size: int):
    """Server-side copy of a large object using multipart UploadPartCopy.

    No data flows through this process — R2 copies each byte range internally.
    """
    client = _get_client()
    bucket = _bucket()
    upload_id = client.create_multipart_upload(
        Bucket=bucket, Key=destination_key
    )["UploadId"]
    try:
        parts = []
        part_number = 1
        offset = 0
        while offset < size:
            end = min(offset + _MULTIPART_COPY_PART_BYTES, size) - 1
            resp = client.upload_part_copy(
                Bucket=bucket,
                Key=destination_key,
                PartNumber=part_number,
                UploadId=upload_id,
                CopySource={"Bucket": bucket, "Key": source_key},
                CopySourceRange=f"bytes={offset}-{end}",
            )
            parts.append({
                "ETag": resp["CopyPartResult"]["ETag"],
                "PartNumber": part_number,
            })
            part_number += 1
            offset = end + 1
        client.complete_multipart_upload(
            Bucket=bucket,
            Key=destination_key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},
        )
    except Exception:
        try:
            client.abort_multipart_upload(
                Bucket=bucket, Key=destination_key, UploadId=upload_id
            )
        except ClientError:
            pass
        raise


def copy_object(source_key: str, destination_key: str):
    """Copy an object within R2. Raises FileNotFoundError if source is missing.

    Transparently uses multipart copy for sources larger than the S3
    single-shot CopyObject limit (5 GiB).
    """
    client = _get_client()
    bucket = _bucket()
    try:
        head = client.head_object(Bucket=bucket, Key=source_key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {source_key}")
        raise

    size = int(head.get("ContentLength", 0))
    if size > _SINGLE_COPY_MAX_BYTES:
        _multipart_copy(source_key, destination_key, size)
        return

    try:
        client.copy_object(
            Bucket=bucket,
            Key=destination_key,
            CopySource={"Bucket": bucket, "Key": source_key},
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
# Optional zstd-compressed sibling of the combined map. Only present when
# the ``compress_artefacts`` feature flag is ON. Readers must verify its
# ``x-amz-meta-source-etag`` user-metadata matches the raw ``COMBINED_DB_KEY``
# ETag before trusting it (see the cache-miss path in ``contribute_r2``).
COMBINED_DB_ZSTD_KEY = "globalservermap.db.zst"
TOPS_MAP_CACHE_DIM = 4096

# Suffix appended when an artefact is stored zstd-compressed. Centralised
# so the read paths can reliably distinguish "uncompressed sibling missing"
# from "filename has not been canonicalised yet".
ZSTD_SUFFIX = ".zst"


def _maybe_zstd(key: str, compressed: bool) -> str:
    return key + ZSTD_SUFFIX if compressed else key


def pending_db_key(contribution_id: str) -> str:
    return f"pending/{contribution_id}.db"


def pending_preview_key(contribution_id: str) -> str:
    return f"pending/{contribution_id}.png"


def archived_db_key(contribution_id: str, *, compressed: bool = False) -> str:
    """Long-lived archived copy of a contribution's pending .db. When the
    ``compress_artefacts`` flag is ON, callers pass ``compressed=True`` to
    obtain the zstd suffix variant. There is **no fallback** — at any time
    exactly one of the two extensions exists for a given contribution."""
    return _maybe_zstd(f"archived/{contribution_id}.db", compressed)


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


def undo_replaced_key(contribution_id: str, *, compressed: bool = False) -> str:
    """R2 key for the SQLite blob carrying ``(position, old_data)`` rows for
    every tile this contribution overwrote (region/overwrite mode only).

    When ``compressed=True``, returns the zstd-suffixed variant. Like
    :func:`archived_db_key` exactly one form exists at a time; the read
    path uses :func:`head_artefact_with_format` to discover which.
    """
    return _maybe_zstd(f"{UNDO_KEY_PREFIX}{contribution_id}.replaced.db", compressed)


# ---------------------------------------------------------------------------
# Phase 4a — weekly backups of the combined map .db
# ---------------------------------------------------------------------------

BACKUP_KEY_PREFIX = "backups/"


def backup_scheduled_key(iso_year: int, iso_week: int, *, compressed: bool = False) -> str:
    """Key for the auto-snapshot of ISO calendar week ``iso_year``/``iso_week``.

    Naming follows ISO 8601: week 01 contains the first Thursday of the year,
    weeks always start on Monday (Python ``datetime.isocalendar()``).

    When ``compressed=True`` the ``.zst`` suffix is appended. As with
    archives, only one form exists per snapshot — restore detects which
    extension is on disk via :func:`head_artefact_with_format`.
    """
    return _maybe_zstd(
        f"{BACKUP_KEY_PREFIX}backup-{iso_year:04d}-W{iso_week:02d}.db",
        compressed,
    )


def backup_manual_key(
    iso_year: int,
    iso_week: int,
    unix_timestamp: int,
    *,
    compressed: bool = False,
) -> str:
    """Key for an admin-triggered on-demand snapshot."""
    return _maybe_zstd(
        f"{BACKUP_KEY_PREFIX}backup-{iso_year:04d}-W{iso_week:02d}"
        f"-manual-{unix_timestamp}.db",
        compressed,
    )


# ---------------------------------------------------------------------------
# Landmarks / translocators (Phase: user-editable landmarks)
# ---------------------------------------------------------------------------
#
# Layout::
#
#   landmarks.geojson                                       -- live
#   translocators.geojson                                   -- live
#   backups/landmarks-YYYY-Www.geojson                      -- weekly auto
#   backups/translocators-YYYY-Www.geojson
#   backups/landmarks-YYYY-Www-manual-<unix_ts>.geojson     -- admin manual
#   backups/translocators-YYYY-Www-manual-<unix_ts>.geojson
#
# Files are tiny JSON, so no compression / no multipart needed.

LANDMARKS_LIVE_KEY = "landmarks.geojson"
TRANSLOCATORS_LIVE_KEY = "translocators.geojson"


def landmarks_live_key() -> str:
    return LANDMARKS_LIVE_KEY


def translocators_live_key() -> str:
    return TRANSLOCATORS_LIVE_KEY


def landmarks_backup_scheduled_key(iso_year: int, iso_week: int) -> str:
    return f"{BACKUP_KEY_PREFIX}landmarks-{iso_year:04d}-W{iso_week:02d}.geojson"


def landmarks_backup_manual_key(iso_year: int, iso_week: int, unix_timestamp: int) -> str:
    return (
        f"{BACKUP_KEY_PREFIX}landmarks-{iso_year:04d}-W{iso_week:02d}"
        f"-manual-{unix_timestamp}.geojson"
    )


def translocators_backup_scheduled_key(iso_year: int, iso_week: int) -> str:
    return f"{BACKUP_KEY_PREFIX}translocators-{iso_year:04d}-W{iso_week:02d}.geojson"


def translocators_backup_manual_key(iso_year: int, iso_week: int, unix_timestamp: int) -> str:
    return (
        f"{BACKUP_KEY_PREFIX}translocators-{iso_year:04d}-W{iso_week:02d}"
        f"-manual-{unix_timestamp}.geojson"
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


# ---------------------------------------------------------------------------
# Resources overlay (admin-only)
# ---------------------------------------------------------------------------
#
# Layout under ``resources/``::
#
#   resources/CURRENT                                    -- pointer txt: "<seed>-<version>"
#   resources/<seed>-<version>/manifest.json
#   resources/<seed>-<version>/deposits.sqlite
#   resources/<seed>-<version>/tiles/<layer>/level_<N>/chunk_<cx>_<cy>.png
#
# A staging prefix ``resources/<seed>-<version>.staging/`` is used during
# upload so the swap of ``CURRENT`` is the only step that flips the active
# bundle (atomic from the reader's point of view).

RESOURCES_KEY_PREFIX = "resources/"
RESOURCES_POINTER_KEY = "resources/CURRENT"


def _resources_bundle_id(seed: str, version: str) -> str:
    # ``-`` separator is fine because seeds are alphanumeric and versions
    # use dots (e.g. "12345-1.22.3"). Both fields are validated upstream.
    return f"{seed}-{version}"


def resources_prefix(seed: str, version: str, *, staging: bool = False) -> str:
    suffix = ".staging" if staging else ""
    return f"{RESOURCES_KEY_PREFIX}{_resources_bundle_id(seed, version)}{suffix}/"


def resources_manifest_key(seed: str, version: str, *, staging: bool = False) -> str:
    return resources_prefix(seed, version, staging=staging) + "manifest.json"


def resources_deposits_key(seed: str, version: str, *, staging: bool = False) -> str:
    return resources_prefix(seed, version, staging=staging) + "deposits.sqlite"


def resources_tile_key(
    seed: str,
    version: str,
    layer: str,
    level: int,
    cx: int,
    cy: int,
    *,
    staging: bool = False,
) -> str:
    return (
        resources_prefix(seed, version, staging=staging)
        + f"tiles/{layer}/level_{level}/chunk_{cx}_{cy}.png"
    )


def resources_pointer_key() -> str:
    return RESOURCES_POINTER_KEY


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
