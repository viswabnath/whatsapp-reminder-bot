# Manvi — AI Agent Context

This document is the authoritative reference for AI coding assistants (Claude, Cursor, GPT) working on the Manvi codebase. Read this before touching any file.

---

## Project Version

**v1.0** — single-owner personal WhatsApp assistant. One `MY_PHONE_NUMBER`, one Supabase instance, one Render deployment.

**Roadmap direction: SaaS** — Future versions will support multiple users on a shared WhatsApp number. The current architecture is intentionally single-tenant but the DB schema is designed to support multi-tenancy (every table has a `phone` column as the tenant key). Do not make architectural decisions that would make multi-tenancy harder to add later.

---

## Request Flow

```
WhatsApp → Meta Webhook POST /webhook → server.js → gemini.js (intent) → server.js (DB execution) → sendMessage.js
```

---

## File Responsibilities

| File | Responsibility |
| :--- | :--- |
| `src/server.js` | Webhook entry point, page routes, Caller ID, intent router, `/api/ping`, `/api/status` |
| `src/gemini.js` | 4-tier AI waterfall — Gemini 3 Flash → Gemini 2.5 Flash → Groq Llama 3.3 → GPT-4o-mini |
| `src/search.js` | Web search — Tavily primary, Serper fallback |
| `src/usage.js` | Self-healing daily row creation, quota reads/writes, low-credit alerts |
| `src/scheduler.js` | node-cron IST-aware job runner for reminders, routines, and events |
| `src/supabase.js` | Supabase client initialisation |
| `src/sendMessage.js` | Meta WhatsApp Cloud API wrapper |
| `public/index.html` | Landing page — **gitignored, owner-specific branding** |
| `public/documentation.html` | Docs site — **gitignored, owner-specific** |
| `public/status.html` | Manvi system dashboard — served at `/status` |
| `public/styles.css` | Dashboard styles (IBM Plex Mono/Sans) |
| `public/app.js` | Dashboard frontend — fetches `/api/status`, renders charts and metrics |
| `test.js` | v1.0 integration test suite — run with `node test.js` from project root |
| `package.json` | Root level. `src/server.js` requires it as `../package.json` |
| `.env.example` | Template for all required environment variables |

---

## Express Routes (`src/server.js`)

| Method | Path | Handler |
| :--- | :--- | :--- |
| `GET` | `/` | Serves `public/index.html` (landing page) |
| `GET` | `/documentation` | Serves `public/documentation.html` |
| `GET` | `/status` | Serves `public/status.html` (dashboard) |
| `GET` | `/api/ping` | Keep-alive — returns `{ status, latency_ms, timestamp }` |
| `GET` | `/api/status` | Dashboard data — usage, uptime, limits, jobs, version |
| `GET` | `/webhook` | Meta webhook verification handshake |
| `POST` | `/webhook` | Incoming WhatsApp messages — main message handler |

`app.use(express.static("public"))` serves all static assets (CSS, JS). Page routes use `res.sendFile("public/filename.html", { root: "." })`.

---

## AI Waterfall — 4 Tiers (`gemini.js`)

| Tier | Model | Provider | Quota | Tracking |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `gemini-3-flash-preview` | Google | ~20 req/day (free) | `gemini_count` |
| 2 | `gemini-2.5-flash` | Google | ~20 req/day (free, shared with Tier 1, cap: 40) | `gemini_count` |
| 3 | `llama-3.3-70b-versatile` | Groq | 3,000 req/day safety cap (free) | `groq_count` |
| 4 | `openai/gpt-4o-mini` | OpenRouter | 50 req/day safety cap (paid ~$5) | `openrouter_count` |

### Return Contract

| Call | Returns |
| :--- | :--- |
| `analyzeMessage(msg)` | Parsed JSON — `{ intent, targetName, time, date, taskOrMessage, phone, ai_meta }` |
| `analyzeMessage(prompt, true)` | `{ text: string, ai_meta: string }` — never a plain string |

`server.js` accesses `summaryResult.text` and passes `summaryResult.ai_meta` as `overrideAiMeta` to `respond()`.

---

## `respond()` — Single Exit Point

```js
const respond = async (responseText, overrideAiMeta) => {
  const meta = overrideAiMeta !== undefined ? overrideAiMeta : ai_meta;
  const finalText = meta ? `${responseText}\n\n${meta}` : responseText;
  return await replyAndLog(senderPhone, senderName, message, finalText);
};
```

- `ai_meta` is appended only inside `respond()`. Never concatenate it manually at call sites.
- For web search, pass `summaryResult.ai_meta` as `overrideAiMeta`.
- `ai_meta` format: plain text `Model Name — N remaining`. No markdown.

---

## Intent List (complete)

