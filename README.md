# Manvi

A personal AI assistant that works entirely inside WhatsApp. Set reminders, manage daily routines, save contacts, search the web, and forward messages — all by sending a text.

**Live:** [manvi.onrender.com](https://manvi.onrender.com)
**Docs:** [manvi.onrender.com/documentation](https://manvi.onrender.com/documentation)

---

## Quick start

```bash
git clone https://github.com/viswabnath/whatsapp-reminder-bot
cd whatsapp-reminder-bot
npm install
cp .env.example .env   # fill in your keys
npm run dev
```

Full setup guide — including Meta webhook configuration, Supabase schema, and Render deployment — is at [manvi.onrender.com/documentation](https://manvi.onrender.com/documentation).

---

## What it does

| Feature | Example |
|---|---|
| One-off reminders | "Remind me to call the bank at 3 PM" |
| Interval reminders | "Remind me every 30 mins to drink water" |
| Daily routines | "Remind me to drink water every day at 10 AM" |
| Weekly recurring | "Remind me to take out the trash every Tuesday at 8 PM" |
| Monthly recurring | "Remind me to pay rent on the 1st of every month at 9 AM" |
| Edit last reminder | "Actually, make that 6 PM" |
| Birthdays & events | "22nd May is Manu's birthday" |
| Save contacts | "Save mom as 919876543210" |
| Message contacts | "Tell mom I'll be 10 minutes late" |
| Web search | "Who won IPL 2024?" |
| Delete tasks | "Delete the drink water routine" |
| Conversational chat | "Explain machine learning simply" |
| Follow-up questions | "Who was the captain?" (after asking about a match) |
| Vague time defaults | "Remind me tomorrow morning to call the doctor" → 9:00 AM |

---

## Stack

- **Runtime:** Node.js + Express on Render (free tier)
- **Database:** Supabase (PostgreSQL)
- **Messaging:** Meta WhatsApp Cloud API
- **AI:** Gemini 3 Flash → Gemini 2.5 Flash → Groq Llama 3.3 → OpenRouter GPT-4o-mini
- **Search:** Tavily (primary) + Serper (fallback)
- **Timezone:** IST (Asia/Kolkata) throughout
- **Uptime monitoring:** UptimeRobot (pings `/api/ping` every 5 min, push alert on downtime)

---

## Database schema

| Table | Purpose |
|---|---|
| `contacts` | Address book |
| `personal_reminders` | One-off and interval reminders |
| `daily_routines` | Daily fixed-time recurring tasks |
| `recurring_tasks` | Weekly and monthly recurring tasks *(added v1.1)* |
| `special_events` | Birthdays and anniversaries |
| `interaction_logs` | Message log + conversational memory source |
| `api_usage` | Daily AI/search quota tracking |
| `system_jobs` | Background job health and heartbeat tracking *(added v1.1.1)* |

### v1.2.0 migration — run once in Supabase

```sql
-- Atomic counter increment for api_usage
CREATE OR REPLACE FUNCTION increment_api_usage(p_date DATE, p_column TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE col_name TEXT := p_column || '_count';
BEGIN
  EXECUTE format(
    'UPDATE api_usage SET %I = COALESCE(%I, 0) + 1 WHERE usage_date = $1',
    col_name, col_name
  ) USING p_date;
END; $$;
```

### v1.1 migration — run once in Supabase

```sql
CREATE TABLE recurring_tasks (
  id               BIGSERIAL PRIMARY KEY,
  phone            TEXT NOT NULL,
  task_name        TEXT NOT NULL,
  reminder_time    TIME NOT NULL,
  recurrence_type  TEXT NOT NULL CHECK (recurrence_type IN ('weekly', 'monthly')),
  day_of_week      INTEGER,
  day_of_month     INTEGER,
  is_active        BOOLEAN DEFAULT TRUE,
  last_fired_date  DATE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- v1.1.1: Job tracking
CREATE TABLE system_jobs (
    job_name TEXT PRIMARY KEY,
    last_fired TIMESTAMPTZ,
    status TEXT DEFAULT 'active'
);

INSERT INTO system_jobs (job_name, status)
VALUES 
    ('Reminder Dispatch', 'active'),
    ('Routine Dispatch', 'active'),
    ('Recurring Task Dispatch', 'active'),
    ('Event Alert', 'active')
ON CONFLICT (job_name) DO NOTHING;
```

---

## Environment variables

See `.env.example` for the full list. Requires keys for: Meta, Supabase, Gemini, Groq, OpenRouter, Tavily, Serper.

| Variable | Required | Purpose |
|---|---|---|
| `VERIFY_TOKEN` | Yes | Meta webhook handshake token |
| `MY_PHONE_NUMBER` | Yes | Your WhatsApp number (digits only, no `+`) |
| `PHONE_NUMBER_ID` | Yes | Meta App → WhatsApp → API Setup |
| `ACCESS_TOKEN` | Yes | Meta permanent access token |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase anon public key |
| `GEMINI_API_KEY` | Yes | Google AI Studio |
| `GROQ_API_KEY` | Yes | Groq console |
| `OPENROUTER_API_KEY` | Yes | OpenRouter |
| `TAVILY_API_KEY` | Yes | Tavily |
| `SERPER_API_KEY` | Yes | Serper.dev |
| `PUBLIC_URL` | Yes | Your app URL, no trailing slash — enables self-ping keep-alive |
| `CRON_SECRET` | Yes | Protects `/api/tick` — set the same value in cron-job.org |
| `WEBHOOK_APP_SECRET` | Recommended | Meta App Secret — enables webhook signature verification |

---

## Testing

```bash
node test.js
```

Runs the full v1.1 integration test suite against your live Supabase instance. Inserts test data, verifies all features, and cleans up after every run. No real WhatsApp messages are sent.

Test suites: Supabase connectivity (7 tables), AI intent parsing (20 cases), reminders, routines, special events, contacts, delete tasks, interval reminders, scheduler logic, usage tracking, server routes + ping shape, conversational memory, missing time UX fix, edit task/undo, WhatsApp markdown formatter, vague time defaults, recurring tasks (weekly + monthly), media handling.

---

## Changelog

### v1.3.0
- **Scheduler reliability:** Atomic claim pattern in all three dispatch functions — `UPDATE WHERE status='pending' RETURNING id` before sending, so two concurrent dispatchers (cron + `/api/tick`) can never send the same reminder twice
- **`Promise.allSettled` in `/api/tick`:** One failing dispatcher no longer blocks the other two
- **Event alert guard:** `eventAlertRunning` flag added — consistent with all other job guards
- **Startup warning:** Server logs a clear warning if `WEBHOOK_APP_SECRET` is not set
- **Webhook signature hardened:** Buffer length checked before `timingSafeEqual` — no more `try/catch` needed for mismatched-length inputs
- **Status dashboard auto-refresh:** Page now re-fetches `/api/status` every 60 seconds automatically
- **"Synced X sec ago" counter:** Live indicator shows how stale the dashboard data is, updating every second
- **`timeAgo()` timestamps:** Jobs table "Last Run" column now shows "3m ago" / "2h ago" instead of raw UTC ISO strings; timestamps re-render every 30 s without a network call
- **Chart legend accuracy:** Legend line swatches now use exact chart colors (`#3b82f6` / `#f43f5e`); failures swatch shows a dashed pattern matching the chart line
- **Toggle buttons via CSS class:** Removed all inline `style.background` writes — active state driven by `.toggle-btn.active` class
- **Jobs table:** Technical description column removed; only the human-readable layman description is shown
- **Test suite v1.2:** New `security` and `ratelimit` suites; atomic claim test in `scheduler` suite; `/api/tick` 403/200 checks in `routes` suite; `system_jobs` added to connectivity table check

### v1.2.0
- **Webhook signature verification:** All incoming Meta webhooks are now verified via `X-Hub-Signature-256` using `WEBHOOK_APP_SECRET` — rejects spoofed requests
- **Per-user rate limiting:** Max 10 messages/minute per sender — protects AI quota from loops or abuse
- **External cron trigger:** New `GET /api/tick` endpoint (protected by `CRON_SECRET`) — called by cron-job.org every minute to run dispatch jobs regardless of process sleep state
- **Self-ping fixed:** `PUBLIC_URL` trailing slash stripped; self-ping now calls `/api/tick` every 4 min instead of `/api/ping`
- **Parallel delete_task:** Four sequential DB round-trips replaced with one parallel search across all tables
- **Usage tracking optimised:** `getUsage()` bounded to last 90 days; `ensureRowExists()` cached by date (eliminates ~180 redundant DB reads/hour); `track()` uses atomic `increment_api_usage` RPC function
- **Status dashboard fix:** AI Inference Engine label now correctly shows "Offline" when today has no heartbeat, not just "Online"/"Degraded"
- **Startup heartbeat:** `ensureRowExists()` called at server startup — today's `api_usage` row is always created, preventing false "down" entries on idle days

### v1.1.1
- **Downtime Detection:** Status dashboard now visualizes offline gaps in red — see exactly when your bot was down.
- **Job Heartbeats:** Track "Last Run" timestamps for every background task (reminders, routines, etc.) directly on the dashboard.
- **90-Day History:** Visual history grid now shows a full 90-day window with intelligent gap filling.
- **Continuous Tracking:** Bot now auto-creates a daily record even on idle days to ensure true uptime history.
- **Self-Pinging Keep-Alive:** Optional `PUBLIC_URL` setting to prevent hosting platforms (like Render) from sleeping.

### v1.1
- **Conversational memory:** Bot reads last 4 turns from `interaction_logs` before each AI call — enables natural follow-up questions
- **Edit task / Undo:** Say "Actually make that 6 PM" after setting a reminder to update it in-place
- **Weekly recurring tasks:** "Remind me every Tuesday at 8 PM to take out the trash"
- **Monthly recurring tasks:** "Remind me on the 1st of every month at 9 AM to pay rent"
- **Missing time UX fix:** No-time reminder/routine/event now asks "At what time?" instead of guessing
- **Vague time defaults:** "Morning" → 9 AM, "afternoon" → 2 PM, "evening" → 6 PM, "night" → 9 PM
- **WhatsApp markdown formatter:** Search and chat responses now render `*bold*`, `_italic_`, `~strike~` natively in WhatsApp
- **Media handling:** Voice notes, images, videos, documents, and stickers now get a clear "I can only read text" reply instead of silently failing
- **UptimeRobot migration:** Keep-alive and downtime push alerts now handled by UptimeRobot on `/api/ping`

### v1.0
- Initial release: reminders, routines, interval reminders, events, contacts, web search, delete tasks, chat

---

Built by [Viswanath Bodasakurthi](https://viswabnath.github.io/portfolio/) | [Onemark](https://onemark.co.in)