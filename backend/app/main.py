"""FastAPI application entry point."""

from contextlib import asynccontextmanager
import logging
import os
import tempfile
from time import perf_counter

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from .auth import verify_api_key_info, is_admin_key
from .config import settings
from .core.database import init_db, ensure_schema, close_db
from .core import api_key_cache
from .core import accounts_db
from . import migrations as _migrations
from .core import feature_flags as ff
from .core.display_names import generate_display_name, FORBIDDEN_SUBSTRINGS
from .routes import extract, import_wp, delete, commands, mapview
from .routes import contribute_r2 as contribute
from .routes import contribute_region
from .routes import tops_map_r2 as tops_map
from .routes import admin
from .routes import admin_users
from .routes import admin_feature_flags
from .routes import admin_backups
from .routes import public_backup_download
from .routes import admin_contributions
from .routes import admin_heavy_compute
from .routes import admin_totp
from .routes import admin_webauthn
from .routes import admin_settings
from .routes import resources as admin_resources
from .routes import account
from .routes import invite
from .routes import maintenance
from .routes import landmarks as landmarks_routes
from .routes import admin_landmarks as admin_landmarks_routes
from .routes import contribute_tls as contribute_tls_routes
from .routes import contribute_tls_screenshots as contribute_tls_screenshots_routes
from .routes import admin_translocators as admin_translocators_routes
from .routes import admin_translocators_screenshots as admin_translocators_screenshots_routes
from .routes import contribute_traders as contribute_traders_routes
from .routes import admin_traders as admin_traders_routes
from .routes import admin_usage as admin_usage_routes
from .routes import usage_ingest as usage_ingest_routes
from .routes import route_analytics as route_analytics_routes
from .routes import public_road_workers as public_road_workers_routes
from .routes import webcartographer as webcartographer_routes
from .routes import elk_walkable as elk_walkable_routes
from .routes import admin_elk_walkable as admin_elk_walkable_routes
from .routes import grouping_library as grouping_library_routes


logger = logging.getLogger("uvicorn.error")


