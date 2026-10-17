from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import (
    agent_bridge,
    ai_mode,
    ai_sales_agent,
    auth,
    calls,
    catalogues,
    chatbot,
    compliance,
    custom_modules,
    data_synthesis,
    email_activity,
    email_attachments,
    email_templates,
    guidance,
    horeka,
    inbox,
    interactions,
    kpi,
    leads,
    mail_extras,
    mailer_handoff,
    org_admin,
    personalized_followups,
    sales_assistant,
    scheduler,
    target_workspace,
    track,
    whatsapp,
    whatsapp_personal,
    system,
)
from config import settings
from modules.auth import ensure_default_admin, ensure_sandbox_tester
from modules.lead_discovery import OLD_CLIENTS_IMPORT_PARSER
from db.migrate import run_migrations
from db.session import SessionLocal
from db.seed import seed_sample_data
from jobs.daily_birthday_check import run as run_birthday_check
from jobs.follow_up_scheduler import run as run_follow_up_check
from jobs.national_day_check import run as run_national_day_check

apscheduler = BackgroundScheduler()


def _run_daily_job():
    db = SessionLocal()
    try:
        run_birthday_check(db)
        run_national_day_check(db)
        run_follow_up_check(db)
        from modules import calls as calls_module

        purged = calls_module.purge_old_call_logs(db)
        if purged:
            print(f"Purged {purged} call log(s) older than {calls_module.CALL_HISTORY_RETENTION_DAYS} days.", flush=True)
    finally:
        db.close()


