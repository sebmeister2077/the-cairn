"""Private R2 store for per-contributor raw auction-events files.

Each auction contributor's full cumulative ``auction-events.jsonl`` is stored as
one gzipped object at ``<AUCTION_RAW_PREFIX>/<source_id>.jsonl.gz`` in a PRIVATE
bucket. The raw data carries player UIDs + item RawHex, so it must never be
publicly readable — only the computed artifacts go to the public bucket. The
server is the sole holder of R2 credentials; contributors never touch them.

A contribution simply overwrites its own object (atomic per-object PUT), so N
contributors keep exactly N objects (+ the ``seed`` object). The rebuild reads
every non-revoked object, merges them, and republishes the public artifacts.
"""

from __future__ import annotations

import gzip
import logging
from typing import Iterator, List, Optional

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from ..config import settings

logger = logging.getLogger("uvicorn.error")

# The seed object holds the historical merged capture; always included, no key.
SEED_ID = "seed"


def _client():
    if not (
        settings.R2_ACCOUNT_ID
        and settings.R2_ACCESS_KEY_ID
        and settings.R2_SECRET_ACCESS_KEY
    ):
        raise RuntimeError("R2 credentials not configured (R2_ACCOUNT_ID/KEY/SECRET)")
    return boto3.client(
        "s3",
        endpoint_url=settings.R2_ENDPOINT_URL,
        aws_access_key_id=settings.R2_ACCESS_KEY_ID,
        aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
        config=BotoConfig(
            signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}
        ),
        region_name="auto",
    )


def _bucket() -> str:
    b = (settings.R2_PRIVATE_BUCKET_NAME or "").strip()
    if not b:
        raise RuntimeError("R2_PRIVATE_BUCKET_NAME not configured")
    return b


def _prefix() -> str:
    return (settings.AUCTION_RAW_PREFIX or "auction/raw").strip("/")


def object_key(source_id: str) -> str:
    return f"{_prefix()}/{source_id}.jsonl.gz"


def put_raw(source_id: str, gz_bytes: bytes) -> None:
    """Store (overwrite) a contributor's gzipped auction-events file."""
    _client().put_object(
        Bucket=_bucket(),
        Key=object_key(source_id),
        Body=gz_bytes,
        ContentType="application/x-ndjson",
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
            if name.endswith(".jsonl.gz"):
                ids.append(name[: -len(".jsonl.gz")])
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return ids


def iter_raw_lines(source_id: str) -> Iterator[str]:
    """Yield the decompressed JSONL lines of a source's stored file."""
    gz = get_raw(source_id)
    if not gz:
        return
    text = gzip.decompress(gz).decode("utf-8")
    for line in text.splitlines():
        line = line.strip()
        if line:
            yield line
