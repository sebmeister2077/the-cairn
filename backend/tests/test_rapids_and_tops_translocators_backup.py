"""Unit tests for the map-features.rapids.json and upstream-translocators backups."""

import pytest

from app.tasks import weekly_backup as wb


# ---------------------------------------------------------------------------
# Map-features rapids (mirrors the traders flow)
# ---------------------------------------------------------------------------


def _patch_rapids_r2(
    monkeypatch,
    *,
    live_exists=True,
    target_exists=False,
    schedule="weekly",
    existing_backups=None,
):
    calls = {"copies": []}
    monkeypatch.setattr(
        wb.r2_storage,
        "map_features_rapids_live",
        lambda: ("mf-bucket", "map-features/map-features.rapids.json"),
    )
    monkeypatch.setattr(
        wb.r2_storage,
        "map_features_rapids_backup_scheduled_key",
        lambda y, w: f"backups/map-features-rapids-{y:04d}-W{w:02d}.json",
    )
    monkeypatch.setattr(wb.r2_storage, "object_exists", lambda key: target_exists)
    monkeypatch.setattr(
        wb.r2_storage, "object_exists_in_bucket", lambda bucket, key: live_exists
    )
    monkeypatch.setattr(
        wb,
        "get_backup_schedule",
        lambda: {"map_features_rapids": schedule},
    )
    monkeypatch.setattr(
        wb, "list_map_features_rapids_backups", lambda: list(existing_backups or [])
    )

    def _copy(src_bucket, src_key, dest_key):
        calls["copies"].append((src_bucket, src_key, dest_key))

    monkeypatch.setattr(wb.r2_storage, "copy_object_from_bucket", _copy)
    return calls


def test_rapids_scheduled_skipped_when_disabled(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 17))
    calls = _patch_rapids_r2(monkeypatch, schedule="disabled")
    assert wb.create_scheduled_map_features_rapids_snapshot_if_due() is None
    assert calls["copies"] == []


def test_rapids_scheduled_created_when_due(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_rapids_r2(monkeypatch, schedule="weekly", existing_backups=[])
    key = wb.create_scheduled_map_features_rapids_snapshot_if_due()
    assert key == "backups/map-features-rapids-2026-W18.json"
    assert len(calls["copies"]) == 1
    assert calls["copies"][0][2] == key


def test_rapids_scheduled_idempotent_when_target_exists(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_rapids_r2(monkeypatch, target_exists=True, existing_backups=[])
    assert wb.create_scheduled_map_features_rapids_snapshot_if_due() is None
    assert calls["copies"] == []


def test_rapids_scheduled_skipped_when_live_missing(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    calls = _patch_rapids_r2(monkeypatch, live_exists=False, existing_backups=[])
    assert wb.create_scheduled_map_features_rapids_snapshot_if_due() is None
    assert calls["copies"] == []


@pytest.mark.parametrize(
    "key,expected",
    [
        ("backups/map-features-rapids-2026-W18.json", "scheduled"),
        ("backups/map-features-rapids-2026-W18-manual-1700000000.json", "manual"),
        ("backups/map-features-traders-2026-W18.json", None),
        ("backups/map-features-rapids-2026-W18.geojson", None),
    ],
)
def test_classify_mf_rapids(key, expected):
    assert wb._classify_mf_rapids(key) == expected


# ---------------------------------------------------------------------------
# Upstream TOPS translocators (fetch + store, no restore)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "key,expected",
    [
        ("backups/tops-translocators-2026-W18.json", "scheduled"),
        ("backups/tops-translocators-2026-W18-manual-1700000000.json", "manual"),
        ("backups/translocators-2026-W18.geojson", None),
        ("backups/map-features-traders-2026-W18.json", None),
    ],
)
def test_classify_tops_tl(key, expected):
    assert wb._classify_tops_tl(key) == expected


def test_tops_tl_scheduled_skipped_when_disabled(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 17))
    monkeypatch.setattr(wb, "get_backup_schedule", lambda: {"tops_translocators": "disabled"})
    monkeypatch.setattr(wb, "list_tops_translocators_backups", lambda: [])
    uploads = []
    monkeypatch.setattr(wb, "_fetch_tops_translocators_bytes", lambda: b"{}")
    monkeypatch.setattr(
        wb.r2_storage, "upload_bytes", lambda *a, **k: uploads.append(a)
    )
    assert wb.create_scheduled_tops_translocators_snapshot_if_due() is None
    assert uploads == []


def test_tops_tl_scheduled_created_when_due(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    monkeypatch.setattr(wb, "get_backup_schedule", lambda: {"tops_translocators": "weekly"})
    monkeypatch.setattr(wb, "list_tops_translocators_backups", lambda: [])
    monkeypatch.setattr(
        wb.r2_storage,
        "tops_translocators_backup_scheduled_key",
        lambda y, w: f"backups/tops-translocators-{y:04d}-W{w:02d}.json",
    )
    monkeypatch.setattr(wb.r2_storage, "object_exists", lambda key: False)
    monkeypatch.setattr(
        wb, "_fetch_tops_translocators_bytes",
        lambda: b'{"type":"FeatureCollection","features":[]}',
    )
    uploads = []
    monkeypatch.setattr(
        wb.r2_storage, "upload_bytes",
        lambda key, data, content_type=None: uploads.append((key, data)),
    )
    key = wb.create_scheduled_tops_translocators_snapshot_if_due()
    assert key == "backups/tops-translocators-2026-W18.json"
    assert len(uploads) == 1
    assert uploads[0][0] == key


def test_tops_tl_scheduled_swallows_fetch_failure(monkeypatch):
    monkeypatch.setattr(wb, "_now_iso_week", lambda: (2026, 18))
    monkeypatch.setattr(wb, "get_backup_schedule", lambda: {"tops_translocators": "weekly"})
    monkeypatch.setattr(wb, "list_tops_translocators_backups", lambda: [])
    monkeypatch.setattr(
        wb.r2_storage,
        "tops_translocators_backup_scheduled_key",
        lambda y, w: f"backups/tops-translocators-{y:04d}-W{w:02d}.json",
    )
    monkeypatch.setattr(wb.r2_storage, "object_exists", lambda key: False)

    def _boom():
        raise RuntimeError("upstream down")

    monkeypatch.setattr(wb, "_fetch_tops_translocators_bytes", _boom)
    # Should log + swallow, returning None instead of raising.
    assert wb.create_scheduled_tops_translocators_snapshot_if_due() is None
