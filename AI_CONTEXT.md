# Manvi — AI Agent Context

This document is the authoritative reference for AI coding assistants (Claude, Cursor, GPT) working on the Manvi codebase. Read this before touching any file.

---

## Project Version

**v1.2.0** — reliability and security hardening: webhook signature verification, per-user rate limiting, external cron trigger (`/api/tick`), parallel delete_task, atomic usage tracking, fixed keep-alive. Still single-tenant.

**Roadmap direction: SaaS** — Future versions will support multiple users on a shared WhatsApp number. The current architecture is intentionally single-tenant but the DB schema is designed to support multi-tenancy (every table has a `phone` column as the tenant key). Do not make architectural decisions that would make multi-tenancy harder to add later.

---

## Request Flow

```
WhatsApp → Meta Webhook POST /webhook
  → server.js (X-Hub-Signature-256 verification)
  → server.js (media type guard)
  → server.js (rate limit check — 10 msg/min per sender)
  → server.js (Caller ID)
  → interaction_logs (fetch last 4 turns for this sender)
  → gemini.js (intent analysis + history context)
  → server.js (DB execution / intent routing)
  → sendMessage.js + interaction_logs (replyAndLog)

cron-job.org (every 1 min) → GET /api/tick?secret=CRON_SECRET
  → runReminderDispatch() + runRoutineDispatch() + runRecurringDispatch() (parallel)
```

---

## File Responsibilities

| File | Responsibility |
| :--- | :--- |
| `src/server.js` | Webhook entry (signature-verified, rate-limited), page routes, media guard, Caller ID, history fetch, intent router, `/api/ping`, `/api/tick`, `/api/status` |
| `src/gemini.js` | 4-tier AI waterfall. Accepts `history[]`. Runs `formatForWhatsApp()` on summary responses. |
| `src/search.js` | Web search — Tavily primary, Serper fallback |
| `src/usage.js` | Daily row creation (date-cached), quota reads/writes via atomic RPC, low-credit alerts |
| `src/scheduler.js` | Exports `runReminderDispatch`, `runRoutineDispatch`, `runRecurringDispatch` — called by both cron and `/api/tick` |
| `src/supabase.js` | Supabase client initialisation |
| `src/sendMessage.js` | Meta WhatsApp Cloud API wrapper |
| `public/index.html` | Landing page — **gitignored, owner-specific** |
| `public/documentation.html` | Docs site — **gitignored, owner-specific** |
| `public/status.html` | Manvi system dashboard — served at `/status` |
| `public/styles.css` | Dashboard styles (IBM Plex Mono/Sans) |
| `public/app.js` | Dashboard frontend — fetches `/api/status`, renders charts |
| `test.js` | v1.1 integration test suite — `node test.js` from project root |
| `package.json` | Root level. Required from `src/` as `../package.json` |
| `.env.example` | Template for all required environment variables |

---

## Express Routes (`src/server.js`)

| Method | Path | Handler |
| :--- | :--- | :--- |
| `GET` | `/` | Serves `public/index.html` |
| `GET` | `/documentation` | Serves `public/documentation.html` |
| `GET` | `/status` | Serves `public/status.html` |
| `GET` | `/api/ping` | UptimeRobot health check — returns `{ status, latency_ms, timestamp }` |
| `GET` | `/api/tick?secret=…` | External cron trigger — runs reminder/routine/recurring dispatch. Protected by `CRON_SECRET`. |
| `GET` | `/api/status` | Dashboard data — usage, uptime, limits, jobs, version |
| `GET` | `/webhook` | Meta webhook verification handshake |
| `POST` | `/webhook` | Inbound WhatsApp messages — signature-verified, rate-limited |

---

## AI Waterfall — 4 Tiers (`gemini.js`)

| Tier | Model | Provider | Quota | Tracking |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `gemini-3-flash-preview` | Google | ~20 req/day (free) | `gemini_count` |
| 2 | `gemini-2.5-flash` | Google | ~20 req/day shared, cap 40 | `gemini_count` |
| 3 | `llama-3.3-70b-versatile` | Groq | 300 req/day (free) | `groq_count` |
| 4 | `openai/gpt-4o-mini` | OpenRouter | 50 req/day (paid ~$5) | `openrouter_count` |

### Return Contract

