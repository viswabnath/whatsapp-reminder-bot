# Manvi System Context for AI Agents

This document helps AI assistants (Claude, GPT, Cursor) understand the Manvi codebase for development.

---

## Architecture Logic

1. **Request Flow**: `server.js` (Webhook) → `gemini.js` (Intent Analysis) → `server.js` (Execution/Database) → `sendMessage.js`
2. **AI Waterfall (4-Tier)**:
   - **Tier 1**: `gemini-3-flash-preview` — attempted first if `gemini_count < 40`
   - **Tier 2**: `gemini-2.5-flash` — catches Tier 1 errors silently
   - **Tier 3**: Groq `llama-3.3-70b-versatile` — free fallback if all Google models fail
   - **Tier 4**: OpenRouter `openai/gpt-4o-mini` — paid last resort
   - Tiers 1 & 2 share the same `gemini_count` (combined cap: 40/day). Tier 3 has its own `groq_count`. Tier 4 has `openrouter_count`.
3. **Search Redundancy**: `search.js` attempts Tavily first (monthly quota). Falls back to Serper (lifetime quota).
4. **Usage Gating**: `usage.js` checks `gemini_count < LIMITS.gemini` before attempting Google tiers. `ensureRowExists()` self-heals missing daily rows automatically.
5. **Timezone**: The entire system operates on `Asia/Kolkata` (IST). All timestamps, time comparisons, and cron expressions are IST-relative.

---

## File Responsibilities

| File | Responsibility |
| :--- | :--- |
| `server.js` | Webhook entry point, Caller ID verification, intent routing, database execution |
| `gemini.js` | 4-tier waterfall — Gemini 3 → Gemini 2.5 → Groq → GPT-4o-mini; prompt engineering and JSON parsing |
| `search.js` | Web search orchestration — Tavily primary, Serper fallback |
| `usage.js` | Self-healing daily row creation; reads/writes `api_usage`; enforces limits before API calls |
| `scheduler.js` | node-cron job runner for reminders, routines, and special events (IST-aware) |
| `supabase.js` | Supabase client initialization and database connection |
| `sendMessage.js` | Meta WhatsApp Cloud API wrapper for outbound messages |

---

## Scheduler Logic (`scheduler.js`)

All IST time operations use `Intl.DateTimeFormat` with `timeZone: "Asia/Kolkata"`.

### One-Off Reminders
- **Cron**: `* * * * *` (every minute)
- Fetches `personal_reminders` where `status = 'pending'`
- Uses `.lte("reminder_time", now)` — ISO 8601 UTC timestamp comparison against `TIMESTAMPTZ`. **Not HH:mm string matching.**
- `buildReminderDate()` in `server.js` converts AI-extracted `HH:MM:SS` to a `+05:30` ISO timestamp before insert
- On match: sends message, updates `status` to `'completed'`

### Daily Routines
- **Cron**: `* * * * *` (every minute)
- Gets current IST time as `HH:mm` using `Intl.DateTimeFormat("en-GB", { hour12: false })`
- Matches `daily_routines` using `.like("reminder_time", \`${timeStr}%\`)` — exact `HH:mm` string prefix
- `reminder_time` **must** be stored as `HH:mm` 24-hour format (e.g., `09:00`)

### Special Events — Double-Lock Alert
- **Cron**: `30 8 * * *` (08:30 AM IST daily)
- Two checks per event in the same job:
  - **Day-Of**: event month/day matches today → celebratory alert
  - **Advance Warning**: event month/day matches tomorrow → "plan ahead" alert
- Tomorrow calculated via `tomorrowDate.setDate(tomorrowDate.getDate() + 1)` in UTC — can be off by 1 near midnight IST

---

## `analyzeMessage()` Return Contract

This is critical — both callers (`server.js`) must handle the return correctly.

| Call type | Returns |
| :--- | :--- |
| `analyzeMessage(msg)` | JSON object with `intent`, `targetName`, `time`, `date`, `taskOrMessage`, `ai_meta` |
| `analyzeMessage(prompt, true)` | `{ text: string, ai_meta: string }` — **never a plain string** |

`server.js` uses `summaryResult.text` and passes `summaryResult.ai_meta` as `overrideAiMeta` to `respond()`.

---

## `respond()` in `server.js`

```js
const respond = async (responseText, overrideAiMeta) => {
  const meta = overrideAiMeta !== undefined ? overrideAiMeta : ai_meta;
  const finalText = meta ? `${responseText}\n\n_${meta}_` : responseText;
  return await replyAndLog(senderPhone, senderName, message, finalText);
};
```

- `ai_meta` is appended **only inside `respond()`** — never manually concatenate it in the call site
- Pass `overrideAiMeta` when the responding model differs from the intent-parsing model (e.g., web search)

---

## Usage Tracking (`usage.js`)

- `ensureRowExists()` is called before every `getUsage()` and `track()` — inserts today's row if missing. No RPC needed.
- `track(service)` does SELECT then UPDATE — not atomic. Fine for single-user personal use.
- Alert thresholds fire WhatsApp messages to owner at 50, 10, and 0 remaining for `serper` and `tavily`.
- `groq_count` column must exist in `api_usage` — added in latest schema.

---

## Database Schema (Supabase)

- `personal_reminders` — `reminder_time` as `TIMESTAMPTZ`, `status` as `pending`/`completed`
- `daily_routines` — `reminder_time` as `TIME` in `HH:mm`, `is_active` boolean
- `special_events` — `event_date` as `DATE`
- `contacts` — address book
- `interaction_logs` — stealth logger
- `api_usage` — daily counts: `gemini_count`, `groq_count`, `openrouter_count`, `tavily_count`, `serper_count`. Rows auto-created by `ensureRowExists()`.

---

## API Quotas & Fallback Thresholds

| Service | Quota | Type | Notes |
| :--- | :--- | :--- | :--- |
| Gemini 3 Flash Preview | ~20 req/day | Daily (free) | Tier 1; errors cascade to Tier 2 |
| Gemini 2.5 Flash | ~20 req/day | Daily (free) | Tier 2; shares `gemini_count` cap of 40 |
| Groq Llama 3.3 70b | 500 req/day | Daily safety cap (free) | Tier 3; tracked via `groq_count` |
| OpenRouter GPT-4o-mini | 50 req/day | Daily safety cap (paid ~$5) | Tier 4; last resort |
| Tavily | 1,000 req/month | Monthly (free) | Auto-alerts at 50, 10, 0 |
| Serper | 2,500 req/lifetime | Lifetime (free) | Auto-alerts at 50, 10, 0 |

---

## Key Constraints

- **No LaTeX**: Never use LaTeX in WhatsApp responses.
- **Keep responses short**: WhatsApp users prefer concise messages.
- **Always check `usage.js`** before AI/search API calls.
- **IST everywhere**: Use `Asia/Kolkata`. Use `Intl.DateTimeFormat("en-GB", { hour12: false })` for `HH:mm`.
- **Reminder vs Routine time storage**: `personal_reminders.reminder_time` is `TIMESTAMPTZ`. `daily_routines.reminder_time` is plain `HH:mm`. Different matching — do not conflate.
- **`respond()` owns `ai_meta` appending**: Never manually append `ai_meta` at call sites.
- **Summary requests return `{ text, ai_meta }`**: Never treat the return as a plain string.
- **`track("groq")` must be called** after every successful Groq response — easy to forget when adding new tiers.
- **Caller ID gating**: Admin commands locked to `MY_PHONE_NUMBER`.
- **No hardcoded secrets**: Everything from `.env`.