def _run_ai_mode_email_job():
    # One short DB session per mailbox user — never hold a pool connection across
    # every IMAP scan (that exhausted QueuePool under CRM polling on Railway).
    try:
        from modules import ai_mode as ai_mode_module

        result = ai_mode_module.process_all_enabled_email_users()
        q = result.get("queries") or {}
        if q.get("created") or q.get("matched") or result.get("replied"):
            print(
                f"AI Mode job: mailbox_users={q.get('users')} "
                f"queries_matched={q.get('matched')} created={q.get('created')} "
                f"auto_reply_users={result.get('users')} replied={result.get('replied')}",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001
        print(f"AI Mode email job failed: {exc}", flush=True)


def _run_bulk_email_schedule_job():
    db = SessionLocal()
    try:
        from modules import bulk_email_schedule

        results = bulk_email_schedule.process_due_schedules(db)
        if results:
            print(f"Bulk email schedule job: processed {len(results)} campaign(s).", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"Bulk email schedule job failed: {exc}", flush=True)
        # Overnight Supabase SSL drops leave dead pooled connections; clear them.
        if "SSL connection" in str(exc) or "OperationalError" in type(exc).__name__:
            try:
                from db.session import engine

                engine.dispose()
                print("Disposed DB pool after bulk email SSL/OperationalError.", flush=True)
            except Exception as dispose_exc:  # noqa: BLE001
                print(f"DB pool dispose failed: {dispose_exc}", flush=True)
    finally:
        db.close()


def _keepalive_ping():
    """Self-ping public /health every 2 minutes to keep Railway container warm 24/7."""
    import urllib.request
    try:
        base = (
            (settings.public_api_base_url or "").strip()
            or (settings.twilio_webhook_base_url or "").strip()
            or "https://sales-agent-new-updated-production.up.railway.app"
        )
        url = f"{base.rstrip('/')}/api/health"
        req = urllib.request.Request(url, headers={"User-Agent": "Kafi-KeepAlive/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception:
        pass


def _run_ai_sales_processes_job():
    try:
        from jobs.ai_sales_process_runner import run_due_processes

        result = run_due_processes()
        if result.get("ran"):
            print(f"AI Sales processes job: ran {result.get('ran')} process(es).", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"AI Sales processes job failed: {exc}", flush=True)
    try:
        from jobs.ai_sales_auto_mode_start_runner import run_due_auto_mode_starts

        scheduled = run_due_auto_mode_starts()
        if scheduled.get("ran"):
            print(
                f"AI Auto Mode scheduled starts: {scheduled.get('results')}",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001
        print(f"AI Auto Mode scheduled starts failed: {exc}", flush=True)
    try:
        from jobs.ai_sales_data_update_runner import run_data_update_tick

        du = run_data_update_tick()
        acted = [r for r in (du.get("results") or []) if r.get("action") not in ("cooldown",)]
        if acted:
            print(f"AI Data Update tick: {acted}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"AI Data Update job failed: {exc}", flush=True)


def _run_auto_trash_apply_job():
    try:
        from jobs.auto_trash_runner import run_apply_tick

        result = run_apply_tick()
        moved = int(result.get("moved") or 0)
        if moved or result.get("users"):
            print(
                f"Auto Trash apply: users={result.get('users')} moved={moved}",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001
        print(f"Auto Trash apply failed: {exc}", flush=True)


def _run_auto_trash_learn_job():
    try:
        from jobs.auto_trash_runner import run_learn_tick

        result = run_learn_tick()
        print(
            f"Auto Trash learn: ready={result.get('ready')} samples={result.get('samples_seen')}",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Auto Trash learn failed: {exc}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import os
    from pathlib import Path

    # Railway start.sh migrates once before workers; skip here to avoid startup races.
    skip_migrate = os.environ.get("KAFI_SKIP_LIFESPAN_MIGRATE", "").lower() in {
        "1",
        "true",
        "yes",
    }
    if not skip_migrate:
        print("Applying database migrations…", flush=True)
        try:
            run_migrations()
            print("Migrations complete.", flush=True)
        except Exception as exc:
            # Prefer a live API over a permanent Railway 502 during migrate issues.
            print(f"WARNING: Database migration failed (starting anyway): {exc}", flush=True)
    else:
        print("Skipping lifespan migrations (already applied by start.sh).", flush=True)

    try:
        import twilio  # noqa: F401
        from integrations.voice_client import voice_client
        from modules.llm_client import llm_client

        llm_client.reset()
        gemini_chain = llm_client.model_chain()
        print(f"Gemini model chain: {', '.join(gemini_chain)}", flush=True)

        if voice_client.browser_ready:
            voice_client.create_access_token()
            print("Twilio browser calling ready.", flush=True)
        elif voice_client.is_configured:
            print(f"Twilio partially configured: {voice_client.setup_hints()['missing']}", flush=True)
    except ImportError:
        print(
            "WARNING: twilio package not installed — browser calling disabled. "
            "Run: pip install -r requirements.txt",
            flush=True,
        )
    except Exception as exc:
        print(f"WARNING: Twilio calling check failed: {exc}", flush=True)

    # Keep lifespan short. Heavy Old-clients repairs used to block ~40–80s after
    # every Railway deploy, so the edge returned 502 and the dialer showed
    # "Browser calling is not ready" with Application failed to respond.
    try:
        db = SessionLocal()
        try:
            seed_sample_data(db)
            ensure_default_admin(db)
            ensure_sandbox_tester(db)
            from modules.mailbox_env_sync import sync_mailboxes_from_env

            synced = sync_mailboxes_from_env(db)
            if synced:
                print(f"Synced mailboxes from .env for: {', '.join(synced)}", flush=True)
        finally:
            db.close()
    except Exception as exc:
        print(f"WARNING: startup seed/admin failed: {exc}", flush=True)

    def _deferred_startup_repairs() -> None:
        """Country / master_type backfills — never block the HTTP port."""
        try:
            from modules.leads import (
                invalidate_lead_table_filters_cache,
                invalidate_section_counts_cache,
            )
            from modules.post_import_old_clients import (
                backfill_country_from_phones,
                normalize_countries,
            )
            from sqlalchemy import or_
            from db.models import Buyer

            db = SessionLocal()
            try:
                null_master_type_count = (
                    db.query(Buyer)
                    .filter(or_(Buyer.master_type.is_(None), Buyer.master_type == ""))
                    .update({"master_type": "fmcg"}, synchronize_session=False)
                )
                if null_master_type_count:
                    db.commit()
                    print(
                        f"Startup: backfilled {null_master_type_count} buyer(s) "
                        "with default master_type='fmcg'.",
                        flush=True,
                    )

                country_repair = normalize_countries(db, source="old_clients")
                phone_backfill = backfill_country_from_phones(db, source="old_clients")
                repaired = (country_repair.get("changed") or 0) + (
                    phone_backfill.get("changed") or 0
                )
                if repaired or null_master_type_count:
                    if repaired:
                        print(
                            f"Startup: repaired {repaired} Old clients country value(s) "
                            f"(spellings={country_repair.get('changed', 0)}, "
                            f"from_phone={phone_backfill.get('changed', 0)}).",
                            flush=True,
                        )
                    invalidate_lead_table_filters_cache()
                    invalidate_section_counts_cache()
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            print(f"WARNING: deferred startup repairs failed: {exc}", flush=True)

        try:
            from integrations.voice_client import voice_client

            if voice_client.browser_ready:
                voice_client.sync_twiml_app_voice_url()
        except Exception as exc:  # noqa: BLE001
            print(f"WARNING: failed to sync Twilio TwiML App URL: {exc}", flush=True)

    import threading

    threading.Thread(
        target=_deferred_startup_repairs,
        name="startup-repairs",
        daemon=True,
    ).start()

    print("Application startup complete.", flush=True)

    # With --workers >1, only one process should own the daily scheduler.
    lock_path = Path("/tmp/kafi_apscheduler.lock")
    run_scheduler = True
    try:
        if lock_path.exists():
            run_scheduler = False
        else:
            lock_path.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        run_scheduler = os.environ.get("KAFI_ENABLE_SCHEDULER", "true").lower() in {
            "1",
            "true",
            "yes",
        }

    if run_scheduler:
        apscheduler.add_job(_run_daily_job, "cron", hour=8, minute=0, id="daily_scheduler")
        apscheduler.add_job(
            _run_ai_mode_email_job,
            "interval",
            minutes=3,
            id="ai_mode_email",
            max_instances=1,
            coalesce=True,
        )
        apscheduler.add_job(
            _run_bulk_email_schedule_job,
            "interval",
            minutes=2,
            id="bulk_email_schedule",
            max_instances=1,
            coalesce=True,
        )
        apscheduler.add_job(
            _keepalive_ping,
            "interval",
            minutes=2,
            id="keepalive_ping",
            max_instances=1,
            coalesce=True,
        )
        apscheduler.add_job(
            _run_ai_sales_processes_job,
            "interval",
            minutes=1,
            id="ai_sales_processes",
            max_instances=1,
            coalesce=True,
        )
        apscheduler.add_job(
            _run_auto_trash_apply_job,
            "interval",
            minutes=5,
            id="auto_trash_apply",
            max_instances=1,
            coalesce=True,
        )
        apscheduler.add_job(
            _run_auto_trash_learn_job,
            "cron",
            hour=3,
            minute=15,
            id="auto_trash_learn",
            max_instances=1,
            coalesce=True,
        )
        apscheduler.start()
        print("Daily scheduler started in this worker.", flush=True)
    else:
        print("Daily scheduler skipped in this worker (another worker owns it).", flush=True)
    yield
    if run_scheduler:
        apscheduler.shutdown(wait=False)
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


app = FastAPI(
    title="Kafi Commodities Sales Agent",
    description="International sales co-pilot API",
    version="0.1.0",
    lifespan=lifespan,
)

_PUBLIC_API_PATHS = {
    "/api/health",
    "/api/auth/login",
    "/api/calls/twilio-status",
    "/api/mailer/session/redeem",
    "/api/mailer/handoff-login",
    # Mailer SMTP routes use handoff JWT (no session cookie) — must stay public.
    "/api/mailer/report-activity",
    "/api/mailer/append-sent",
    "/api/mailer/prepare-tracked-body",
    "/api/mailer/schedule-bulk",
    "/api/mailer/inline-upload",
    "/api/mailer/attachment-upload",
    "/api/mailer/smtp-credentials",
}
_PUBLIC_API_PREFIXES = (
    "/api/webhooks/",
    "/api/track/",
    "/api/agent-bridge/",
    "/api/catalogues",
    "/api/mailer/inline-media/",
)


def _auth_lookup_sync(token: str):
    """Blocking DB session lookup. Always run in a worker thread, never on the event loop:
    a slow/dead Supabase connection here used to freeze the whole web server."""
    from modules import auth as auth_module
    from sqlalchemy.exc import DBAPIError, OperationalError, TimeoutError as SATimeoutError

    db = SessionLocal()
    try:
        try:
            user = auth_module.get_user_by_token(db, token)
        except (SATimeoutError, OperationalError, DBAPIError) as first_exc:
            # Overnight Supabase SSL drops poison the pool; dispose so the retry
            # (and later requests) get fresh connections instead of 503 forever.
            try:
                from db.session import engine as _db_engine

                _db_engine.dispose()
            except Exception:
                pass
            db.close()
            db = SessionLocal()
            user = auth_module.get_user_by_token(db, token)
            print(
                f"Auth middleware recovered after DB error ({type(first_exc).__name__}); pool disposed.",
                flush=True,
            )
        if not user:
            return None
        role = user.role.value if hasattr(user.role, "value") else str(user.role)
        return (user.id, role)
    finally:
        db.close()


@app.middleware("http")
async def require_api_auth(request, call_next):
    """Require a valid session (Bearer or httpOnly cookie) for dashboard API routes."""
    if request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)
    if path in _PUBLIC_API_PATHS or any(path.startswith(prefix) for prefix in _PUBLIC_API_PREFIXES):
        return await call_next(request)

    from modules import auth as auth_module

    token = auth_module.extract_session_token(
        authorization=request.headers.get("authorization"),
        cookie_header=request.headers.get("cookie"),
        cookies=request.cookies,
    )
    if not token:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=401, content={"detail": "Not authenticated"})

    cached = auth_module.get_cached_auth(token)
    if cached:
        request.state.user_id = cached[0]
        request.state.user_role = cached[1]
        return await call_next(request)

    import asyncio

    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import JSONResponse

    try:
        found = await asyncio.wait_for(run_in_threadpool(_auth_lookup_sync, token), timeout=10.0)
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"detail": "Database busy — retry shortly"},
            headers={"Retry-After": "2"},
        )
    if not found:
        return JSONResponse(status_code=401, content={"detail": "Not authenticated"})
    request.state.user_id, request.state.user_role = found

    return await call_next(request)


# CORS must be registered AFTER auth middleware so it stays outermost.
# Otherwise unauthenticated 401s skip CORS headers and the browser shows "Failed to fetch".
# Production origin listed explicitly; regex covers preview deployments (*.vercel.app).
_CORS_ORIGINS = list(
    dict.fromkeys(
        [
            *settings.cors_origin_list,
            "https://kafi-sales-agent.vercel.app",
            "https://www.kafi-group.com",
            "https://kafi-group.com",
        ]
    )
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(agent_bridge.router, prefix="/api")
app.include_router(agent_bridge.webhook_router, prefix="/api")
app.include_router(agent_bridge.user_router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(org_admin.router, prefix="/api")
app.include_router(custom_modules.router, prefix="/api")
app.include_router(leads.router, prefix="/api")
app.include_router(data_synthesis.router, prefix="/api")
app.include_router(compliance.router, prefix="/api")
app.include_router(interactions.router, prefix="/api")
app.include_router(email_activity.router, prefix="/api")
app.include_router(track.router, prefix="/api")
app.include_router(email_templates.router, prefix="/api")
app.include_router(personalized_followups.router, prefix="/api")
app.include_router(scheduler.router, prefix="/api")
app.include_router(calls.router, prefix="/api")
app.include_router(email_attachments.router, prefix="/api")
app.include_router(inbox.router, prefix="/api")
app.include_router(mail_extras.router, prefix="/api")
app.include_router(mailer_handoff.router, prefix="/api")
app.include_router(calls.webhooks_router, prefix="/api")
app.include_router(chatbot.router, prefix="/api")
app.include_router(sales_assistant.router, prefix="/api")
app.include_router(ai_sales_agent.router, prefix="/api")
app.include_router(ai_sales_agent.webhooks_router, prefix="/api")
app.include_router(kpi.router, prefix="/api")
app.include_router(guidance.router, prefix="/api")
app.include_router(whatsapp.router, prefix="/api")
app.include_router(whatsapp_personal.router, prefix="/api")
app.include_router(whatsapp.webhooks_router, prefix="/api")
app.include_router(ai_mode.router, prefix="/api")
app.include_router(catalogues.router, prefix="/api")
try:  # additive feature: a failure here must never stop the app from booting
    from api import call_followups as _call_followups_api

    app.include_router(_call_followups_api.router, prefix="/api")
except Exception as _cf_exc:  # noqa: BLE001
    print(f"Call follow-ups router disabled: {_cf_exc}", flush=True)
try:  # additive feature: a failure here must never stop the app from booting
    from api import inbox_attachments as _inbox_attachments_api

    app.include_router(_inbox_attachments_api.router, prefix="/api")
except Exception as _ia_exc:  # noqa: BLE001
    print(f"Inbox attachments router disabled: {_ia_exc}", flush=True)
try:  # additive feature: a failure here must never stop the app from booting
    from api import catalogue_upload as _catalogue_upload_api

    app.include_router(_catalogue_upload_api.router, prefix="/api")
except Exception as _cu_exc:  # noqa: BLE001
    print(f"Catalogue upload router disabled: {_cu_exc}", flush=True)
try:  # additive feature: a failure here must never stop the app from booting
    from api import kpi_card_rows as _kpi_card_rows_api

    app.include_router(_kpi_card_rows_api.router, prefix="/api")
except Exception as _kc_exc:  # noqa: BLE001
    print(f"KPI card rows router disabled: {_kc_exc}", flush=True)
try:  # additive feature: a failure here must never stop the app from booting
    from api import master_list_move as _master_list_move_api

    app.include_router(_master_list_move_api.router, prefix="/api")
except Exception as _mm_exc:  # noqa: BLE001
    print(f"Master list move router disabled: {_mm_exc}", flush=True)
try:  # additive feature: a failure here must never stop the app from booting
    from api import kpi_scorecard as _kpi_scorecard_api

    app.include_router(_kpi_scorecard_api.router, prefix="/api")
except Exception as _ks_exc:  # noqa: BLE001
    print(f"KPI scorecard router disabled: {_ks_exc}", flush=True)
try:  # additive feature: a failure here must never stop the app from booting
    from api import call_leg_status as _call_leg_status_api

    app.include_router(_call_leg_status_api.router, prefix="/api")
except Exception as _cl_exc:  # noqa: BLE001
    print(f"Call leg status router disabled: {_cl_exc}", flush=True)
app.include_router(horeka.router, prefix="/api")
app.include_router(target_workspace.router, prefix="/api")
app.include_router(system.router, prefix="/api")


OLD_CLIENTS_IMPORT_PARSER = "old_clients_v2"


@app.get("/api/health")
def health():
    from config import settings
    from integrations.mail_client import mail_client
    from integrations.outlook_client import outlook_client
    from integrations.voice_client import voice_client
    from integrations.whatsapp_client import whatsapp_client
    from modules.mailbox_accounts import hosts_enabled

    # Safe diagnostics only — never return passwords or full emails.
    per_user = {
        "admin": bool(settings.mailbox_admin_email and settings.mailbox_admin_password),
        "asim": bool(settings.mailbox_asim_email and settings.mailbox_asim_password),
        "usmankhan": bool(settings.mailbox_usman_email and settings.mailbox_usman_password),
        "sadia": bool(settings.mailbox_sadia_email and settings.mailbox_sadia_password),
        "finance": bool(settings.mailbox_finance_email and settings.mailbox_finance_password),
    }

    account_sid = (settings.twilio_account_sid or "").strip()
    return {
        "status": "ok",
        "service": "kafi-sales-agent",
        "old_clients_import_parser": OLD_CLIENTS_IMPORT_PARSER,
        "api_port": settings.api_port,
        "mailbox_enabled": bool(settings.mailbox_enabled),
        "mailbox_hosts_enabled": hosts_enabled(),
        "mailbox_smtp_host_set": bool((settings.mailbox_smtp_host or "").strip()),
        "mailbox_imap_host_set": bool((settings.mailbox_imap_host or "").strip()),
        "mailbox_ssl_hostname_set": bool((settings.mailbox_ssl_hostname or "").strip()),
        "mailbox_credentials_key_set": bool((settings.mailbox_credentials_key or "").strip()),
        "mailbox_per_user_env": per_user,
        "resend_configured": bool((settings.resend_api_key or "").strip()),
        "mailer_configured": bool(
            (settings.mailer_handoff_secret or "").strip()
            and (settings.mailer_public_url or "").strip()
        ),
        "mailer_public_url": (settings.mailer_public_url or "").strip() or None,
        "outlook_configured": outlook_client.is_configured,
        "mailbox_configured": hosts_enabled(),
        "outbound_email_configured": mail_client.is_configured,
        "twilio_configured": voice_client.is_configured,
        "twilio_webhooks_ready": voice_client.webhooks_ready,
        "twilio_browser_ready": voice_client.browser_ready,
        "twilio_account_sid": account_sid or None,
        "twilio_twiml_app_sid": (settings.twilio_twiml_app_sid or "").strip() or None,
        "twilio_webhook_base_url": (settings.twilio_webhook_base_url or "").strip() or None,
        "twilio_validate_webhooks": bool(settings.twilio_validate_webhooks),
        "whatsapp_configured": whatsapp_client.is_configured,
        "whatsapp_webhook_configured": whatsapp_client.webhook_configured,
        "whatsapp_cloud_sending_enabled": whatsapp_client.sending_enabled,
        "whatsapp_display_number": (settings.whatsapp_display_number or "").strip() or None,
        "whatsapp_phone_number_id_set": bool(
            (settings.whatsapp_phone_number_id or "").strip()
        ),
        "email_tracking": _email_tracking_health(),
    }


def _email_tracking_health() -> dict:
    from modules.email_tracking import public_api_base

    base = public_api_base()
    return {
        "enabled": bool(base),
        "base_url": base,
        "pixel_path": "/api/track/email-open/{token}.gif",
    }


# Serve the Vite SPA from backend/static when present (Railway all-in-one deploy).
# API routes under /api are registered above; StaticFiles html=True handles client routing.
_static_dir = Path(__file__).resolve().parent / "static"
if _static_dir.is_dir() and (_static_dir / "index.html").is_file():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="spa")
