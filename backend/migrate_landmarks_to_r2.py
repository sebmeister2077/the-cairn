"""One-shot migration: upload bundled landmarks.geojson + translocators.geojson
to R2 with stable per-feature UUIDs and seed provenance.

Run from the repo root::

    python -m backend.migrate_landmarks_to_r2 \
        --landmarks frontend/src/assets/landmarks.geojson \
        --translocators frontend/src/assets/translocators.geojson

Idempotent: if a feature already has an ``id`` it is preserved. By default the
script refuses to overwrite an existing live R2 object — pass ``--force`` to
replace it (use after verifying the migration result).
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Allow ``python backend/migrate_landmarks_to_r2.py`` from the repo root by
# making the ``app`` package importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.core import r2_storage  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stamp_features(geojson: dict, *, now: str) -> dict:
    """Mutate features in-place to add stable id + seed provenance fields."""
    features = geojson.get("features")
    if not isinstance(features, list):
        raise ValueError("Input is not a FeatureCollection (no .features array)")
    for feat in features:
        if not isinstance(feat, dict):
            continue
        props = feat.setdefault("properties", {})
        if not isinstance(props, dict):
            raise ValueError(f"Feature properties is not an object: {feat!r}")
        if not props.get("id"):
            props["id"] = str(uuid.uuid4())
        # Don't clobber existing provenance if a feature was previously stamped.
        props.setdefault("origin", "seed")
        props.setdefault("added_by", None)
        props.setdefault("added_by_user_id", None)
        props.setdefault("added_at", now)
    return geojson


def _upload(geojson: dict, key: str, *, force: bool) -> None:
    if not force and r2_storage.object_exists(key):
        raise FileExistsError(
            f"R2 object {key!r} already exists. Pass --force to overwrite."
        )
    body = json.dumps(geojson, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    r2_storage.upload_bytes(key, body, content_type="application/geo+json")
    r2_storage.invalidate_presigned_download_url(key)
    print(f"Uploaded {len(body):,} bytes -> {key}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--landmarks", type=Path, required=True)
    p.add_argument("--translocators", type=Path, required=True)
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing live R2 object (otherwise refuse).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Stamp features and print summary, but do not upload.",
    )
    args = p.parse_args(argv)

    now = _now_iso()
    for label, path, key in (
        ("landmarks", args.landmarks, r2_storage.landmarks_live_key()),
        ("translocators", args.translocators, r2_storage.translocators_live_key()),
    ):
        if not path.is_file():
            print(f"ERROR: {label} file not found: {path}", file=sys.stderr)
            return 2
        data = json.loads(path.read_text(encoding="utf-8"))
        _stamp_features(data, now=now)
        feat_count = len(data.get("features") or [])
        print(f"{label}: {feat_count} features stamped (origin=seed where missing)")
        if args.dry_run:
            continue
        _upload(data, key, force=args.force)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
