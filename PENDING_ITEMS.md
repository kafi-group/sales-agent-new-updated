# Pending Items — AI Sales Agent (Sara / Rayan)

Written 2026-09-29, after the freeze / Vapi 400 / repeated-redial fixes.
Already fixed today (commits `43fa0e0`, `9f913b9`, `f5e768c`): Vapi 400 (top-level
`recordingEnabled`), Gemini blocking the event loop, Sara redialing after an answered call or End Call.

## 1. Vapi API key hardcoded in `backend/config.py` — DONE (rotation still needed)
- **Problem:** the live Vapi key and phone-number ID were default values in `config.py` and are in GitHub.
- **Done:** `VAPI_API_KEY` and `VAPI_PHONE_NUMBER_ID` are now Railway variables (same values, so nothing
  changed for calls) and the defaults were removed from the code.
- **Still to do (owner):** the old key is still in git history, so it must be **rotated** in the Vapi
  dashboard, then update `VAPI_API_KEY` on Railway. Until then the old key should be treated as exposed.
- **Local dev:** put both values in `backend/.env`.

## 2. Recordings and captions are OFF — plan, not started
- **Why off:** the original code downloaded the audio and saved transcripts inside the same request that
  handles the end of the call, holding a DB connection while waiting on the network (15 s+). That helped jam
  the DB pool, so it was removed (`f4d6c7a`) and Vapi recording was turned off (`149f8ff`).
- **Plan:** (a) turn recording back on in Vapi (`assistant.artifactPlan`, NOT a top-level
  `recordingEnabled` — Vapi rejects that with HTTP 400); (b) when the call-ended webhook arrives, answer
  immediately and hand the saving to a background thread; (c) that thread opens its own short-lived DB
  session, downloads the audio, writes it to the call's history row, and closes the session.
  Nothing on the request path waits on the network, so it cannot freeze the app or block a call.
- Existing pieces still in code: `modules/call_media.py` (`save_ai_call_media`, playback),
  the on-open backfill in `modules/calls.py`, and the End Call media fetch in `api/ai_sales_agent.py`.

## 3. Long calls are cut off at 3 minutes — SAVED FOR LATER
- `_do_reconcile_live_calls` in `backend/api/ai_sales_agent.py` ends any call still live after
  `age >= 180` seconds ("Call timed out (no status update)"), even mid-conversation.
- Idea for later: skip that timeout when Vapi reports the call as `in-progress` (task is flagged
  `answered`), or raise it a lot. Not scheduled.

## 4. DB pool can still jam — ROOT CAUSE OF THE FREEZE FIXED 2026-09-29 (`c4c8a23`), pool jams still possible
- **Found at ~15:00 PKT:** the whole web server hung (health check -> 502) while background jobs kept running.
  Cause: `require_api_auth` in `backend/main.py` is `async` but did a **blocking** DB lookup on the event
  loop when the auth cache missed. A dead Supabase connection (SSL closed) or full pool blocked it for up to
  25 s and stalled every request. Fix: the lookup now runs in a worker thread with a 10 s cap (503 + Retry-After
  instead of hanging).
- Still visible in logs: background jobs (Bulk email schedule, AI Mode email, Auto Trash) hit
  `SSL connection has been closed unexpectedly` about every 2 minutes and recover by disposing the pool.
  Worth a look: those scheduled jobs may be silently failing on some runs.
- If the site ever hangs again: `curl https://kafi-sales-agent-production.up.railway.app/api/health` —
  502 after ~15 s means the web side is stuck; restart from Railway and send the time.
- Seen at 07:45 UTC and 08:39 UTC on 2026-09-29: `QueuePool limit ... reached` and
  `SSL connection has been closed unexpectedly` (Supabase pooler dropping connections).
- Cause not proven. The polling endpoints (interested follow-ups, meeting alerts, unread counts) run heavy
  queries on every poll from every open tab and were the ones failing. Pool is now the code default 16+24=40
  (Railway overrides `DB_POOL_SIZE=8`, `DB_MAX_OVERFLOW=17` were deleted).
- **Not the same problem as item 3.** Item 3 cuts a live call at 3 minutes; item 4 is the database running
  out of connections. They touch the same polling code, but nothing links them.
- If it jams: restart from Railway, then look at the heavy polling queries.

## 5. Unanswered calls redial up to 10 times — KEEP AS IS, DISCUSS NEXT WEEK
- By design (`max_ring_attempts = 10` in `config.py`, ~16 s each). There was a reason for it. Do not change
  before the discussion.

## Notes
- Core rule from `error_and_fix_log.md`: do not alter Railway configs, DB query chains, SMTP/WhatsApp
  integrations, or the Sara/Rayan runners unless asked.