def _configure_app_access_logger() -> None:
    """Attach a stdout handler to the ``app.access`` logger so per-request
    log lines show up in the terminal / Render logs alongside uvicorn's own
    output. Idempotent: safe to import multiple times under ``--reload``."""
    access_logger = logging.getLogger("app.access")
    access_logger.setLevel(logging.INFO)
    if not any(getattr(h, "_app_access_marker", False) for h in access_logger.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s [access] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        handler._app_access_marker = True  # type: ignore[attr-defined]
        access_logger.addHandler(handler)
    # Don't double-print via the root logger.
    access_logger.propagate = False


_configure_app_access_logger()


def _configure_temp_dir() -> None:
    """Point ``tempfile.mkstemp`` at the persistent Render disk when one is
    mounted, so multi-GB pending uploads + the combined map can coexist
    without exhausting the small ephemeral ``/tmp`` of the dyno.

    Honours the standard ``$TMPDIR`` env var. Render disks mount at the
    path you choose (e.g. ``/var/data``); set ``TMPDIR=/var/data/tmp`` in
    the service env vars and this function will create the directory and
    rewire Python's ``tempfile`` module to use it. No-op when the env var
    is unset (local dev keeps using the OS default).
    """
    tmpdir = os.environ.get("TMPDIR", "").strip()
    if not tmpdir:
        return
    try:
        os.makedirs(tmpdir, exist_ok=True)
    except OSError as exc:
        logger.warning("Could not create TMPDIR=%s (%s) — falling back to OS default", tmpdir, exc)
        return
    # Force tempfile to honour TMPDIR even if it was already imported (e.g.
    # by uvicorn) before this env var was read for the first time.
    tempfile.tempdir = tmpdir
    logger.info("Temp directory set to %s", tmpdir)


_configure_temp_dir()


def _sweep_orphan_temp_files() -> None:
    """Delete leftover ``tmp*.db`` files in the temp directory at startup.

    Background workers (validation, approval, regen) download R2 objects to
    ``tempfile.mkstemp(suffix='.db')`` and delete them in a ``finally``
    block. When the worker process is SIGKILL-ed (Render dyno restart, OOM,
    deploy mid-download) the cleanup never runs and the half-downloaded
    file lingers — on a *persistent* disk these orphans accumulate across
    deploys and can quickly fill the disk.

    At startup the process is fresh, so any ``tmp*.db`` in ``$TMPDIR`` is
    by definition an orphan from a previous run and safe to delete. Files
    with other prefixes (e.g. our cached ``combined.db``) are left alone.
    """
    tmpdir = tempfile.gettempdir()
    if not tmpdir or not os.path.isdir(tmpdir):
        return
    deleted = 0
    freed_bytes = 0
    try:
        with os.scandir(tmpdir) as it:
            for entry in it:
                if not entry.is_file(follow_symlinks=False):
                    continue
                # Only files mkstemp would have created (``tmpXXXXXX.db``).
                if not (entry.name.startswith("tmp") and entry.name.endswith(".db")):
                    continue
                try:
                    size = entry.stat(follow_symlinks=False).st_size
                    os.unlink(entry.path)
                    deleted += 1
                    freed_bytes += size
                except OSError:
                    continue
    except OSError as exc:
        logger.warning("Temp-file sweep failed: %s", exc)
        return
    if deleted:
        logger.warning(
            "Swept %d orphan temp file(s) from %s, freed %.1f MiB",
            deleted, tmpdir, freed_bytes / (1024 * 1024),
        )
    else:
        logger.info("Temp-file sweep: no orphans found in %s", tmpdir)


# Disabled: startup temp-file sweep.
# _sweep_orphan_temp_files()


@asynccontextmanager
async def lifespan(app: FastAPI):
    startup_started = perf_counter()
    logger.info("Startup begin")

    # Startup: initialise Supabase connection pool + schema
    step_started = perf_counter()
    init_db()
    logger.info("Startup step init_db completed in %.3fs", perf_counter() - step_started)

    step_started = perf_counter()
    if _migrations.is_enabled():
        _migrations.upgrade_to_head()
        logger.info(
            "Startup step alembic upgrade head completed in %.3fs",
            perf_counter() - step_started,
        )
    else:
        ensure_schema()
        logger.info(
            "Startup step ensure_schema completed in %.3fs (legacy; set USE_ALEMBIC=true to switch)",
            perf_counter() - step_started,
        )

    # Make sure env-var ADMIN_API_KEY / API_KEYS exist as rows in api_keys
    # so audit columns (FK to api_keys.id) can be populated for actions
    # taken with those keys. Idempotent.
    step_started = perf_counter()
    try:
        bootstrap_summary = api_key_cache.bootstrap_env_keys()
        logger.info(
            "Startup step api_key_cache bootstrap_env_keys: %s in %.3fs",
            bootstrap_summary, perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover — startup must not crash
        logger.warning("api_key_cache bootstrap_env_keys failed (non-fatal): %s", exc)

    # Account-system backfill: create users for legacy api_keys, mark genesis,
    # seed synthetic admin user. Idempotent — safe to run on every boot.
    step_started = perf_counter()
    # try:
        # LEGACY
        # result = accounts_db.backfill_users(
        #     name_generator=generate_display_name,
        #     forbidden_substrings=FORBIDDEN_SUBSTRINGS,
        #     admin_key=settings.ADMIN_API_KEY,
        #     legacy_keys=list(settings.API_KEYS or []),
        # )
        # logger.info(
        #     "Startup step accounts backfill: created=%d genesis_marked=%d admin_seeded=%s in %.3fs",
        #     result["created"], result["genesis_marked"], result["admin_seeded"],
        #     perf_counter() - step_started,
        # )
    # except Exception as exc:  # pragma: no cover — startup must not crash
    #     logger.warning("Account backfill failed (non-fatal): %s", exc)

    # Resume any TOPS-map regeneration work that was queued before the last
    # shutdown but never picked up by a worker (process restart mid-pass, etc.).
    step_started = perf_counter()
    try:
        from .tasks.generate_map_levels import resume_pending_work
        resume_pending_work()
        logger.info(
            "Startup step resume regen queue completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Could not resume regen queue (non-fatal): %s", exc)

    # Phase 1 — kick the match-score worker so any rows left ``pending`` from
    # a previous process get drained promptly instead of waiting for the next
    # contribution upload to wake the queue.
    step_started = perf_counter()
    try:
        from .tasks.match_score import kick_on_startup
        kick_on_startup()
        logger.info(
            "Startup step match-score kick completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Match-score startup kick failed (non-fatal): %s", exc)

    # Drain any contribution uploads left in ``validation_status='pending'``
    # by a previous process, so they don't sit forever waiting for the next
    # upload to wake the worker.
    step_started = perf_counter()
    try:
        from .tasks.validate_uploads import kick_on_startup as kick_validate_uploads
        kick_validate_uploads()
        logger.info(
            "Startup step validate-uploads kick completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Validate-uploads startup kick failed (non-fatal): %s", exc)

    # Drain any contribution approvals left ``approval_status='queued'`` /
    # ``'running'`` by a previous process. The merge is idempotent (map_lock
    # + per-position existence check), so resuming a half-run merge is safe.
    step_started = perf_counter()
    try:
        from .tasks.approve_contribution import kick_on_startup as kick_approve
        kick_approve()
        logger.info(
            "Startup step approve-contribution kick completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Approve-contribution startup kick failed (non-fatal): %s", exc)

    # Drain any contribution reverts left ``revert_status='queued'`` /
    # ``'running'`` by a previous process. The merge holds map_lock for
    # the full duration and the SQLite mutations happen on a local copy,
    # so a restart mid-revert is safe to resume.
    step_started = perf_counter()
    try:
        from .tasks.revert_contribution import kick_on_startup as kick_revert
        kick_revert()
        logger.info(
            "Startup step revert-contribution kick completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Revert-contribution startup kick failed (non-fatal): %s", exc)

    # Resources-overlay: mark any in-flight upload jobs as failed —
    # their worker thread died with the previous process so they're
    # unreachable, and we don't want the FE polling them forever.
    step_started = perf_counter()
    try:
        admin_resources.kick_on_startup()
        logger.info(
            "Startup step resources upload-jobs reset completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Resources upload-jobs startup reset failed (non-fatal): %s", exc)

    # Multi-instance coordination — start the leader-election background
    # refresh loop BEFORE any scheduled-job timers can fire so the first
    # tick sees an accurate ``is_leader()`` answer. No-op when
    # ``RUN_SCHEDULED_JOBS=never`` (local map-render instance).
    step_started = perf_counter()
    try:
        from .core import leader_election
        leader_election.start()
        logger.info(
            "Startup step leader_election started in %.3fs (info=%s)",
            perf_counter() - step_started,
            leader_election.current_info(),
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Leader election failed to start (non-fatal): %s", exc)

    # Phase 3 — start the daily history cleanup sweeper.
    step_started = perf_counter()
    try:
        from .tasks import cleanup_history
        cleanup_history.start()
        logger.info(
            "Startup step cleanup_history scheduler started in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("History cleanup scheduler failed to start (non-fatal): %s", exc)

    # Periodic poller that drains pending validation / match-score work
    # whenever heavy compute is allowed in this process. Lets a developer
    # running locally with HEAVY_COMPUTE_LOCAL_OVERRIDE=true pick up
    # contributions uploaded against the prod backend without restarting.
    step_started = perf_counter()
    try:
        from .tasks import heavy_compute_poller
        heavy_compute_poller.start()
        logger.info(
            "Startup step heavy_compute_poller scheduler started in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Heavy compute poller failed to start (non-fatal): %s", exc)

    # Phase 4a — start the weekly backup scheduler. The thread ticks even
    # when the feature flag is off (it just no-ops); flipping the flag on
    # therefore takes effect within one tick without a redeploy.
    step_started = perf_counter()
    try:
        from .tasks import weekly_backup
        weekly_backup.start()
        logger.info(
            "Startup step weekly_backup scheduler started in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("Weekly backup scheduler failed to start (non-fatal): %s", exc)

    # Resume any per-contribution archive-compression work that was
    # interrupted by a previous process. No-op when ``compress_artefacts``
    # is OFF; cheap (single LIST + per-row Postgres lookup) otherwise.
    step_started = perf_counter()
    try:
        from .tasks import compress_workers
        compress_workers.kick_on_startup()
        logger.info(
            "Startup step compress_workers kick completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("compress_workers startup kick failed (non-fatal): %s", exc)

    # Resume any TL-screenshot analysis left ``analysis_status='running'``
    # by a previous process. The worker is in-process so a crash mid-OCR
    # (e.g. Render OOM) strands the row forever otherwise.
    step_started = perf_counter()
    try:
        from .tasks import process_tl_screenshot_request as tl_screenshot_worker
        tl_screenshot_worker.kick_on_startup()
        logger.info(
            "Startup step tl_screenshot_worker kick completed in %.3fs",
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("tl_screenshot_worker startup kick failed (non-fatal): %s", exc)

    logger.info("Startup complete in %.3fs", perf_counter() - startup_started)

    try:
        yield
    finally:
        shutdown_started = perf_counter()
        try:
            from .tasks import cleanup_history
            cleanup_history.stop()
        except Exception:
            pass
        try:
            from .tasks import heavy_compute_poller
            heavy_compute_poller.stop()
        except Exception:
            pass
        try:
            from .tasks import weekly_backup
            weekly_backup.stop()
        except Exception:
            pass
        try:
            from .core import leader_election
            await leader_election.stop()
        except Exception:
            pass
        try:
            from .core import api_key_cache as _akc
            flushed = _akc.flush_all()
            if flushed:
                logger.info("Flushed pending api_key usage for %d key(s) at shutdown", flushed)
        except Exception as exc:
            logger.warning("api_key_cache.flush_all at shutdown failed (non-fatal): %s", exc)
        close_db()
        logger.info("Shutdown close_db completed in %.3fs", perf_counter() - shutdown_started)


app = FastAPI(
    title="Vintage Story Waypoint Tools",
    version="1.0.0",
    description="Web API for extracting, importing, deleting, and generating commands for Vintage Story waypoints.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_origin_regex=settings.ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Last-Modified is not a CORS-safelisted response header, so the browser
    # would otherwise hide it from `fetch()` — needed by the WebCartographer
    # geojson proxy so the frontend can read the upstream snapshot date.
    expose_headers=["Last-Modified"],
)


# ---------------------------------------------------------------------------
# Request-access logging middleware
#
# Prints one line per request so it's easy to see at a glance what's hitting
# the server. Emits at WARNING level for 4xx/5xx and slow requests so they
# stand out, INFO for everything else. Logs the ``Origin`` header to make
# CORS-rejected calls (which never reach a route handler) diagnosable —
# combine with the preflight log below.
# ---------------------------------------------------------------------------

import re as _re

_access_logger = logging.getLogger("app.access")
_SLOW_REQUEST_SECONDS = 2.0
# Skip noisy/health-style paths from the per-request log to keep output useful.
_ACCESS_LOG_SKIP = _re.compile(r"^(?:/api/health|/robots\.txt)$")


def _client_ip(request: Request) -> str:
    # Honour the standard proxy headers Render / Vercel set, falling back to
    # the direct socket peer.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",", 1)[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    client = request.client
    return client.host if client else "-"


def _origin_allowed(origin: str) -> bool:
    if not origin:
        return True  # same-origin / non-browser caller
    if origin in (settings.ALLOWED_ORIGINS or []):
        return True
    pattern = settings.ALLOWED_ORIGIN_REGEX
    if pattern:
        try:
            return _re.match(pattern, origin) is not None
        except _re.error:
            return False
    return False


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    started = perf_counter()
    method = request.method
    path = request.url.path
    origin = request.headers.get("origin", "")
    ip = _client_ip(request)
    api_key = request.headers.get("X-API-Key", "")
    key_tag = "admin" if (api_key and is_admin_key(api_key)) else ("key" if api_key else "anon")

    # CORS preflight visibility — the browser sends OPTIONS with Origin, and
    # Starlette's CORSMiddleware will reject it before our route runs. Log it
    # so we can see *who* was rejected and *why*.
    if method == "OPTIONS" and origin:
        if not _origin_allowed(origin):
            _access_logger.warning(
                "CORS preflight REJECTED origin=%s path=%s ip=%s",
                origin, path, ip,
            )
        else:
            _access_logger.info(
                "CORS preflight OK origin=%s path=%s ip=%s",
                origin, path, ip,
            )

    try:
        response = await call_next(request)
    except Exception:
        elapsed = perf_counter() - started
        _access_logger.exception(
            "%s %s -> 500 EXC ip=%s origin=%s auth=%s in %.3fs",
            method, path, ip, origin or "-", key_tag, elapsed,
        )
        raise

    elapsed = perf_counter() - started
    status = response.status_code

    # Warn on browser-side CORS rejections of actual (non-preflight) requests:
    # the response will be missing the ACAO header for a disallowed origin.
    cors_blocked = (
        origin
        and method != "OPTIONS"
        and not _origin_allowed(origin)
    )

    if _ACCESS_LOG_SKIP.match(path) and status < 400 and not cors_blocked:
        return response

    if cors_blocked:
        _access_logger.warning(
            "%s %s -> %d CORS-BLOCKED origin=%s ip=%s auth=%s in %.3fs",
            method, path, status, origin, ip, key_tag, elapsed,
        )
    elif status >= 500:
        _access_logger.error(
            "%s %s -> %d ip=%s origin=%s auth=%s in %.3fs",
            method, path, status, ip, origin or "-", key_tag, elapsed,
        )
    elif status >= 400 or elapsed >= _SLOW_REQUEST_SECONDS:
        _access_logger.warning(
            "%s %s -> %d%s ip=%s origin=%s auth=%s in %.3fs",
            method, path, status,
            " SLOW" if elapsed >= _SLOW_REQUEST_SECONDS else "",
            ip, origin or "-", key_tag, elapsed,
        )
    else:
        _access_logger.info(
            "%s %s -> %d ip=%s auth=%s in %.3fs",
            method, path, status, ip, key_tag, elapsed,
        )

    return response


# ---------------------------------------------------------------------------
# Maintenance-mode middleware (gated by the ``maintenance_mode`` feature flag)
#
# When the flag is ON, all mutating requests (POST/PUT/PATCH/DELETE) are
# rejected with HTTP 503 except for:
#   * Requests carrying the env-var admin API key (so admins can keep working
#     and toggle the flag back off).
#   * A small allow-list of paths needed for an admin to authenticate
#     (passkey assertion, key check, feature-flag toggle).
# Read-only requests (GET/HEAD/OPTIONS) are always allowed so the public site
# stays browsable in maintenance mode.
# ---------------------------------------------------------------------------

# Path *prefixes* that remain writable during maintenance even for non-admin
# callers (kept to the absolute minimum needed for sign-in / opting out).
_MAINTENANCE_ALWAYS_ALLOWED_PREFIXES = (
    "/api/admin/",                 # all admin routes (gated by admin auth)
    "/api/admin-webauthn/",        # passkey endpoints (admin auth path)
)


@app.middleware("http")
async def maintenance_mode_middleware(request: Request, call_next):
    method = request.method.upper()
    if method in ("GET", "HEAD", "OPTIONS"):
        return await call_next(request)

    path = request.url.path
    for prefix in _MAINTENANCE_ALWAYS_ALLOWED_PREFIXES:
        if path.startswith(prefix):
            return await call_next(request)

    # Admin env-var key always bypasses maintenance so the admin can disable
    # the flag without locking themselves out.
    api_key = request.headers.get("X-API-Key", "")
    if api_key and is_admin_key(api_key):
        return await call_next(request)

    if ff.is_feature_enabled("maintenance_mode"):
        return JSONResponse(
            status_code=503,
            content={
                "detail": "maintenance_mode",
                "message": (
                    "The site is in maintenance mode. Write operations are "
                    "temporarily disabled. Please try again later."
                ),
            },
            headers={"Retry-After": "300"},
        )
    return await call_next(request)

app.include_router(extract.router, prefix="/api")
app.include_router(import_wp.router, prefix="/api")
app.include_router(delete.router, prefix="/api")
app.include_router(commands.router, prefix="/api")
app.include_router(mapview.router, prefix="/api")
app.include_router(tops_map.router, prefix="/api")
app.include_router(contribute.router, prefix="/api")
app.include_router(contribute_region.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(admin_users.router, prefix="/api")
app.include_router(admin_feature_flags.router, prefix="/api")
app.include_router(admin_backups.router, prefix="/api")
app.include_router(public_backup_download.router, prefix="/api")
app.include_router(admin_contributions.router, prefix="/api")
app.include_router(admin_heavy_compute.router, prefix="/api")
app.include_router(admin_totp.router, prefix="/api")
app.include_router(admin_webauthn.router, prefix="/api")
app.include_router(admin_settings.router, prefix="/api")
app.include_router(admin_resources.router, prefix="/api")
app.include_router(account.router, prefix="/api")
app.include_router(invite.router, prefix="/api")
app.include_router(maintenance.public_router, prefix="/api")
app.include_router(landmarks_routes.router, prefix="/api")
app.include_router(admin_landmarks_routes.router, prefix="/api")
app.include_router(contribute_tls_routes.router, prefix="/api")
app.include_router(contribute_tls_screenshots_routes.router, prefix="/api")
app.include_router(admin_translocators_routes.router, prefix="/api")
app.include_router(contribute_traders_routes.router, prefix="/api")
app.include_router(admin_traders_routes.router, prefix="/api")
app.include_router(admin_translocators_screenshots_routes.router, prefix="/api")
app.include_router(admin_usage_routes.router, prefix="/api")
app.include_router(usage_ingest_routes.router, prefix="/api")
app.include_router(route_analytics_routes.router, prefix="/api")
app.include_router(public_road_workers_routes.router, prefix="/api")
app.include_router(webcartographer_routes.router, prefix="/api")
app.include_router(elk_walkable_routes.router, prefix="/api")
app.include_router(admin_elk_walkable_routes.router, prefix="/api")
app.include_router(grouping_library_routes.router, prefix="/api")
app.include_router(maintenance.admin_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/robots.txt", include_in_schema=False, response_class=PlainTextResponse)
async def robots_txt():
    return "User-agent: *\nDisallow: /\n"


@app.get("/api/me")
async def me(info: dict = Depends(verify_api_key_info)):
    """Return capabilities for the currently authenticated API key."""
    can_contribute = info.get("permissions") == "contribute"
    return {
        "is_admin": bool(info.get("is_admin")),
        "can_contribute": can_contribute,
    }
