"""Unit tests for the biweekly map-features.traders.json backup logic."""

import pytest

from app.tasks import weekly_backup as wb


def _patch_r2(monkeypatch, *, live_exists=True, target_exists=False):
    calls = {"copies": []}
    monkeypatch.setattr(
        wb.r2_storage, "map_features_traders_live", lambda: ("mf-bucket", "map-features/map-features.traders.json")
    )
    monkeypatch.setattr(
        wb.r2_storage,
        "map_features_traders_backup_scheduled_key",
        lambda y, w: f"backups/map-features-traders-{y:04d}-W{w:02d}.json",
    )
    monkeypatch.setattr(wb.r2_storage, "object_exists", lambda key: target_exists)
    monkeypatch.setattr(
        wb.r2_storage, "object_exists_in_bucket", lambda bucket, key: live_exists
    )

    def _copy(src_bucket, src_key, dest_key):
        calls["copies"].append((src_bucket, src_key, dest_key))

    monkeypatch.setattr(wb.r2_storage, "copy_object_from_bucket", _copy)
    return calls


def test_scheduled_snapshot_skipped_on_odd_week(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 17))  # odd
    calls = _patch_r2(monkeypatch, live_exists=True, target_exists=False)
    assert wb.create_scheduled_map_features_traders_snapshot_if_due() is None
    assert calls["copies"] == []


def test_scheduled_snapshot_created_on_even_week(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))  # even
    calls = _patch_r2(monkeypatch, live_exists=True, target_exists=False)
    key = wb.create_scheduled_map_features_traders_snapshot_if_due()
    assert key == "backups/map-features-traders-2026-W18.json"
    assert len(calls["copies"]) == 1
    assert calls["copies"][0][2] == key


def test_scheduled_snapshot_idempotent_when_target_exists(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_r2(monkeypatch, live_exists=True, target_exists=True)
    assert wb.create_scheduled_map_features_traders_snapshot_if_due() is None
    assert calls["copies"] == []


def test_scheduled_snapshot_skipped_when_live_missing(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_r2(monkeypatch, live_exists=False, target_exists=False)
    assert wb.create_scheduled_map_features_traders_snapshot_if_due() is None
    assert calls["copies"] == []


@pytest.mark.parametrize(
    "key,expected",
    [
        ("backups/map-features-traders-2026-W18.json", "scheduled"),
        ("backups/map-features-traders-2026-W18-manual-1700000000.json", "manual"),
        ("backups/traders-2026-W18.geojson", None),
        ("backups/map-features-traders-2026-W18.geojson", None),
        ("backups/backup-2026-W18.db", None),
    ],
)
def test_classify_mf_traders(key, expected):
    assert wb._classify_mf_traders(key) == expected
