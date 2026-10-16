"""Unit tests for delta reconstruction (base + append-only deltas).

A contributor may push an append-only stream of DELTA objects (upserts +
removals) on top of its base snapshot. ``reconstruct_document`` must rebuild the
contributor's current ``MapExportDocument`` by applying each delta in order,
with per-category keying identical to the union-merge and per-player semantics
for land claims.
"""

from app.core import map_features_merge as m


def _vec(x, y, z):
    return {"x": x, "y": y, "z": z}


def _tl(x, z, state="broken"):
    return {"abs": _vec(x, 100, z), "state": state, "code": f"game:statictranslocator-{state}"}


def _trader(eid, type_="artisan"):
    return {"entityId": eid, "type": type_, "abs": _vec(eid, 100, eid), "code": "game:trader"}


def _claim(uid, min_x, max_x):
    return {
        "playerUid": uid,
        "owner": f"Player {uid}",
        "areaCount": 1,
        "center": _vec((min_x + max_x) // 2, 100, 0),
        "min": _vec(min_x, 95, 0),
        "max": _vec(max_x, 105, 0),
    }


def _base(translocators=None, traders=None, player_claims=None):
    return {
        "generatedUtc": "2026-01-01T00:00:00Z",
        "upstream": "tops.vintagestory.at",
        "worldSpawn": _vec(0, 100, 0),
        "translocators": translocators or [],
        "traders": traders or [],
        "rapids": [],
        "traderClaims": [],
        "playerClaims": player_claims or [],
    }


def _by_abs(feats):
    return {(round(f["abs"]["x"]), round(f["abs"]["z"])) for f in feats}


def test_reconstruct_base_only_returns_base():
    doc = _base(translocators=[_tl(10, 20)])
    out = m.reconstruct_document(doc, [])
    assert _by_abs(out["translocators"]) == {(10, 20)}


def test_delta_upsert_adds_and_replaces_by_key():
    base = _base(translocators=[_tl(10, 20, "broken")])
    delta = {
        "type": "delta",
        "upserts": {"translocators": [_tl(10, 20, "unrepairable"), _tl(30, 40)]},
        "removals": {},
    }
    out = m.reconstruct_document(base, [delta])
    assert _by_abs(out["translocators"]) == {(10, 20), (30, 40)}
    # The upsert at (10,20) replaced the base feature (state changed).
    repl = next(f for f in out["translocators"] if round(f["abs"]["x"]) == 10)
    assert repl["state"] == "unrepairable"


def test_delta_removal_deletes_by_key():
    base = _base(translocators=[_tl(10, 20), _tl(30, 40)])
    delta = {
        "type": "delta",
        "upserts": {},
        # Removal carries identity only (the abs point).
        "removals": {"translocators": [{"abs": _vec(30, 100, 40)}]},
    }
    out = m.reconstruct_document(base, [delta])
    assert _by_abs(out["translocators"]) == {(10, 20)}


def test_delta_removal_of_missing_key_is_noop():
    base = _base(translocators=[_tl(10, 20)])
    delta = {"type": "delta", "upserts": {}, "removals": {"translocators": [{"abs": _vec(99, 100, 99)}]}}
    out = m.reconstruct_document(base, [delta])
    assert _by_abs(out["translocators"]) == {(10, 20)}


def test_deltas_apply_in_order():
    base = _base(traders=[_trader(1)])
    d1 = {"type": "delta", "upserts": {"traders": [_trader(2)]}, "removals": {}}
    d2 = {"type": "delta", "upserts": {}, "removals": {"traders": [{"entityId": 1}]}}
    d3 = {"type": "delta", "upserts": {"traders": [_trader(3)]}, "removals": {}}
    out = m.reconstruct_document(base, [d1, d2, d3])
    assert {t["entityId"] for t in out["traders"]} == {2, 3}


def test_player_claim_upsert_replaces_whole_player_set():
    base = _base(player_claims=[_claim("P", 0, 10), _claim("P", 50, 60)])
    # One box for P in the delta REPLACES both of P's base boxes.
    delta = {"type": "delta", "upserts": {"playerClaims": [_claim("P", 100, 110)]}, "removals": {}}
    out = m.reconstruct_document(base, [delta])
    p_boxes = [c for c in out["playerClaims"] if c["playerUid"] == "P"]
    assert len(p_boxes) == 1
    assert p_boxes[0]["min"]["x"] == 100


def test_player_claim_removal_by_uid():
    base = _base(player_claims=[_claim("P", 0, 10), _claim("Q", 0, 10)])
    delta = {"type": "delta", "upserts": {}, "removals": {"playerClaims": ["Q"]}}
    out = m.reconstruct_document(base, [delta])
    assert {c["playerUid"] for c in out["playerClaims"]} == {"P"}


def test_player_claim_removal_accepts_identity_object():
    base = _base(player_claims=[_claim("P", 0, 10), _claim("Q", 0, 10)])
    delta = {"type": "delta", "upserts": {}, "removals": {"playerClaims": [{"playerUid": "P"}]}}
    out = m.reconstruct_document(base, [delta])
    assert {c["playerUid"] for c in out["playerClaims"]} == {"Q"}


def test_delta_overwrites_envelope_metadata():
    base = _base(translocators=[_tl(1, 1)])
    delta = {
        "type": "delta",
        "upstream": "other.host",
        "worldSpawn": _vec(5, 100, 5),
        "upserts": {},
        "removals": {},
    }
    out = m.reconstruct_document(base, [delta])
    assert out["upstream"] == "other.host"
    assert out["worldSpawn"] == _vec(5, 100, 5)