| Call | Returns |
| :--- | :--- |
| `analyzeMessage(msg)` | Parsed JSON — `{ intent, targetName, time, date, taskOrMessage, phone, ai_meta, ... }` |
| `analyzeMessage(msg, false, history)` | Same JSON — with history injected into system prompt |
| `analyzeMessage(prompt, true)` | `{ text: string, ai_meta: string }` — text is WhatsApp-formatted |

`server.js` accesses `summaryResult.text` and passes `summaryResult.ai_meta` as `overrideAiMeta` to `respond()`.

---

## Intent List (complete)

```
reminder | routine | interval_reminder | weekly_reminder | monthly_reminder |
event | instant_message | chat |
query_birthday | query_schedule | query_events | query_reminders | query_routines | query_contacts |
delete_task | edit_task | save_contact | web_search | unknown
```

### `queryOnlyIntents` — Address Book Bypass

```js
["query_birthday", "query_schedule", "query_events",
 "query_reminders", "query_routines", "query_contacts",
 "save_contact"]
```

### AI Prompt Rules (enforced in `gemini.js` system prompt)

- `routine` — ONLY fixed daily time. Not interval-based.
- `interval_reminder` — "every X minutes/hours". Extracts `intervalMinutes`, `durationHours` (default 8).
- `weekly_reminder` — "every Monday/Tuesday/...". Extracts `dayOfWeek` (0=Sun … 6=Sat).
- `monthly_reminder` — "every month on the Nth". Extracts `dayOfMonth` (1-31).
- `edit_task` — change/update/correct a previously set reminder. Extracts new `time`, new `date` if mentioned, and `editTarget` (task name from context/history).
- `delete_task` — `taskOrMessage` is core name only, type words stripped.
- `save_contact` — `phone` is raw digits; `taskOrMessage` is the name.
- Vague queries ("list all", "show everything") → `chat`.
- **MISSING TIME RULE:** `reminder`/`routine`/`event` with NO time → `chat` asking "When would you like me to set this?"
- **VAGUE TIME DEFAULTS:** "morning" → `09:00:00`, "afternoon" → `14:00:00`, "evening"/"tonight" → `18:00:00`, "night" → `21:00:00`. AI must append resolved time to `taskOrMessage`.
- **DOWNTIME DETECTION:** `usage.js` generates a continuous 90-day timeline. Gaps between the first record and today are marked as `status: "down"` to show red on the dashboard. Today's row is created at startup via `ensureRowExists()`.
- **JOB HEARTBEATS:** `recordHeartbeat()` in `scheduler.js` upserts to `system_jobs` (in-memory fallback). `ensureRowExists()` is date-cached — only one DB check per calendar day.
- **KEEP-ALIVE:** `server.js` pings `PUBLIC_URL/api/tick` every 4 min (secondary). Primary mechanism is cron-job.org calling `/api/tick` every 1 min.
- **WEBHOOK SECURITY:** `verifyWebhookSignature()` in `server.js` uses `WEBHOOK_APP_SECRET` + `req.rawBody` (captured via `express.json({ verify })`) to validate `X-Hub-Signature-256`.
- **RATE LIMITING:** `_rateLimitMap` in `server.js` — 10 messages/min per `senderPhone`, in-memory.

---

## JSON Fields Reference

```json
{
  "intent": "...",
  "targetName": "you | extracted name",
  "time": "HH:MM:SS | null",
  "date": "YYYY-MM-DD | null",
  "taskOrMessage": "response text | task name | search query",
  "phone": "digits only for save_contact | null",
  "intervalMinutes": "number | null",
  "durationHours": "number | null",
  "dayOfWeek": "0-6 for weekly_reminder | null",
  "dayOfMonth": "1-31 for monthly_reminder | null",
  "editTarget": "core task name for edit_task | null"
}
```

---

## Conversational Memory

Before calling `analyzeMessage`, `server.js` fetches the last 4 `interaction_logs` rows for the current `sender_phone`, ordered `created_at ASC`.

```js
const { data: historyRows } = await supabase
  .from("interaction_logs")
  .select("message, bot_response")
  .eq("sender_phone", senderPhone)
  .order("created_at", { ascending: true })
  .limit(4);

const history = (historyRows || []).map((row) => ({
  userMessage: row.message,
  botResponse: row.bot_response,
}));

const aiResult = await analyzeMessage(message, false, history);
```

