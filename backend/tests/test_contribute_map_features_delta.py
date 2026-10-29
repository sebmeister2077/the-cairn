"""Route-level tests for the full/delta map-features ingest helpers.

These exercise ``_ingest_full`` / ``_ingest_delta`` directly (the synchronous
core of the POST handler) with an in-memory fake for the DB state table and the
R2 raw store, so the full/delta/replace/resync handshake is covered without a
live Postgres or R2.
"""

import pytest
from fastapi import HTTPException

from app.routes import contribute_map_features as cmf
from app.core import map_features_merge as m


class FakeBackend:
    """In-memory stand-in for the contrib-state table + raw object store."""

    def __init__(self):
        self.state = {}           # key_id -> {hash, receivedUtc, epoch, version}
        self.bases = {}           # key_id -> filtered base document bytes
        self.deltas = {}          # key_id -> {seq: delta_obj}

    # --- database.map_features_contrib_state ------------------------------
    def get_state(self, key_id):
        s = self.state.get(key_id)
        return dict(s) if s else None

    def replace_state(self, key_id, content_hash, received_utc):
        prev = self.state.get(key_id)
        epoch = (prev["epoch"] + 1) if prev else 1
        self.state[key_id] = {
            "hash": content_hash,
            "receivedUtc": received_utc,
            "epoch": epoch,
            "version": 0,
        }
        return epoch

    def bump_version(self, key_id, base_version, new_version, content_hash, received_utc, epoch):
        s = self.state.get(key_id)
        if not s or s["epoch"] != epoch or s["version"] != base_version:
            return False
        s.update(hash=content_hash, receivedUtc=received_utc, version=new_version)
        return True

    # --- raw store --------------------------------------------------------
    def put_raw(self, key_id, gz):
        self.bases[key_id] = gz

    def delete_deltas(self, key_id):
        n = len(self.deltas.pop(key_id, {}))
        return n

    def put_delta(self, key_id, seq, obj):
        self.deltas.setdefault(key_id, {})[seq] = obj


@pytest.fixture
def backend(monkeypatch):
    fb = FakeBackend()
    monkeypatch.setattr(cmf.database, "get_map_features_contrib_state", fb.get_state)
    monkeypatch.setattr(cmf.database, "replace_map_features_contrib_state", fb.replace_state)
    monkeypatch.setattr(cmf.database, "bump_map_features_contrib_version", fb.bump_version)
    monkeypatch.setattr(cmf.map_features_raw_store, "put_raw", fb.put_raw)
    monkeypatch.setattr(cmf.map_features_raw_store, "delete_deltas", fb.delete_deltas)
    monkeypatch.setattr(cmf.map_features_raw_store, "put_delta", fb.put_delta)
    monkeypatch.setattr(cmf.map_features_rebuild, "request_rebuild", lambda: None)
    return fb


def _vec(x, y, z):
    return {"x": x, "y": y, "z": z}


def _tl(x, z, state="broken"):
    return {"abs": _vec(x, 100, z), "state": state, "code": "game:statictranslocator"}


def _full_doc(translocators):
    return {
        "type": "full",
        "generatedUtc": "2026-01-01T00:00:00Z",
        "upstream": "tops.vintagestory.at",
        "worldSpawn": _vec(0, 100, 0),
        "translocators": translocators,
        "traders": [],
        "rapids": [],
        "traderClaims": [],
        "playerClaims": [],
    }


KEY = "key-1"


def test_full_upload_sets_epoch_and_version(backend):
    res = cmf._ingest_full(KEY, _full_doc([_tl(1, 2)]), "hashA", "2026-01-01T00:00:00Z")
    assert res["type"] == "full"
    assert res["epoch"] == 1 and res["version"] == 0
    assert res["protocol"] == cmf.PROTOCOL_VERSION
    assert backend.state[KEY]["hash"] == "hashA"
    assert KEY in backend.bases


