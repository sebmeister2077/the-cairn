"""Cloudflare R2 storage client (S3-compatible).

Stores:
  - globalservermap.db   → the combined community map
  - pending/{id}.db      → individual pending contribution databases
    - pending/{id}.png     → rendered preview images for pending contributions
"""

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


def download_bytes(key: str) -> bytes:
    """Download an object from R2 as bytes. Raises FileNotFoundError if missing."""
    try:
        resp = _get_client().get_object(Bucket=_bucket(), Key=key)
        return resp["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise FileNotFoundError(f"R2 object not found: {key}")
        raise


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


# ---------------------------------------------------------------------------
# Key helpers — centralise path conventions
# ---------------------------------------------------------------------------

COMBINED_DB_KEY = "globalservermap.db"


def pending_db_key(contribution_id: str) -> str:
    return f"pending/{contribution_id}.db"


def pending_preview_key(contribution_id: str) -> str:
    return f"pending/{contribution_id}.png"
