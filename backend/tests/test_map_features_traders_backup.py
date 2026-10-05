"""Unit tests for the biweekly map-features.traders.json backup logic."""

import pytest

from app.tasks import weekly_backup as wb


def _patch_r2(
    monkeypatch,
    *,
    live_exists=True,
    target_exists=False,
    schedule="weekly",
    existing_backups=None,
):
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
    # The scheduled helper now reads the admin-configured interval + the list
    # of existing backups instead of hard-coding a biweekly even-week rule.
    monkeypatch.setattr(
        wb, "get_backup_schedule", lambda: {
            "traders": "weekly",
            "map_features_traders": schedule,
            "elk_walkable": "weekly",
        }
    )
    monkeypatch.setattr(
        wb, "list_map_features_traders_backups", lambda: list(existing_backups or [])
    )

    def _copy(src_bucket, src_key, dest_key):
        calls["copies"].append((src_bucket, src_key, dest_key))

    monkeypatch.setattr(wb.r2_storage, "copy_object_from_bucket", _copy)
    return calls


def test_scheduled_snapshot_skipped_when_disabled(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 17))
    calls = _patch_r2(monkeypatch, schedule="disabled")
    assert wb.create_scheduled_map_features_traders_snapshot_if_due() is None
    assert calls["copies"] == []


def test_scheduled_snapshot_created_when_due(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_r2(monkeypatch, schedule="weekly", existing_backups=[])
    key = wb.create_scheduled_map_features_traders_snapshot_if_due()
    assert key == "backups/map-features-traders-2026-W18.json"
    assert len(calls["copies"]) == 1
    assert calls["copies"][0][2] == key


def test_scheduled_snapshot_skipped_when_recent_backup(monkeypatch):
    """A weekly schedule shouldn't re-snapshot when a backup is only a day old."""
    from datetime import datetime, timedelta, timezone

    recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_r2(
        monkeypatch,
        schedule="weekly",
        existing_backups=[{"kind": "scheduled", "last_modified": recent}],
    )
    assert wb.create_scheduled_map_features_traders_snapshot_if_due() is None
    assert calls["copies"] == []


def test_scheduled_snapshot_idempotent_when_target_exists(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_r2(monkeypatch, target_exists=True, existing_backups=[])
    assert wb.create_scheduled_map_features_traders_snapshot_if_due() is None
    assert calls["copies"] == []


def test_scheduled_snapshot_skipped_when_live_missing(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_r2(monkeypatch, live_exists=False, existing_backups=[])
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
