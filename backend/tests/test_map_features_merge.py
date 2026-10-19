"""Unit tests for the N-way map-features merge, focused on player claims.

Player land claims change over time (areas are resized, moved, split, or
released) and every source is an independent full observation of the same
server. The merge must publish the player claims from the LATEST contribution
alone, never a union across sources, so stale boxes from older sources cannot
leak into the published set.
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


def test_distinct_players_from_older_sources_are_dropped():
    """Player claims come wholesale from the newest source only: players seen
    just by older sources are NOT unioned in (they may be stale)."""
    a = _doc("2026-01-01T00:00:00Z", [_claim("UID1", "A", 0, 0, -5, -5, 5, 5)])
    b = _doc("2026-01-02T00:00:00Z", [_claim("UID2", "B", 50, 50, 45, 45, 55, 55)])

    merged = m.merge_documents([("srcA", a), ("srcB", b)])
    assert len(_player_boxes(merged, "UID1")) == 0
    assert len(_player_boxes(merged, "UID2")) == 1


def test_last_contribution_is_source_of_truth_not_merged():
    """Regression: a player who released claims (19 boxes seen by an older
    source, 8 by the newest) must publish only the newest count, never the union.
    """
    def _boxes(uid, n):
        return [_claim(uid, "P", i, i, i - 1, i - 1, i + 1, i + 1) for i in range(n)]

    stale = _doc("2026-01-01T00:00:00Z", _boxes("UIDX", 19))
    latest = _doc("2026-02-01T00:00:00Z", _boxes("UIDX", 8))

    merged = m.merge_documents([("srcStale", stale), ("srcLatest", latest)])
    assert len(_player_boxes(merged, "UIDX")) == 8


def test_empty_latest_source_does_not_wipe_last_good_claims():
    """A newest source reporting no player claims is a non-observation: it leaves
    the previous good set in place rather than clearing the map."""
    good = _doc("2026-01-01T00:00:00Z", [_claim("UID1", "P", 0, 0, -5, -5, 5, 5)])
    empty = _doc("2026-02-01T00:00:00Z", [])

    merged = m.merge_documents([("srcGood", good), ("srcEmpty", empty)])
    assert len(_player_boxes(merged, "UID1")) == 1


def test_player_missing_from_newest_nonempty_source_is_released():
    """If the newest source reports claims for other players but not this one,
    this player's claims are released (dropped), matching the latest server view.
    """
    old = _doc(
        "2026-01-01T00:00:00Z",
        [
            _claim("UID1", "A", 0, 0, -5, -5, 5, 5),
            _claim("UID2", "B", 50, 50, 45, 45, 55, 55),
        ],
    )
    new = _doc("2026-02-01T00:00:00Z", [_claim("UID2", "B", 50, 50, 45, 45, 55, 55)])

    merged = m.merge_documents([("srcA", old), ("srcB", new)])
    assert len(_player_boxes(merged, "UID1")) == 0
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
