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
"""

from __future__ import annotations

import gzip
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


def put_raw(source_id: str, gz_bytes: bytes) -> None:
    """Store (overwrite) a contributor's gzipped map-features document."""
    _client().put_object(
        Bucket=_bucket(),
        Key=object_key(source_id),
        Body=gz_bytes,
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


def list_raw_ids() -> List[str]:
    """Return the source ids present under the raw prefix (no prefix/suffix)."""
    client = _client()
    prefix = _prefix() + "/"
    ids: List[str] = []
    token = None
    while True:
        kwargs = {"Bucket": _bucket(), "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            name = obj["Key"][len(prefix):]
            if name.endswith(".json.gz"):
                ids.append(name[: -len(".json.gz")])
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return ids


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
