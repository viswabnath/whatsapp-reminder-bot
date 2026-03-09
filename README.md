# 🧠 Manvi — Your Agentic Second Brain

> _A personal WhatsApp assistant that remembers, researches, and monitors itself._

Built by [Onemark](https://onemark.digital) · The ultimate friction-less assistant.

---

## 💡 Why Manvi Exists

Most reminder apps force you to leave WhatsApp, open another app, navigate menus, set times, and save. By the time you're done, you've forgotten why you opened it.

**Manvi lives where you already are** — inside WhatsApp. Powered by Google's Gemini AI, you type like you're texting a friend:

```
"Remind me at 4 PM to review Onemark Stories"
```

Done. Manvi's AI parses the intent, stores it securely in PostgreSQL, and pings you exactly at 4 PM. No app switching. No rigid formats. No friction.

---

## ✨ What's New in Manvi 2.0

Manvi is now an **Agentic AI** with built-in redundancy and live web access:

- 🧠 **4-Tier Waterfall AI**: Gemini 3 Flash → Gemini 2.5 Flash → Groq Llama 3.3 → GPT-4o-mini. Automatic cascading with zero downtime.
- 🌐 **Live Web Search**: Integrated Tavily (Primary) and Serper (Emergency Fallback) for real-time information.
- 📊 **Usage Tracking**: Real-time monitoring of API quotas across all services via the `/limit` command.
- 🚨 **Autonomous Alerts**: Manvi will text you automatically when your search credits are running low.
- 🔔 **Double-Lock Event Alerts**: Special events fire two alerts — a 24-hour advance warning to plan ahead, and a celebratory alert on the actual day.
- 🔄 **Hardened Routines**: Daily routines use strict IST 24-hour time-matching so they never miss a beat.
- 🩺 **Self-Healing Usage Tracker**: Daily API usage rows are created automatically — no manual DB setup needed.

---

## ✨ What Manvi Does

```
🤖  AI Powered             Understands messy, natural language via a 4-tier waterfall:
                          Gemini 3 → Gemini 2.5 → Groq Llama 3.3 → GPT-4o-mini

🌐  Live Web Search        "Who won the game yesterday?" or "What's the weather in Vizag?"
                          Powered by Tavily (primary) and Serper (fallback)

🔍  Memory Retrieval       "What is my schedule today?" or "When is dad's birthday?"
                          Instantly queries the database to fetch saved events

🔔  One-Off Reminders      "Remind me at 3 PM to call dad"
                          Extracts the task and time automatically

🔔  Double-Lock Event      "Manu's birthday is on Feb 9th"
    Alerts                Gets you an early-warning alert 24 hours before
                          to plan, and a second alert on the actual day

🔄  Hardened Routines      "Set a routine to check logs at 9 AM"
                          Engineered with strict 24-hour IST time-matching
                          so daily routines never miss a beat

🎂  Yearly Events          "Manu's birthday is on Feb 9th 2026"
                          Never miss a birthday or anniversary again

✉️  Instant Dispatch       "Tell Manu I will be 10 minutes late"
                          Forwards messages instantly via the bot

📊  Usage Dashboard        /limit — See remaining API credits across all brains and search engines

💬  Conversational Chat    Can answer simple questions and tell jokes when prompted

🔒  Admin-Only Access      Caller ID verification blocks guests from accessing global lists

📇  Secure Address Book    Cross-references names with a secure Supabase database

⏰  IST-Native Cron        Runs on Indian Standard Time, immune to cloud server timezone bugs
```

---

## 🎯 How to Talk to Manvi

Because Manvi uses AI, you don't need to memorize commands. Just talk to her naturally:

### Reminders & Routines

```
You:   Remind me to drink water at 2:00 PM
Manvi: ✅ Reminder set for you at 2:00 PM
       ⚡ Gemini 3 Flash (38 left)
```

### Double-Lock Event Alerts

```
(Day before Manu's birthday — 08:30 AM IST)
Manvi: ⏳ Advance Alert: Tomorrow is Manu's birthday!
       I'm letting you know now so you can prepare something special. 🎁

(On Manu's birthday — 08:30 AM IST)
Manvi: 🥳 TODAY IS THE DAY! It's Manu's birthday! Time to send your best wishes! 🎈
```

### Live Web Search

```
You:   Who won the IPL match yesterday?
Manvi: 🌐 Search Results (Tavily)

       India won the IPL final against...
       ⚡ Gemini 3 Flash (37 left)
```

### Memory Retrieval (Schedules & Dates)

```
You:   What is my schedule for today?
Manvi: 📅 Your Schedule for 2026-02-27:

       *Special Events:*
       - Manu's birthday 🎉

       *Reminders:*
       - 2:00 PM: drink water

You:   When is dad's birthday?
Manvi: 🎂 Dad's birthday is saved as 1970-05-15.
```

### Address Book & Instant Messages

```
You:   Shoot a text over to Manu and tell her I'm heading home
Manvi: ✅ Message successfully sent to Manu!
(Manu receives: ✨ Message from Viswanath: I'm heading home)
```

### Usage Dashboard

```
You:   /limit
Manvi: 📊 Manvi System Limits

       🧠 AI BRAINS
       • Gemini: 5 / 40
       • Groq: 12 / 500
       • OpenRouter: 0 / 50

       🔍 SEARCH ENGINES
       • Tavily (Monthly): 45 / 1,000
       • Serper (Lifetime): 12 / 2,500

       Status: All systems operational ✅
```

### Conversational Chat

```
You:   Tell me a joke!
Manvi: Why do programmers prefer dark mode? Because light attracts bugs!
       ⚡ Gemini 3 Flash (36 left)
```

### Admin-Only Commands (Owner Only)

Manvi checks Caller ID before revealing global lists. If a guest asks, they are rejected.

```
You:   What active reminders do I have?
Manvi: 🔔 Active Upcoming Reminders:
       - [Feb 27, 4:00 PM] review Onemark Stories
       - [Feb 28, 9:00 AM] dad: take medicine

Manu:  What contacts do you have?
Manvi: 🔒 I'm sorry Manu, but only Viswanath has clearance to access my global memory banks.
```

---

## 🏗 Tech Stack

| Layer      | Technology                                                    |
| ---------- | ------------------------------------------------------------- |
| Runtime    | Node.js + Express                                             |
| Messaging  | Meta Cloud API (WhatsApp)                                     |
| AI Tier 1  | Google Gemini 3 Flash Preview (first ~20 req/day, free)       |
| AI Tier 2  | Google Gemini 2.5 Flash (overflow ~20 req/day, free)          |
| AI Tier 3  | Groq — Llama 3.3 70b (500 req/day safety cap, free)           |
| AI Tier 4  | OpenAI GPT-4o-mini via OpenRouter (paid bulletproof fallback) |
| Web Search | Tavily (Primary) + Serper (Fallback)                          |
| Database   | Supabase (PostgreSQL)                                         |
| Scheduler  | node-cron (IST timezone-aware)                                |
| Hosting    | Render.com                                                    |

---

## 🗄 Database Schema

Manvi's brain runs on six tables. Run these in your Supabase SQL Editor:

```sql
-- 1. Address Book — names → phone numbers
CREATE TABLE contacts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL
);

-- 2. One-Off Reminders
CREATE TABLE personal_reminders (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  reminder_time TIMESTAMP WITH TIME ZONE NOT NULL,
  group_name VARCHAR(50),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Daily Routines
-- reminder_time must be stored as HH:mm 24-hour format e.g. 09:00
CREATE TABLE daily_routines (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  task_name TEXT NOT NULL,
  reminder_time TIME NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

-- 4. Yearly Events
CREATE TABLE special_events (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  event_type VARCHAR(50),
  person_name VARCHAR(100),
  event_date DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Interaction Logs (Stealth Logger)
CREATE TABLE interaction_logs (
  id SERIAL PRIMARY KEY,
  sender_name VARCHAR(50),
  sender_phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  bot_response TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. API Usage Tracker
-- Rows are created automatically by usage.js — no manual inserts needed
CREATE TABLE api_usage (
  usage_date DATE PRIMARY KEY,
  gemini_count INT DEFAULT 0,
  groq_count INT DEFAULT 0,
  openrouter_count INT DEFAULT 0,
  tavily_count INT DEFAULT 0,
  serper_count INT DEFAULT 0
);
```

---

## 🚀 Setup — Get Manvi Running

> 💡 Most external services used in this project have free tiers sufficient to run Manvi personally. The only exception is **OpenRouter**, which requires a small credit top-up (~$5) as a paid bulletproof last-resort fallback.

### 1 · Clone the repo

```bash
git clone https://github.com/viswabnath/manvi-whatsapp-assistant.git
cd manvi-whatsapp-assistant
npm install
```

### 2 · Configure secrets

Create a `.env` file — **never commit this**:

```env
PORT=3000
VERIFY_TOKEN=your_custom_verify_token_here
MY_PHONE_NUMBER=your_whatsapp_number_with_country_code

# Meta Cloud API
PHONE_NUMBER_ID=your_meta_phone_number_id
ACCESS_TOKEN=your_meta_access_token_here

# Supabase
SUPABASE_URL=https://[your-project-id].supabase.co
SUPABASE_KEY=your_supabase_secret_key

# AI Models — 4-Tier Waterfall
GEMINI_API_KEY=your_gemini_api_key_here         # Tier 1 & 2 — ~40 req/day combined (free)
GROQ_API_KEY=your_groq_api_key_here              # Tier 3 — Llama 3.3, 500 req/day cap (free)
OPENROUTER_API_KEY=your_openrouter_api_key_here  # Tier 4 — GPT-4o-mini (paid, ~$5 credit)

# Search APIs
TAVILY_API_KEY=your_tavily_api_key_here          # Primary Search — 1,000 req/month (free)
SERPER_API_KEY=your_serper_api_key_here          # Backup Search — 2,500 req/lifetime (free)
```

### 3 · Run locally

```bash
node src/server.js
```

Manvi will be live at `http://localhost:3000`

---

## ☁️ Deploy to Render

1. Connect your GitHub repo to a new Render Web Service
2. Set **Build Command** to `npm install` and **Start Command** to `node src/server.js`
3. Add all your `.env` variables to Render's **Environment Variables** section
4. Copy your live Render URL, append `/webhook`, and paste it into the Meta App Dashboard
5. Set up a free cron-job via [cron-job.org](https://cron-job.org) pointing to your root URL (`/`) to keep the free Render instance awake 24/7

---

## 📁 Project Structure

```
manvi-whatsapp-assistant/
├── src/
│   ├── server.js           # Webhook handler, AI router & Caller ID
│   ├── scheduler.js        # node-cron IST job runner (reminders, routines, events)
│   ├── supabase.js         # Database connection client
│   ├── sendMessage.js      # Meta WhatsApp API wrapper
│   ├── gemini.js           # 4-tier waterfall: Gemini 3 → Gemini 2.5 → Groq → GPT-4o-mini
│   ├── search.js           # Tavily + Serper search orchestration
│   └── usage.js            # API quota tracking with self-healing row creation
├── .env                    # 🔒 Never commit — secrets only
├── .gitignore
├── package.json
└── README.md
```

---

## 🔐 Understanding Meta Tokens

Meta requires two different tokens for the WhatsApp Cloud API.

### `VERIFY_TOKEN` — Webhook Verification

When you set up the webhook in Meta's Developer Dashboard, Meta pings your server to verify ownership. You invent a random string (e.g., `onemark_manvi_2025`), put it in `.env` as `VERIFY_TOKEN`, and paste the exact same string into the Meta Dashboard.

### `ACCESS_TOKEN` — Sending Messages

This token authorizes Manvi to send WhatsApp messages via the Meta Cloud API.

**⚠️ Important: The 24-Hour Expiry Rule**

- **For Development:** Meta provides a Temporary Access Token that expires every 24 hours. You'll need to click "Refresh" in the Meta Dashboard daily and update your `.env`. If it expires, you'll see `AxiosError: 401 (Unauthorized)` in logs.

- **For Production:** Create a System User in Meta Business Settings and generate a Permanent Access Token with `whatsapp_business_messaging` permissions. This never expires.

---

## 🐛 Common Issues

### "Webhook verification failed"

Your `VERIFY_TOKEN` in `.env` doesn't match what you entered in the Meta Dashboard. They must be identical.

### "401 Unauthorized" when sending messages

Your `ACCESS_TOKEN` expired (24-hour limit for temporary tokens). Refresh it in the Meta Dashboard and update `.env`.

### "Reminder didn't fire at the right time"

`personal_reminders` uses full ISO timestamp comparison (`.lte`), not time string matching. Ensure `buildReminderDate()` in `server.js` is generating the correct `+05:30` offset timestamp when inserting.

### "Routine fired at wrong time or skipped"

Ensure `reminder_time` values in `daily_routines` are stored in `HH:mm` 24-hour format (e.g., `09:00`, not `9:00 AM`). The scheduler uses exact string prefix matching against current IST time.

### "Special event alert didn't fire"

Special event alerts run once daily at **08:30 AM IST**. Verify your server is alive at that time and that the event's month/day in the database is correct.

### Render instance sleeping

Free Render instances sleep after 15 minutes of inactivity. Set up a cron-job at [cron-job.org](https://cron-job.org) to ping your root URL every 10 minutes.

### "Search returned no results" or fallback triggered

Tavily monthly quota (1,000 req) may be exhausted. Manvi will automatically switch to Serper and alert you via WhatsApp. Run `/limit` to check current usage.

### "All AI models offline"

All 4 tiers have hit their daily limits simultaneously — extremely unlikely in personal use. Wait for the daily reset or increase the `groq` or `openrouter` cap in `usage.js`.

---

## 💛 Credits

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org)
[![Maintained by Onemark](https://img.shields.io/badge/Maintained%20by-Onemark-ff69b4)](https://onemark.digital)

Built with care by [Onemark](https://onemark.digital)  
Maintained by [Viswanath Bodasakurthi](https://github.com/viswabnath)

---

_Manvi means "Goddess of Knowledge" in Sanskrit — a fitting name for an AI second brain._