```
reminder | routine | interval_reminder | event | instant_message | chat |
query_birthday | query_schedule | query_events | query_reminders | query_routines | query_contacts |
delete_task | save_contact | web_search | unknown
```

### `queryOnlyIntents` — Address Book Bypass

These intents bypass the address book lookup entirely:

```js
["query_birthday", "query_schedule", "query_events",
 "query_reminders", "query_routines", "query_contacts",
 "save_contact"]
```

### AI Prompt Rules (enforced in `gemini.js` system prompt)

- `routine` is ONLY for fixed daily time — NOT interval-based ("every 5 minutes" → `chat`)
- `delete_task` — `taskOrMessage` must be the core name only, type words stripped
- Vague queries ("list all", "show everything") → `chat`
- `save_contact` — `phone` field carries raw number string; `taskOrMessage` carries the name

---

## Scheduler Logic (`scheduler.js`)

### `interval_reminder` Intent

- Handler: inserts N rows into `personal_reminders` with `group_name = "interval"`
- Spacing: `intervalMinutes` apart, starting from `now + intervalMinutes`
- Window: `durationHours` (default 8) hours from now
- Min interval: 5 minutes
- `query_reminders` groups these separately: shows count remaining and next fire time
- `delete_task` deletes all matching rows by message ILIKE — clears the entire interval set

### CRON 1 — One-off reminders (`* * * * *`)
- `.lte("reminder_time", new Date().toISOString())` — TIMESTAMPTZ comparison
- On match: sends message, updates `status` to `'completed'`

### CRON 2 — Daily routines (`* * * * *`)
- Fetches active routines where `last_fired_date IS NULL OR last_fired_date != todayIST`
- Then compares `routine.reminder_time.slice(0,5)` (HH:MM) against current IST `timeStr` using `>=`
- If scheduled time has passed today and not yet fired → sends message, updates `last_fired_date = todayIST`
- **Requires schema column:** `ALTER TABLE daily_routines ADD COLUMN last_fired_date DATE;`
- This fixes the Render sleep problem — if server restarts at 10:30 AM, a 9:00 AM routine still fires

### CRON 3 — Special events (`30 8 * * *` — 08:30 IST)
- Runs two checks per event in same job: TODAY (celebratory) and TOMORROW (advance warning)
- Year-agnostic — matches `eDay === todayDay && eMonth === todayMonth` only

---

## `buildReminderDate(timeString, dateString = null)`

```js
// With explicit date — uses it directly, no roll-forward
buildReminderDate("09:00:00", "2027-04-05") → ISO timestamp for 9AM IST on 5 Apr 2027

// Without date — defaults to today IST, rolls to tomorrow if time is past
buildReminderDate("15:00:00") → today at 3PM IST, or tomorrow if 3PM already passed
```

Always pass `date || null` as the second argument in the reminder handler.

---

## `save_contact` Intent

```json
{
  "intent": "save_contact",
  "targetName": "Manu",
  "taskOrMessage": "Manu",
  "phone": "919876543210",
  "time": null,
  "date": null
}
```

Handler: strips non-digits from `aiResult.phone`, validates >= 10 digits, upserts on `name` conflict.

---

## Usage Tracking (`usage.js`)

- `ensureRowExists()` — creates today's IST row if missing. Called before every read/write.
- `track(service)` — SELECT then UPDATE (not atomic, acceptable for single-user)
- `getUsage()` returns: `{ gemini, groq, openrouter, serper, tavily, errorsToday, historyLabels, historyData, errorData, historyRaw, daysTracked }`
- Low-credit alerts at 50, 10, 0 remaining for `serper` and `tavily`
- `track("error")` called when all 4 AI tiers fail

---

## Database Schema

| Table | Key columns | Notes |
| :--- | :--- | :--- |
| `contacts` | `name UNIQUE`, `phone` | Address book. Upsert on `name`. |
| `personal_reminders` | `phone`, `message`, `reminder_time TIMESTAMPTZ`, `group_name`, `status` | `status` = `pending` / `completed` |
| `daily_routines` | `phone`, `task_name`, `reminder_time TIME`, `is_active`, `last_fired_date DATE` | `last_fired_date` tracks per-day firing — prevents missed routines on server restart |
| `special_events` | `phone`, `event_type`, `person_name`, `event_date DATE` | Year-agnostic repeat. Owner events use `person_name: "Viswanath"` not `"you"` |
| `interaction_logs` | `sender_name`, `sender_phone`, `message`, `bot_response` | Stealth logger |
| `api_usage` | `usage_date DATE PK`, `gemini_count`, `groq_count`, `openrouter_count`, `tavily_count`, `serper_count`, `error_count` | Auto-created by `ensureRowExists()` |

---

