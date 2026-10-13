"""Unit tests for the N-way map-features merge, focused on player claims.

Player land claims change over time (areas are resized, moved, split, or
released). The merge must publish the LATEST observation of each player's set of
claim boxes rather than accumulating every box ever seen (append-only).
"""

from app.core import map_features_merge as m


def _vec(x, y, z):
    return {"x": x, "y": y, "z": z}


def _claim(uid, owner, cx, cz, min_x, min_z, max_x, max_z):
    return {
        "playerUid": uid,
        "owner": owner,
        "description": "",
        "areaCount": 1,
        "center": _vec(cx, 100, cz),
        "min": _vec(min_x, 95, min_z),
        "max": _vec(max_x, 105, max_z),
    }


def _doc(generated, player_claims):
    return {
        "generatedUtc": generated,
        "upstream": "tops.vintagestory.at",
        "worldSpawn": _vec(0, 100, 0),
        "translocators": [],
        "traders": [],
        "rapids": [],
        "traderClaims": [],
        "playerClaims": player_claims,
    }


def _player_boxes(merged, uid):
    return [c for c in merged["playerClaims"] if c["playerUid"] == uid]


def test_resized_claim_replaces_old_box_not_appended():
    """A player who resizes a claim must not leave the old box behind."""
    old = _doc("2026-01-01T00:00:00Z", [_claim("UID1", "P", 0, 0, -5, -5, 5, 5)])
    # Same player, newer source, a differently sized box (resized claim).
    new = _doc("2026-02-01T00:00:00Z", [_claim("UID1", "P", 0, 0, -10, -10, 10, 10)])

    merged = m.merge_documents([("srcA", old), ("srcB", new)])
    boxes = _player_boxes(merged, "UID1")

    assert len(boxes) == 1, "old box should be evicted, not accumulated"
    assert boxes[0]["min"]["x"] == -10 and boxes[0]["max"]["x"] == 10


def test_released_area_disappears():
    """A player who drops from two areas to one keeps only the latest set."""
    old = _doc(
        "2026-01-01T00:00:00Z",
        [
            _claim("UID1", "P", 0, 0, -5, -5, 5, 5),
            _claim("UID1", "P", 100, 100, 95, 95, 105, 105),
        ],
    )
    new = _doc("2026-02-01T00:00:00Z", [_claim("UID1", "P", 0, 0, -5, -5, 5, 5)])

    merged = m.merge_documents([("srcA", old), ("srcB", new)])
    assert len(_player_boxes(merged, "UID1")) == 1


def test_latest_wins_regardless_of_source_order():
    """Newest generatedUtc wins even if passed in the opposite order."""
    old = _doc("2026-01-01T00:00:00Z", [_claim("UID1", "P", 0, 0, -5, -5, 5, 5)])
    new = _doc("2026-02-01T00:00:00Z", [_claim("UID1", "P", 0, 0, -10, -10, 10, 10)])

    merged = m.merge_documents([("srcB", new), ("srcA", old)])
    boxes = _player_boxes(merged, "UID1")
    assert len(boxes) == 1
    assert boxes[0]["max"]["x"] == 10


def test_distinct_players_are_unioned_across_sources():
    """Different players observed by different sources all survive."""
    a = _doc("2026-01-01T00:00:00Z", [_claim("UID1", "A", 0, 0, -5, -5, 5, 5)])
    b = _doc("2026-01-02T00:00:00Z", [_claim("UID2", "B", 50, 50, 45, 45, 55, 55)])

    merged = m.merge_documents([("srcA", a), ("srcB", b)])
    assert len(_player_boxes(merged, "UID1")) == 1
    assert len(_player_boxes(merged, "UID2")) == 1


def test_multiple_areas_for_same_player_are_all_kept():
    """A player with several distinct areas keeps all of them from the newest source."""
    doc = _doc(
        "2026-02-01T00:00:00Z",
        [
            _claim("UID1", "P", 0, 0, -5, -5, 5, 5),
            _claim("UID1", "P", 100, 100, 95, 95, 105, 105),
            _claim("UID1", "P", -100, -100, -105, -105, -95, -95),
        ],
    )
    merged = m.merge_documents([("srcA", doc)])
    assert len(_player_boxes(merged, "UID1")) == 3


def test_duplicate_box_within_one_source_is_deduped():
    box = _claim("UID1", "P", 0, 0, -5, -5, 5, 5)
    doc = _doc("2026-02-01T00:00:00Z", [box, dict(box)])
    merged = m.merge_documents([("srcA", doc)])
    assert len(_player_boxes(merged, "UID1")) == 1


def test_first_seen_utc_is_stripped():
    box = _claim("UID1", "P", 0, 0, -5, -5, 5, 5)
    box["firstSeenUtc"] = "2025-01-01T00:00:00Z"
    doc = _doc("2026-02-01T00:00:00Z", [box])
    merged = m.merge_documents([("srcA", doc)])
    assert "firstSeenUtc" not in merged["playerClaims"][0]