def test_full_rejects_no_plausible_features(backend):
    bad = _full_doc([{"abs": _vec(10**12, 0, 0), "state": "broken"}])
    with pytest.raises(HTTPException) as exc:
        cmf._ingest_full(KEY, bad, "", "now")
    assert exc.value.status_code == 422


def test_delta_appends_after_full(backend):
    cmf._ingest_full(KEY, _full_doc([_tl(1, 2)]), "hashA", "t0")
    delta = {
        "type": "delta",
        "baseEpoch": 1,
        "baseVersion": 0,
        "resultHash": "hashB",
        "upserts": {"translocators": [_tl(3, 4)]},
        "removals": {},
    }
    res = cmf._ingest_delta(KEY, delta, "hashB", "t1")
    assert res["type"] == "delta"
    assert res["epoch"] == 1 and res["version"] == 1
    assert backend.state[KEY]["version"] == 1
    assert 1 in backend.deltas[KEY]


def test_delta_without_prior_state_is_resync(backend):
    delta = {"type": "delta", "baseEpoch": 0, "baseVersion": 0, "upserts": {"translocators": [_tl(1, 2)]}, "removals": {}}
    with pytest.raises(HTTPException) as exc:
        cmf._ingest_delta(KEY, delta, "", "t0")
    assert exc.value.status_code == 409


def test_delta_version_mismatch_is_resync(backend):
    cmf._ingest_full(KEY, _full_doc([_tl(1, 2)]), "hashA", "t0")
    stale = {"type": "delta", "baseEpoch": 1, "baseVersion": 5, "upserts": {"translocators": [_tl(3, 4)]}, "removals": {}}
    with pytest.raises(HTTPException) as exc:
        cmf._ingest_delta(KEY, stale, "", "t1")
    assert exc.value.status_code == 409


def test_delta_epoch_mismatch_is_resync(backend):
    cmf._ingest_full(KEY, _full_doc([_tl(1, 2)]), "hashA", "t0")
    stale = {"type": "delta", "baseEpoch": 0, "baseVersion": 0, "upserts": {"translocators": [_tl(3, 4)]}, "removals": {}}
    with pytest.raises(HTTPException) as exc:
        cmf._ingest_delta(KEY, stale, "", "t1")
    assert exc.value.status_code == 409


def test_empty_delta_is_rejected(backend):
    cmf._ingest_full(KEY, _full_doc([_tl(1, 2)]), "hashA", "t0")
    empty = {"type": "delta", "baseEpoch": 1, "baseVersion": 0, "upserts": {}, "removals": {}}
    with pytest.raises(HTTPException) as exc:
        cmf._ingest_delta(KEY, empty, "", "t1")
    assert exc.value.status_code == 422


def test_full_after_deltas_replaces_and_bumps_epoch(backend):
    cmf._ingest_full(KEY, _full_doc([_tl(1, 2)]), "hashA", "t0")
    d = {"type": "delta", "baseEpoch": 1, "baseVersion": 0, "upserts": {"translocators": [_tl(3, 4)]}, "removals": {}}
    cmf._ingest_delta(KEY, d, "hashB", "t1")
    assert backend.deltas.get(KEY)  # a delta exists

    res = cmf._ingest_full(KEY, _full_doc([_tl(9, 9)]), "hashC", "t2")
    assert res["epoch"] == 2 and res["version"] == 0
    assert backend.deltas.get(KEY) in (None, {})  # delta stream cleared on replace


