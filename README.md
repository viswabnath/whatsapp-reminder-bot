# 🧠 Manvi — Your Second Brain

> *A personal WhatsApp assistant that remembers so you don't have to.*

Built by [Onemark](https://onemark.digital) · Designed for people who think in messages, not apps.

---

## 💡 Why Manvi Exists

Most reminder apps force you to leave WhatsApp, open another app, navigate menus, set times, and save. By the time you're done, you've forgotten why you opened it.

**Manvi lives where you already are** — inside WhatsApp. Powered by Google's Gemini AI, you type like you're texting a friend:

```
"Remind me at 4 PM to review Onemark Stories"
```

Done. Manvi's AI parses the intent, stores it securely in PostgreSQL, and pings you exactly at 4 PM. No app switching. No rigid formats. No friction.

---

## ✨ What Manvi Does

```
🤖  AI Powered             Understands messy, natural language using Gemini 2.5 Flash

🔍  Memory Retrieval       "What is my schedule today?" or "When is dad's birthday?"
                          Instantly queries the database to fetch saved events
                          
🔔  One-Off Reminders      "Remind me at 3 PM to call dad"
                          Extracts the task and time automatically

🔄  Daily Routines         "Set a routine to remind mom to take medicine at 9 AM"
                          Set it once, runs every day forever

🎂  Yearly Events          "Manu's birthday is on Feb 9th 2026"
                          Never miss a birthday or anniversary again

✉️  Instant Dispatch       "Tell Manu I will be 10 minutes late"
                          Forwards messages instantly via the bot

💬  Conversational Chat    Can answer simple questions and tell jokes when prompted

🔒  Admin-Only Access      Caller ID verification blocks guests from accessing global lists

📊  Stealth Logger         All interactions logged to database for analytics and debugging

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

### Conversational Chat
```
You:   Tell me a joke!
Manvi: Why do programmers prefer dark mode? Because light attracts bugs!
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

| Layer        | Technology                     |
|--------------|--------------------------------|
| Runtime      | Node.js + Express              |
| Messaging    | Meta Cloud API (WhatsApp)      |
| AI Engine    | Google Gemini API (Flash 2.5)  |
| Database     | Supabase (PostgreSQL)          |
| Scheduler    | node-cron (IST timezone-aware) |
| Hosting      | Render.com                     |

---

## 🗄 Database Schema

Manvi's brain runs on five Supabase tables. Run these in your Supabase SQL Editor:

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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## 🚀 Setup — Get Manvi Running

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

# Google AI Studio
GEMINI_API_KEY=your_gemini_api_key_here
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
│   ├── scheduler.js        # node-cron IST job runner
│   ├── supabase.js         # Database connection client
│   ├── sendMessage.js      # Meta WhatsApp API wrapper
│   └── gemini.js           # Natural language prompt engineering & parsing
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

Check your server's timezone. Manvi uses IST by default — if your server is in UTC, cron jobs will fire 5.5 hours early.

### Render instance sleeping

Free Render instances sleep after 15 minutes of inactivity. Set up a cron-job at [cron-job.org](https://cron-job.org) to ping your root URL every 10 minutes.

---

## 💛 Credits

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org)
[![Maintained by Onemark](https://img.shields.io/badge/Maintained%20by-Onemark-ff69b4)](https://onemark.digital)

Built with care by [Onemark](https://onemark.digital)  
Maintained by [Viswanath Bodasakurthi](https://github.com/viswabnath)

---

*Manvi means "Goddess of Knowledge" in Sanskrit — a fitting name for an AI second brain.*