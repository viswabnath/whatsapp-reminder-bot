# Manvi System Context for AI Agents

This document helps AI assistants (Claude, GPT, Cursor) understand the Manvi codebase for development.

---

## Architecture Logic

1. **Request Flow**: `server.js` (Webhook) → `gemini.js` (Intent Analysis) → `server.js` (Execution/Database) → `sendMessage.js`
2. **AI Redundancy**: `gemini.js` attempts `gemini-2.0-flash` natively first. If it fails or hits the `api_usage` daily limit in Supabase, it falls back to OpenRouter.
3. **Search Redundancy**: `search.js` attempts Tavily first (monthly quota). If it fails or quota is exhausted, it falls back to Serper (lifetime quota).
4. **Usage Gating**: `usage.js` is checked before every AI and search API call to prevent quota overages. It reads and writes to the `api_usage` table via the `increment_api_usage` Supabase RPC.
5. **Timezone**: The entire system operates on `Asia/Kolkata` (IST). All database timestamps, time comparisons, and cron expressions are relative to IST.

---

## File Responsibilities

| File             | Responsibility                                                                         |
| :--------------- | :------------------------------------------------------------------------------------- |
| `server.js`      | Webhook entry point, Caller ID verification, intent routing, database execution        |
| `gemini.js`      | Natural language parsing, prompt engineering, Gemini → OpenRouter fallback logic       |
| `search.js`      | Web search orchestration — Tavily primary, Serper fallback                             |
| `usage.js`       | Reads/writes `api_usage` table via RPC; enforces daily/monthly limits before API calls |
| `scheduler.js`   | node-cron job runner for reminders, routines, and special events (IST-aware)           |
| `supabase.js`    | Supabase client initialization and database connection                                 |
| `sendMessage.js` | Meta WhatsApp Cloud API wrapper for outbound messages                                  |

---

## Scheduler Logic (`scheduler.js`)

All IST time operations use `Intl.DateTimeFormat` with `timeZone: "Asia/Kolkata"`. Never use raw `new Date()` without IST conversion in this file.

### One-Off Reminders

- **Cron**: `* * * * *` (every minute)
- Fetches all rows from `personal_reminders` where `status = 'pending'`
- Uses `.lte("reminder_time", now)` — compares a full ISO 8601 UTC timestamp against the stored `TIMESTAMPTZ` column. **This is NOT HH:mm matching.** The `buildReminderDate()` helper in `server.js` converts the AI-extracted `HH:MM:SS` into a proper `+05:30` ISO timestamp before inserting.
- On match: sends the WhatsApp message, then updates `status` to `'completed'`

### Daily Routines

- **Cron**: `* * * * *` (every minute)
- Uses `Intl.DateTimeFormat("en-GB", { hour12: false })` to get the current IST time as `HH:mm`
- Fetches all rows from `daily_routines` where `is_active = true`
- Matches using `.like("reminder_time", \`${timeStr}%\`)`— exact`HH:mm` string prefix match
- `reminder_time` **must** be stored as `HH:mm` 24-hour format (e.g., `09:00`, not `9:00 AM`)
- Fires every day at the matching minute with no date gating

### Special Events — Double-Lock Alert

- **Cron**: `30 8 * * *` (08:30 AM IST daily)
- Fetches all rows from `special_events`
- Runs two independent checks per event in the same job:
  - **Condition 1 (Day-Of)**: If `event_date` month/day matches **today's** IST date → sends celebratory alert
  - **Condition 2 (Advance Warning)**: If `event_date` month/day matches **tomorrow's** IST date → sends "plan ahead" alert
- Tomorrow is calculated using `tomorrowDate.setDate(tomorrowDate.getDate() + 1)` — note this uses UTC date, which could be off by 1 near midnight IST. Take care if modifying this logic.

---

## Database Schema (Supabase)

- `personal_reminders` — One-off tasks (`reminder_time` as `TIMESTAMPTZ`, `status` as `pending`/`completed`)
- `daily_routines` — Recurring tasks (`reminder_time` as `TIME` stored in `HH:mm` 24-hour format, `is_active` boolean)
- `special_events` — Yearly dates like birthdays and anniversaries (`event_date` as `DATE`)
- `contacts` — Address book for multi-user message dispatch
- `interaction_logs` — Stealth logger for all messages and bot responses
- `api_usage` — Tracks daily counts for `gemini_count`, `openrouter_count`, `tavily_count`, `serper_count` per `usage_date`

### Required Supabase RPC

`usage.js` relies on a Postgres function to safely increment API usage counts. Run this in your Supabase SQL Editor:

```sql
CREATE OR REPLACE FUNCTION increment_api_usage(target_date DATE, column_name TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO api_usage (usage_date)
  VALUES (target_date)
  ON CONFLICT (usage_date) DO NOTHING;

  EXECUTE format(
    'UPDATE api_usage SET %I = %I + 1 WHERE usage_date = $1',
    column_name, column_name
  ) USING target_date;
END;
$$ LANGUAGE plpgsql;
```

---

## API Quotas & Fallback Thresholds

| Service          | Quota              | Type             | Fallback Trigger                                                     |
| :--------------- | :----------------- | :--------------- | :------------------------------------------------------------------- |
| Gemini 2.0 Flash | 1,500 req/day      | Daily            | Falls back to OpenRouter                                             |
| OpenRouter       | 50 req/day         | Daily safety cap | Last resort — no further fallback                                    |
| Tavily           | 1,000 req/month    | Monthly          | Falls back to Serper; Manvi auto-alerts owner at 50, 10, 0 remaining |
| Serper           | 2,500 req/lifetime | Lifetime         | No fallback — alerts owner at 50, 10, 0 remaining                    |

---

## Key Constraints

- **No LaTeX**: Never use LaTeX formatting in WhatsApp responses — WhatsApp doesn't render it.
- **Keep responses short**: WhatsApp users prefer concise, actionable messages. Avoid long prose.
- **Always check `usage.js`** before calling any AI or search API to prevent quota overages.
- **IST everywhere**: Never assume UTC. All time parsing, cron expressions, and database writes must use `Asia/Kolkata`. Use `Intl.DateTimeFormat("en-GB", { hour12: false })` for reliable `HH:mm` 24-hour output.
- **Reminder vs Routine time storage**: `personal_reminders.reminder_time` is a full `TIMESTAMPTZ`. `daily_routines.reminder_time` is `HH:mm` plain time string. These use different matching strategies — do not conflate them.
- **`increment_api_usage` RPC must exist**: `usage.js` calls this Supabase function for every API track. If it's missing, all API tracking will silently fail.
- **Caller ID gating**: Admin-only commands (global lists, contacts, all reminders) are locked to `MY_PHONE_NUMBER`. Guests receive a rejection message.
- **No hardcoded secrets**: All API keys and phone numbers must come from `.env` — never inline.