def test_stored_base_and_deltas_reconstruct_correctly(backend):
    """End-to-end: full + deltas as persisted reproduce the expected snapshot via
    the same reconstruction the rebuild uses."""
    cmf._ingest_full(KEY, _full_doc([_tl(1, 2), _tl(5, 6)]), "h0", "t0")
    # Remove (5,6), add (7,8).
    d1 = {
        "type": "delta",
        "baseEpoch": 1,
        "baseVersion": 0,
        "upserts": {"translocators": [_tl(7, 8)]},
        "removals": {"translocators": [{"abs": _vec(5, 100, 6)}]},
    }
    cmf._ingest_delta(KEY, d1, "h1", "t1")

    # The route stored the filtered base as gzipped bytes; decode it the same way
    # the raw store would, then reconstruct with the ordered deltas.
    import gzip
    import json
    base = json.loads(gzip.decompress(backend.bases[KEY]).decode("utf-8"))
    deltas = [backend.deltas[KEY][s] for s in sorted(backend.deltas[KEY])]
    out = m.reconstruct_document(base, deltas)
    coords = {(round(f["abs"]["x"]), round(f["abs"]["z"])) for f in out["translocators"]}
    assert coords == {(1, 2), (7, 8)}


# --- _process_ingest_body: the decode/dispatch the subprocess child wraps ----
def _gz(obj):
    import gzip
    import json
    return gzip.compress(json.dumps(obj).encode("utf-8"), mtime=0)


def test_process_ingest_body_full_gzip(backend):
    """A gzip-encoded full body is decompressed, parsed and ingested as a full."""
    raw = _gz(_full_doc([_tl(1, 2)]))
    res = cmf._process_ingest_body(raw, "gzip", KEY, "hashA")
    assert res["type"] == "full"
    assert res["epoch"] == 1 and res["version"] == 0
    assert backend.state[KEY]["hash"] == "hashA"


def test_process_ingest_body_delta_uncompressed(backend):
    """An uncompressed delta body dispatches to the delta path on top of a base."""
    cmf._process_ingest_body(_gz(_full_doc([_tl(1, 2)])), "gzip", KEY, "h0")
    delta = {
        "type": "delta",
        "baseEpoch": 1,
        "baseVersion": 0,
        "upserts": {"translocators": [_tl(3, 4)]},
    }
    import json
    res = cmf._process_ingest_body(json.dumps(delta).encode("utf-8"), None, KEY, "h1")
    assert res["type"] == "delta" and res["version"] == 1


def test_process_ingest_body_invalid_json_is_400(backend):
    with pytest.raises(HTTPException) as ei:
        cmf._process_ingest_body(b"not json", None, KEY, "")
    assert ei.value.status_code == 400


def test_process_ingest_body_non_object_is_422(backend):
    import json
    with pytest.raises(HTTPException) as ei:
        cmf._process_ingest_body(json.dumps([1, 2, 3]).encode("utf-8"), None, KEY, "")
    assert ei.value.status_code == 422


# --- _run_ingest_child: relaying the child's result/error back to the caller --
class _FakeProc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


def test_run_ingest_child_relays_success(monkeypatch):
    ok_line = cmf._INGEST_RESULT_PREFIX + '{"ok": true, "result": {"type": "full", "epoch": 2}}'
    monkeypatch.setattr(cmf.subprocess, "run", lambda *a, **k: _FakeProc(stdout=ok_line))
    res = cmf._run_ingest_child(b"body", "gzip", KEY, "h")
    assert res == {"type": "full", "epoch": 2}


def test_run_ingest_child_relays_http_error(monkeypatch):
    err_line = cmf._INGEST_RESULT_PREFIX + '{"ok": false, "status": 409, "detail": "resync"}'
    monkeypatch.setattr(cmf.subprocess, "run", lambda *a, **k: _FakeProc(stdout=err_line))
    with pytest.raises(HTTPException) as ei:
        cmf._run_ingest_child(b"body", None, KEY, "h")
    assert ei.value.status_code == 409 and ei.value.detail == "resync"


def test_run_ingest_child_infra_failure_raises_subprocess_error(monkeypatch):
    """No result line + non-zero exit => _IngestSubprocessError (parent falls back)."""
    monkeypatch.setattr(
        cmf.subprocess, "run", lambda *a, **k: _FakeProc(stderr="boom", returncode=1)
    )
    with pytest.raises(cmf._IngestSubprocessError):
        cmf._run_ingest_child(b"body", None, KEY, "h")
