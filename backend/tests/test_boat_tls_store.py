"""Unit tests for the boat-friendly translocators store + tile proxy guards."""

import json

import pytest
from fastapi import HTTPException

from app.core import boat_tls_store
from app.routes import webcartographer as wc


# ---------------------------------------------------------------------------
# Canonical id normalisation
# ---------------------------------------------------------------------------


def test_canonical_tl_id_orientation_agnostic():
    # Both endpoint orders normalise to the same canonical string.
    a = boat_tls_store.canonical_tl_id("10,20,5,8")
    b = boat_tls_store.canonical_tl_id("5,8,10,20")
    assert a == b == "5,8,10,20"


def test_canonical_tl_id_tie_breaks_on_z():
    # Equal x: the smaller z comes first.
    assert boat_tls_store.canonical_tl_id("5,30,5,10") == "5,10,5,30"


def test_canonical_tl_id_rejects_malformed():
    with pytest.raises(ValueError):
        boat_tls_store.canonical_tl_id("1,2,3")
    with pytest.raises(ValueError):
        boat_tls_store.canonical_tl_id("a,b,c,d")


# ---------------------------------------------------------------------------
# Store read / toggle (R2 stubbed with an in-memory object)
# ---------------------------------------------------------------------------


def _patch_store(monkeypatch, initial=None):
    state = {"obj": None}
    if initial is not None:
        state["obj"] = json.dumps({"version": 1, "tl_ids": initial}).encode("utf-8")

    def _download(key):
        if state["obj"] is None:
            raise FileNotFoundError(key)
        return state["obj"]

    def _upload(key, data, content_type="application/json"):
        state["obj"] = data

    monkeypatch.setattr(boat_tls_store.r2_storage, "download_bytes", _download)
    monkeypatch.setattr(boat_tls_store.r2_storage, "upload_bytes", _upload)
    return state


def test_list_empty_when_missing(monkeypatch):
    _patch_store(monkeypatch, initial=None)
    assert boat_tls_store.list_boat_friendly_tls() == []


def test_toggle_add_then_remove(monkeypatch):
    _patch_store(monkeypatch, initial=None)

    # Add (passing the reversed orientation still canonicalises).
    result = boat_tls_store.toggle_boat_friendly_tl("10,20,5,8", True)
    assert result == ["5,8,10,20"]
    assert boat_tls_store.list_boat_friendly_tls() == ["5,8,10,20"]

    # Adding the same TL again (other orientation) is idempotent.
    result = boat_tls_store.toggle_boat_friendly_tl("5,8,10,20", True)
    assert result == ["5,8,10,20"]

    # Remove.
    result = boat_tls_store.toggle_boat_friendly_tl("5,8,10,20", False)
    assert result == []


def test_list_dedupes_and_sorts(monkeypatch):
    _patch_store(monkeypatch, initial=["10,20,5,8", "5,8,10,20", "0,0,1,1"])
    assert boat_tls_store.list_boat_friendly_tls() == ["0,0,1,1", "5,8,10,20"]


# ---------------------------------------------------------------------------
# Tile proxy input validation
# ---------------------------------------------------------------------------


def test_tile_proxy_rejects_bad_extension():
    with pytest.raises(HTTPException) as exc:
        wc.fetch_webcartographer_tile(
            base_url="https://example.com", z=9, x=1, y=1, ext="gif"
        )
    assert exc.value.status_code == 400


def test_tile_proxy_rejects_bad_base_url():
    with pytest.raises(HTTPException) as exc:
        wc.fetch_webcartographer_tile(base_url="ftp://nope", z=9, x=1, y=1, ext="png")
    assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# Batch tile proxy
# ---------------------------------------------------------------------------


def _batch_request(**overrides):
    params = {
        "base_url": "https://example.com",
        "z": 9,
        "ext": "png",
        "coords": [(1, 1), (2, 2)],
    }
    params.update(overrides)
    return wc._TileBatchRequest(**params)


def test_tile_batch_rejects_bad_extension():
    with pytest.raises(HTTPException) as exc:
        wc.fetch_webcartographer_tiles(_batch_request(ext="gif"))
    assert exc.value.status_code == 400


def test_tile_batch_rejects_out_of_range_coord():
    with pytest.raises(HTTPException) as exc:
        wc.fetch_webcartographer_tiles(_batch_request(coords=[(1, 1), (99999, 0)]))
    assert exc.value.status_code == 400


def test_tile_batch_encodes_found_missing_and_error(monkeypatch):
    # Map each tile coord to a canned upstream behaviour.
    def _fake_fetch(base, z, x, y, ext):
        if (x, y) == (1, 1):
            return b"\x89PNG-bytes", None, "image/png"
        if (x, y) == (2, 2):
            raise HTTPException(status_code=404, detail="tile not found")
        raise HTTPException(status_code=502, detail="upstream unreachable")

    monkeypatch.setattr(wc, "_fetch_tile_raw", _fake_fetch)

    resp = wc.fetch_webcartographer_tiles(
        _batch_request(coords=[(1, 1), (2, 2), (3, 3)])
    )
    payload = json.loads(bytes(resp.body))
    by_coord = {(t["x"], t["y"]): t for t in payload["tiles"]}

    # Found tile → base64 of the raw bytes.
    import base64 as _b64

    assert by_coord[(1, 1)]["found"] is True
    assert _b64.b64decode(by_coord[(1, 1)]["data"]) == b"\x89PNG-bytes"
    # 404 → not found, no error flag (genuinely empty pyramid cell).
    assert by_coord[(2, 2)]["found"] is False
    assert "error" not in by_coord[(2, 2)]
    # Other failure → error flag so the client can retry individually.
    assert by_coord[(3, 3)]["found"] is False
    assert by_coord[(3, 3)]["error"] is True


def test_tile_batch_dedupes_coords(monkeypatch):
    calls = []

    def _fake_fetch(base, z, x, y, ext):
        calls.append((x, y))
        return b"x", None, "image/png"

    monkeypatch.setattr(wc, "_fetch_tile_raw", _fake_fetch)

    resp = wc.fetch_webcartographer_tiles(
        _batch_request(coords=[(1, 1), (1, 1), (2, 2)])
    )
    payload = json.loads(bytes(resp.body))
    # Duplicate (1,1) fetched once; two distinct tiles returned.
    assert sorted(calls) == [(1, 1), (2, 2)]
    assert len(payload["tiles"]) == 2