### Rules
- History fetched **before** `replyAndLog` — AI always sees the previous N turns, never the current one
- Filtered by `sender_phone` — never cross-user
- Injected as a string block inside the Gemini system prompt — Tier 1 & 2 SDK call pattern unchanged
- AI instructed to use history for context understanding and `edit_task` resolution only — never re-execute past intents
- `isSummaryRequest = true` calls (web search) always pass default `[]`

---

## Edit Task (Undo)

Handler in `server.js`:
1. Extract `editTarget` from `aiResult` (AI resolves from history)
2. Strip type words via `cleanTask`
3. Query `personal_reminders` for most recent pending row matching `cleanTask` by ILIKE
4. DELETE old row by `id`
5. INSERT new row with same `message`, `group_name`, updated `reminder_time`

Only operates on `personal_reminders`. Routine/event editing is a v2.0 consideration.

---

## WhatsApp Markdown Formatter (`formatForWhatsApp`)

Located in `gemini.js`. Applied only to `isSummaryRequest = true` responses (web search summaries and chat answers). Intent JSON responses never pass through it.

| Input | Output |
|---|---|
| `## Heading` | `*HEADING*` |
| `**bold**` | `*bold*` |
| `__bold__` | `*bold*` |
| `~~strike~~` | `~strike~` |
| `` `code` `` | ` ```code``` ` |
| `---` | *(removed)* |

---

## Media Handling

First guard in the `POST /webhook` handler, before any DB calls:

```js
if (!messageData?.text?.body) {
  const mediaTypes = ["audio", "image", "video", "document", "sticker"];
  if (mediaTypes.includes(messageData?.type)) {
    const typeLabel = messageData.type === "audio" ? "voice notes" : `${messageData.type}s`;
    await sendWhatsAppMessage(senderPhone,
      `I can only read text messages right now. I cannot process ${typeLabel}. Please type your request.`
    );
  }
  return; // unknown types (reaction, location) silently dropped
}
```

---

## `respond()` — Single Exit Point

```js
const respond = async (responseText, overrideAiMeta) => {
  const meta = overrideAiMeta !== undefined ? overrideAiMeta : ai_meta;
  const finalText = meta ? `${responseText}\n\n${meta}` : responseText;
  return await replyAndLog(senderPhone, senderName, message, finalText);
};
```

- `ai_meta` appended only inside `respond()` — never at call sites
- For web search, pass `summaryResult.ai_meta` as `overrideAiMeta`
- `ai_meta` format: plain text `Model Name — N remaining`. No markdown.

---

## Scheduler Logic (`scheduler.js`)

### `getISTComponents()` returns
```js
{ day, month, dayOfWeek, todayIST, timeStr }
// day: 1-31 IST
// month: 1-12 IST
// dayOfWeek: 0=Sun … 6=Sat IST
// todayIST: "YYYY-MM-DD"
// timeStr: "HH:mm"
```

### Exported dispatch functions (also called by `/api/tick`)

| Function | Cron | Logic |
|---|---|---|
| `runReminderDispatch()` | `* * * * *` | `.lte("reminder_time", now)` + `status=pending` → send + mark `completed` |
| `runRoutineDispatch()` | `* * * * *` | `last_fired_date IS NULL OR != todayIST` AND `timeStr >= routineHHMM` → send + set `last_fired_date` |
| `runRecurringDispatch()` | `* * * * *` | Weekly: `day_of_week === dayOfWeek`. Monthly: `day_of_month === day`. Both: time gate + `last_fired_date` guard |

Each function has a boolean guard (`reminderRunning`, etc.) to prevent overlapping executions.

### CRON 3 — Special events (`0 3 * * *` → 08:30 IST)
- Year-agnostic day/month match for today and tomorrow
- **Cron-only** — not exported. No idempotency guard, so calling it every minute would send duplicate alerts.

### End-of-month edge case (recurring)
- If today is the last day of the month and `task.day_of_month > day`, fires on the last day instead of skipping the month

