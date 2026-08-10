"""Publish Auction House artifacts to the public Cloudflare R2 buckets.

Uploads the computed JSON (and the raw capture / CSV) produced by
``process_auction_data.py`` to BOTH the dev and prod R2 buckets so the
frontend Auction House explorer can fetch the market data straight from the
public bucket origin (``VITE_PUBLIC_BUCKET_ORIGIN``) instead of the committed
static bundle — no git commit / redeploy needed to refresh it.

Caching + invalidation
----------------------
* Data objects (``listings.json`` etc.) are uploaded ``immutable`` with a
  one-year ``max-age``. Their public URL never changes, so the frontend busts
  the CDN / browser cache by appending ``?v=<version>`` taken from the manifest.
* ``manifest.json`` is uploaded ``no-cache`` (always revalidated). It carries
  the current ``version`` (a content hash). A republish changes the hash, the
  frontend picks up the new manifest, and every data URL's ``?v=`` flips —
  instantly invalidating the old cached copies while keeping the data files
  cacheable forever in between refreshes.

Credentials are read from ``backend/.env.local`` (dev bucket) and
``backend/.env.prod`` (prod bucket) via ``dotenv_values`` — this does NOT mutate
the process environment, so both buckets can be targeted from one run even
though they share the same account/keys and differ only in ``R2_BUCKET_NAME``.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Callable, Iterable, List

import boto3
from botocore.config import Config as BotoConfig
from dotenv import dotenv_values

_BACKEND_DIR = Path(__file__).resolve().parent

# env label -> env file. "local" is the dev bucket, "prod" is the prod bucket.
_ENV_FILES = {
    "local": _BACKEND_DIR / ".env.local",
    "prod": _BACKEND_DIR / ".env.prod",
}

# Content-addressed (``?v=`` busted) data files never change at a given URL.
_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
# The manifest is the invalidation pointer: it must never be cached hard.
_MANIFEST_CACHE = "no-cache, max-age=0, must-revalidate"

_CONTENT_TYPES = {
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
}


def _content_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _CONTENT_TYPES:
        return _CONTENT_TYPES[ext]
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def _client_for(values: dict):
    account = (values.get("R2_ACCOUNT_ID") or "").strip()
    access = (values.get("R2_ACCESS_KEY_ID") or "").strip()
    secret = (values.get("R2_SECRET_ACCESS_KEY") or "").strip()
    if not (account and access and secret):
        raise ValueError(
            "missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY"
        )
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        config=BotoConfig(
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
        ),
        region_name="auto",
    )


def publish_auction_files(
    files: Iterable[Path],
    *,
    manifest_name: str = "manifest.json",
    prefix: str = "auction",
    envs: Iterable[str] = ("local", "prod"),
    log: Callable[[str], None] = print,
) -> None:
    """Upload ``files`` to the ``prefix/`` folder of every configured bucket.

    Best-effort: a missing env file, missing credentials, or a per-file upload
    error is logged and skipped rather than raised, so a publish can never take
    down the caller. The manifest (``manifest_name``) is uploaded last per
    bucket with a ``no-cache`` header; everything else is ``immutable``.
    """
    resolved: List[Path] = [Path(f) for f in files if Path(f).is_file()]
    if not resolved:
        log("[r2] no auction files to publish — skipping.")
        return

    # Upload the manifest last so a reader can never see a new manifest version
    # before the data files it points at exist in the bucket.
    resolved.sort(key=lambda p: p.name == manifest_name)

    for env in envs:
        env_path = _ENV_FILES.get(env)
        if not env_path or not env_path.exists():
            log(f"[r2] {env}: {env_path} not found — skipping this bucket.")
            continue

        values = dotenv_values(env_path)
        bucket = (values.get("R2_BUCKET_NAME") or "").strip()
        if not bucket:
            log(f"[r2] {env}: R2_BUCKET_NAME unset — skipping this bucket.")
            continue

        try:
            client = _client_for(values)
        except ValueError as exc:
            log(f"[r2] {env}: {exc} — skipping this bucket.")
            continue

        log(f"[r2] {env}: uploading {len(resolved)} file(s) -> {bucket}/{prefix}/")
        for f in resolved:
            key = f"{prefix}/{f.name}"
            cache = _MANIFEST_CACHE if f.name == manifest_name else _IMMUTABLE_CACHE
            try:
                with f.open("rb") as fh:
                    client.upload_fileobj(
                        fh,
                        bucket,
                        key,
                        ExtraArgs={
                            "ContentType": _content_type(f),
                            "CacheControl": cache,
                        },
                    )
                size_kb = f.stat().st_size / 1024
                log(f"[r2] {env}:   {key}  ({size_kb:,.1f} KB)")
            except Exception as exc:  # noqa: BLE001 - best-effort per file
                log(f"[r2] {env}:   FAILED {key}: {exc}")


def _client_from_env():
    """R2 client from process env vars (R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET).

    Used by the server-side rebuild on Render, where credentials come from the
    environment rather than the local ``.env.local`` / ``.env.prod`` files.
    """
    import os

    return _client_for(
        {
            "R2_ACCOUNT_ID": os.environ.get("R2_ACCOUNT_ID", ""),
            "R2_ACCESS_KEY_ID": os.environ.get("R2_ACCESS_KEY_ID", ""),
            "R2_SECRET_ACCESS_KEY": os.environ.get("R2_SECRET_ACCESS_KEY", ""),
        }
    )


def publish_files_to_bucket(
    files: Iterable[Path],
    *,
    bucket: str,
    prefix: str = "auction",
    manifest_name: str = "manifest.json",
    log: Callable[[str], None] = print,
) -> None:
    """Upload ``files`` to ``prefix/`` of a single bucket using env credentials.

    The programmatic entry point for the server-side rebuild — it targets one
    (public) bucket whose name is configured at runtime, unlike
    :func:`publish_auction_files` which reads the local dev/prod env files.
    """
    resolved: List[Path] = [Path(f) for f in files if Path(f).is_file()]
    if not resolved:
        log("[r2] no auction files to publish — skipping.")
        return
    if not bucket:
        log("[r2] no target bucket configured — skipping.")
        return
    # Upload the manifest last (see publish_auction_files).
    resolved.sort(key=lambda p: p.name == manifest_name)

    client = _client_from_env()
    log(f"[r2] env: uploading {len(resolved)} file(s) -> {bucket}/{prefix}/")
    for f in resolved:
        key = f"{prefix}/{f.name}"
        cache = _MANIFEST_CACHE if f.name == manifest_name else _IMMUTABLE_CACHE
        try:
            with f.open("rb") as fh:
                client.upload_fileobj(
                    fh,
                    bucket,
                    key,
                    ExtraArgs={
                        "ContentType": _content_type(f),
                        "CacheControl": cache,
                    },
                )
            size_kb = f.stat().st_size / 1024
            log(f"[r2] env:   {key}  ({size_kb:,.1f} KB)")
        except Exception as exc:  # noqa: BLE001 - best-effort per file
            log(f"[r2] env:   FAILED {key}: {exc}")
