"""Short-lived subprocess entry point for one map-features ingest.

Invoked as ``python -m app.routes.map_features_ingest_child`` by
``contribute_map_features._run_ingest_child``. It decodes/filters/re-encodes one
contribution and writes it to R2 + the DB, then prints a machine-readable result
line. Running in a process that exits afterwards means the heavy transient heap
(a full export is tens of MB of parsed objects) — and the glibc/pymalloc arena
fragmentation it leaves behind — is reclaimed by the OS instead of ratcheting up
the RSS of the long-lived API server.

Contract with the parent (all via env vars + stdout):
* ``MAP_FEATURES_INGEST_BODY_PATH``        — temp file holding the raw (still
  possibly gzip-compressed) request body.
* ``MAP_FEATURES_INGEST_CONTENT_ENCODING`` — the request's Content-Encoding.
* ``MAP_FEATURES_INGEST_KEY_ID``           — the contributor's api-key id.
* ``MAP_FEATURES_INGEST_CLIENT_HASH``      — the normalised If-None-Match hash.

On stdout it prints exactly one ``__MFINGEST__ {json}`` line:
* ``{"ok": true, "result": {...}}``                    — success
* ``{"ok": false, "status": <int>, "detail": "..."}``  — a client-facing 4xx
Any other failure exits non-zero so the parent falls back to in-process.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

from fastapi import HTTPException

from .contribute_map_features import _INGEST_RESULT_PREFIX, _process_ingest_body


def _main_child() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    body_path = os.environ.get("MAP_FEATURES_INGEST_BODY_PATH") or ""
    content_encoding = os.environ.get("MAP_FEATURES_INGEST_CONTENT_ENCODING") or None
    key_id = os.environ.get("MAP_FEATURES_INGEST_KEY_ID") or ""
    client_hash = os.environ.get("MAP_FEATURES_INGEST_CLIENT_HASH") or ""

    try:
        raw = Path(body_path).read_bytes()
    except OSError as exc:
        sys.stderr.write(f"map-features ingest child: cannot read body: {exc}\n")
        return 1

    try:
        result = _process_ingest_body(raw, content_encoding, key_id, client_hash)
    except HTTPException as exc:
        # A legitimate client-facing 4xx — relay it so the parent re-raises it.
        print(
            _INGEST_RESULT_PREFIX
            + json.dumps({"ok": False, "status": exc.status_code, "detail": exc.detail}),
            flush=True,
        )
        return 0
    except Exception as exc:  # noqa: BLE001 — surfaced to the parent via exit code
        sys.stderr.write(f"map-features ingest child failed: {exc}\n")
        return 1

    print(
        _INGEST_RESULT_PREFIX + json.dumps({"ok": True, "result": result}),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main_child())