### `interval_reminder`
- Inserts N rows into `personal_reminders` with `group_name = "interval"`
- Fired by CRON 1 (it's just pending reminders)
- Min interval: 5 minutes, default window: 8 hours

---

## `buildReminderDate(timeString, dateString = null)`

```js
buildReminderDate("09:00:00", "2027-04-05") // → exact IST timestamp for that date
buildReminderDate("15:00:00")               // → today at 3PM IST, or tomorrow if past
```

Always pass `date || null` as second argument.

---

## Usage Tracking (`usage.js`)

- `ensureRowExists()` — creates today's IST row if missing. Date-cached via `_lastEnsuredDate` — only one DB check per calendar day regardless of call frequency. Also called at server startup.
- `track(service)` — calls `increment_api_usage` RPC (atomic). Falls back to SELECT+UPDATE if RPC not deployed.
- `getUsage()` — queries last 90 days only (not all rows). Serper all-time count fetched separately (single column). Returns `{ gemini, groq, openrouter, serper, tavily, errorsToday, historyRaw, allTimeStats, hourlySuccess, ... }`
- Low-credit alerts at 50, 10, 0 remaining for `serper` and `tavily`
- `track("error")` called when all 4 AI tiers fail

---

## Database Schema

| Table | Key columns | Notes |
| :--- | :--- | :--- |
| `contacts` | `name UNIQUE`, `phone` | Upsert on `name` |
| `personal_reminders` | `phone`, `message`, `reminder_time TIMESTAMPTZ`, `group_name`, `status` | `status` = `pending` / `completed` |
| `daily_routines` | `phone`, `task_name`, `reminder_time TIME`, `is_active`, `last_fired_date DATE` | Fixed daily time. `last_fired_date` prevents double-fire. |
| `recurring_tasks` | `phone`, `task_name`, `reminder_time TIME`, `recurrence_type`, `day_of_week INT`, `day_of_month INT`, `is_active`, `last_fired_date DATE` | `recurrence_type` = `weekly` / `monthly`. Added in v1.1. |
| `special_events` | `phone`, `event_type`, `person_name`, `event_date DATE` | Year-agnostic. Owner uses `person_name: "Viswanath"` |
| `interaction_logs` | `sender_name`, `sender_phone`, `message`, `bot_response`, `created_at` | Stealth log + memory source. Always query with `.eq("sender_phone", ...)` |
| `api_usage` | `usage_date DATE PK`, `gemini_count`, `groq_count`, `openrouter_count`, `tavily_count`, `serper_count`, `error_count` | Auto-created by `ensureRowExists()` |
| `system_jobs` | `job_name TEXT PK`, `last_fired TIMESTAMPTZ`, `status` | Heartbeat log for health tracking |

### v1.2.0 Supabase migration

```sql
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

### v1.1.1 Supabase migration

```sql
CREATE TABLE system_jobs (
    job_name TEXT PRIMARY KEY,
    last_fired TIMESTAMPTZ,
    status TEXT DEFAULT 'active'
);
```

### v1.1 Supabase migration

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
```

---

## `/api/ping` — UptimeRobot

```json
{ "status": "ok", "latency_ms": 42, "timestamp": "..." }
```
- HTTP 200 = healthy → UptimeRobot marks up
- HTTP 500 = Supabase unreachable → UptimeRobot marks down, sends push notification
- Interval: 5 minutes (also serves as Render keep-alive)

---

## `/api/status` Response Shape

```json
{
  "success": true,
  "version": "1.1.0",
  "uptime": { "days": 0, "hours": 2, "minutes": 14, "seconds": 32 },
  "limits": { "gemini": 40, "groq": 3000, "openrouter": 50, "serper": 2500, "tavily": 1000 },
  "stats": { "gemini": 5, "groq": 0, "openrouter": 0, "serper": 0, "tavily": 12, "errorsToday": 0, ... },
  "jobs": [ { "name": "...", "schedule": "...", "description": "...", "status": "active|scheduled", "lastFired": "..." } ]
}
```

---

## Test Suite (`test.js`)

Run: `node test.js` from project root.

| Suite | What it covers |
| :--- | :--- |
| Supabase connectivity | All 7 tables including `recurring_tasks` |
| Build reminder date | Explicit date, no-date, roll-to-tomorrow |
| AI intent parsing | 20 cases including `weekly_reminder`, `monthly_reminder`, `edit_task` |
| Reminders | Insert, fetch, TIMESTAMPTZ, future-dated, scheduler query, mark complete |
| Daily routines | Insert, active fetch, prefix-match, delete |
| Special events | Insert, year-agnostic match, owner name |
| Contacts | Insert, ILIKE, upsert dedup, digit-stripping |
| Delete tasks | cleanTask stripping, ILIKE delete, empty case |
| Interval reminders | Row generation, future check, bulk delete |
| Scheduler logic | TIMESTAMPTZ .lte, last_fired_date guard, no-double-fire |
| Usage tracking | ensureRowExists, shape check |
| Server routes | All 5 routes + /api/ping shape (UptimeRobot) |
| Conversational memory | Seed rows, phone-scoped fetch, ordering, shape, follow-up AI call, cross-phone isolation |
| Missing time UX fix | 3 no-time cases + positive control |
| Edit task / Undo | DB seed, ILIKE find, delete+insert, old row gone, new time correct, AI intent |
| WhatsApp formatter | 7 conversion cases + plain text passthrough (sync) |
| Vague time defaults | morning/afternoon/evening/night resolution |
| Recurring tasks | Weekly+monthly insert, fetch, last_fired_date guard, day filter, AI intent for both |
| Media handling | 8 type detection cases, reply labels, no-emoji check (sync) |

`TEST_PHONE = "910000000000"` — no real WhatsApp messages sent. `cleanup()` removes all test data from all 7 tables.

---

## Key Constraints

- **No emojis** in bot-generated WhatsApp messages or server logs
- **No LaTeX** in WhatsApp responses
- **Keep responses concise** — WhatsApp is not a document editor
- **IST everywhere** — `Asia/Kolkata`. Use `Intl.DateTimeFormat` throughout.
- **`respond()` owns `ai_meta`** — never append manually
- **`analyzeMessage(prompt, true)` returns `{ text, ai_meta }`** — never treat as plain string
- **`analyzeMessage` third param `history[]`** — always pass `[]`, never `undefined`
- **`formatForWhatsApp()`** — runs on `isSummaryRequest=true` only, never on JSON intent responses
- **`track("groq")`** — must be called after every successful Groq response
- **`track("error")`** — must be called when all 4 tiers fail
- **`save_contact` upserts on `name`** — never plain insert
- **`edit_task` operates on `personal_reminders` only** — not routines or events
- **`recurring_tasks` uses `last_fired_date`** — same guard pattern as `daily_routines`
- **`delete_task` searches 4 tables in parallel** — `personal_reminders`, `daily_routines`, `recurring_tasks`, `special_events`. Deletes first match in priority order.
- **`query_routines` shows both** `daily_routines` and `recurring_tasks`
- **`package.json` at project root** — require as `../package.json` from `src/`
- **Owner events** — `person_name` must be `"Viswanath"` when `finalName === "you"`
- **No hardcoded secrets** — all from `.env`
- **`public/index.html` and `public/documentation.html` are gitignored**
- **History fetch always phone-scoped** — never query `interaction_logs` without `.eq("sender_phone", ...)`

---

## SaaS Migration Path (v2.0 target)

### What already supports multi-tenancy
- Every DB table has a `phone` column — de-facto tenant key
- Webhook routes by sender phone
- History fetch is phone-scoped — works per-user today
- `recurring_tasks` designed phone-scoped from the start

### What must change for multi-tenancy

| Component | Current | SaaS target |
| :--- | :--- | :--- |
| `MY_PHONE_NUMBER` | Single `.env` value | `users` table, registration flow |
| `isOwner` check | `senderPhone === MY_PHONE_NUMBER` | Role from DB |
| API quotas | Owner absorbs all costs | Per-user quota tracking |
| Meta WhatsApp number | Owner's personal number | Shared business number |
| `api_usage` table | One row per day, instance-wide | Per-user rows |

### Design rules for new features
- Never hardcode `"Viswanath"` in new business logic
- Always filter DB queries by `phone`
- Do not add new `.env` values that assume a single user
- Flag any feature that would need per-user usage tracking

---

## Known Limitations (Accepted)

| Issue | Impact | Mitigation |
| :--- | :--- | :--- |
| Rate limit is in-memory | Resets on restart; no cross-process sharing | Acceptable for single-tenant |
| Single-tenant `api_usage` | One row per day for entire instance | Per-user in v2.0 |
| `"Viswanath"` in event handler | Wrong name for other users | DB lookup in v2.0 |
| Uptime counter resets on restart | `process.uptime()` resets to 0 | Expected — UptimeRobot covers real downtime detection |
| Tomorrow UTC edge case in CRON 3 | Event alert 1 day off near midnight IST | Safe for 08:30 window |
| `edit_task` only targets reminders | Can't edit routines or events in-place | Accepted scope for v1.1 |
| History not injected for summary calls | Web search summaries stateless | Acceptable by design |
| Webhook duplicate delivery | Same message processed twice | Acceptable for personal use |