## `/api/status` Response Shape

```json
{
  "success": true,
  "version": "1.0.0",
  "uptime": { "days": 0, "hours": 2, "minutes": 14, "seconds": 32 },
  "limits": { "gemini": 40, "groq": 3000, "openrouter": 50, "serper": 2500, "tavily": 1000 },
  "stats": { "gemini": 5, "groq": 0, "openrouter": 0, "serper": 0, "tavily": 12,
             "errorsToday": 0, "historyLabels": [], "historyData": [], "errorData": [],
             "historyRaw": [], "daysTracked": 14 },
  "jobs": [ { "name": "...", "schedule": "...", "description": "...", "status": "active|scheduled" } ]
}
```

---

## Test Suite (`test.js`)

Run from project root: `node test.js`

Covers: Supabase connectivity, all 6 tables, 16 AI intent scenarios, `buildReminderDate` logic, reminder TIMESTAMPTZ insert/query, routine prefix-match, special event year-agnostic check, contact upsert deduplication, delete `cleanTask` stripping, scheduler queries, usage tracking shape, all 5 HTTP routes.

Uses `TEST_PHONE = "910000000000"` — no real WhatsApp messages are sent. Cleans up all test data after every run.

---

## Key Constraints

- **No emojis** in bot-generated WhatsApp messages or server logs
- **No LaTeX** in WhatsApp responses
- **Keep responses concise** — WhatsApp is not a document editor
- **IST everywhere** — `Asia/Kolkata`. Use `Intl.DateTimeFormat("en-GB", { hour12: false })` for `HH:mm`
- **Do not conflate reminder types** — `personal_reminders.reminder_time` is `TIMESTAMPTZ`; `daily_routines.reminder_time` is `HH:mm`
- **`respond()` owns `ai_meta`** — never append manually
- **`analyzeMessage(prompt, true)` returns `{ text, ai_meta }`** — never treat as plain string
- **`track("groq")` must be called** after every successful Groq response
- **`track("error")` must be called** when all 4 tiers fail
- **`save_contact` upserts on `name`** — never plain `insert`
- **`package.json` at project root** — require as `../package.json` from `src/`
- **`delete_task` uses `cleanTask`** — strip `routine|reminder|task|event` words before ILIKE
- **Owner events** — `person_name` must be `"Viswanath"` when `finalName === "you"`
- **No hardcoded secrets** — all from `.env`
- **Run server from project root** — `npm run dev` or `npm start`
- **`public/index.html` and `public/documentation.html` are gitignored** — owner branding only, not in repo

---

## SaaS Migration Path (v2.0 target)

The current single-tenant architecture must evolve. Any agent working on features beyond v1.0 must consider these constraints:

### What already supports multi-tenancy
- Every DB table has a `phone` column — this is the de-facto tenant key
- Webhook already routes by sender phone — different senders already get different behaviour
- `isOwner` check is the only hardcoded single-tenant gate

### What must change for multi-tenancy

| Component | Current | SaaS target |
| :--- | :--- | :--- |
| `MY_PHONE_NUMBER` | Single `.env` value | `users` table, registration flow |
| `isOwner` check | `senderPhone === MY_PHONE_NUMBER` | Role from DB (`user.role`) |
| API quotas | Owner absorbs all costs | Per-user quota tracking or subscription tier |
| Meta WhatsApp number | Owner's personal number | Shared business number routing by sender |
| `api_usage` table | Single instance-wide counter | Per-user usage rows |
| Admin intents | Owner-only | Scoped to authenticated user's own data |

### Design rules for new features (pre-SaaS)
- Never hardcode owner name `"Viswanath"` in new business logic — use a config value or DB lookup
- Always filter DB queries by `phone` — never fetch all rows across all users
- Do not add new `.env` values that assume a single user — design for a `users` table lookup instead
- `track()` in `usage.js` is instance-wide today — flag any feature that would need per-user tracking

---

## Known Limitations (Accepted)

| Issue | Impact | Mitigation |
| :--- | :--- | :--- |
| `track()` not atomic | Race condition on double-tap | Acceptable for single-user |
| Single-tenant `api_usage` | One row per day for entire instance | Must become per-user in v2.0 |
| `"Viswanath"` hardcoded in event handler | Wrong name for other users | Replace with DB user lookup in v2.0 |
| `MY_PHONE_NUMBER` env var | One owner globally | Replace with `users` table lookup in v2.0 |
| Webhook duplicate delivery | Same message processed twice | Acceptable for personal use |
| Tomorrow UTC edge case in CRON 3 | Event alert 1 day off near midnight IST | Safe for 08:30 window |
| Interval reminders not supported | "Every 5 mins" cannot be a routine | AI prompt rejects, explains to user |