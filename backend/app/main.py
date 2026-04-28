"""FastAPI application entry point."""

from contextlib import asynccontextmanager
import logging
from time import perf_counter

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import verify_api_key_info, is_admin_key
from .config import settings
from .core.database import init_db, ensure_schema, close_db
from .core import accounts_db
from .core import feature_flags as ff
from .core.display_names import generate_display_name, FORBIDDEN_SUBSTRINGS
from .routes import extract, import_wp, delete, commands, mapview
from .routes import contribute_r2 as contribute
from .routes import tops_map_r2 as tops_map
from .routes import admin
from .routes import admin_users
from .routes import admin_feature_flags
from .routes import admin_backups
from .routes import admin_contributions
from .routes import admin_totp
from .routes import admin_webauthn
from .routes import account
from .routes import invite


logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    startup_started = perf_counter()
    logger.info("Startup begin")

    # Startup: initialise Supabase connection pool + schema
    step_started = perf_counter()
    init_db()
    logger.info("Startup step init_db completed in %.3fs", perf_counter() - step_started)

    step_started = perf_counter()
    ensure_schema()
    logger.info("Startup step ensure_schema completed in %.3fs", perf_counter() - step_started)

    # Account-system backfill: create users for legacy api_keys, mark genesis,
    # seed synthetic admin user. Idempotent — safe to run on every boot.
    step_started = perf_counter()
    try:
        result = accounts_db.backfill_users(
            name_generator=generate_display_name,
            forbidden_substrings=FORBIDDEN_SUBSTRINGS,
            admin_key=settings.ADMIN_API_KEY,
            legacy_keys=list(settings.API_KEYS or []),
        )
        logger.info(
            "Startup step accounts backfill: created=%d genesis_marked=%d admin_seeded=%s in %.3fs",
            result["created"], result["genesis_marked"], result["admin_seeded"],
            perf_counter() - step_started,
        )
    except Exception as exc:  # pragma: no cover — startup must not crash
        logger.warning("Account backfill failed (non-fatal): %s", exc)

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
            from .tasks import weekly_backup
            weekly_backup.stop()
        except Exception:
            pass
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
)


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
app.include_router(admin.router, prefix="/api")
app.include_router(admin_users.router, prefix="/api")
app.include_router(admin_feature_flags.router, prefix="/api")
app.include_router(admin_backups.router, prefix="/api")
app.include_router(admin_contributions.router, prefix="/api")
app.include_router(admin_totp.router, prefix="/api")
app.include_router(admin_webauthn.router, prefix="/api")
app.include_router(account.router, prefix="/api")
app.include_router(invite.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/me")
async def me(info: dict = Depends(verify_api_key_info)):
    """Return capabilities for the currently authenticated API key."""
    can_contribute = info.get("permissions") == "contribute"
    return {
        "is_admin": bool(info.get("is_admin")),
        "can_contribute": can_contribute,
    }
