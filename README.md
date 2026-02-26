# 🧠 Manvi — Your Second Brain

> *A personal WhatsApp assistant that remembers so you don't have to.*

Built by [Onemark](https://onemark.digital) · Designed for people who think in messages, not apps.

---

## 💡 Why Manvi Exists

Most reminder apps force you to leave WhatsApp, open another app, navigate menus, set times, and save. By the time you're done, you've forgotten why you opened it.

**Manvi lives where you already are** — inside WhatsApp. You type like you're texting a friend:

\`\`\`
"Remind me at 4 PM to review Onemark Stories"
\`\`\`

Done. Manvi parses the message, stores it securely in PostgreSQL, and pings you exactly at 4 PM. No app switching. No friction.

---

## ✨ What Manvi Does

\`\`\`text
🔔  One-Off Reminders      "Remind me at 3 PM to call user"
                          Natural language → instant scheduling

🔄  Daily Routines         "Routine: remind dad to take medicine at 09:00"
                          Set it once, runs every day forever

🎂  Yearly Events          "Birthday: user 2026-02-09"
                          Never miss a birthday or anniversary again

✉️  Instant Dispatch       "Tell user I will be 10 minutes late"
                          Forwards messages instantly via the bot

📇  Secure Address Book    "Remind mom at 7 PM…"
                          Contacts stored in Supabase, never in code

⏰  IST-Native Cron        Runs on Indian Standard Time, no timezone bugs

☁️  Cloud-Native           Deployed on Render, runs 24/7, never forgets
\`\`\`

---

## 🎯 How to Talk to Manvi

### One-Off Tasks — Just mention a time
\`\`\`text
You:   Remind me at 4:00 PM to review Onemark Stories
Manvi: ✅ Reminder set for you at 4:00 PM
\`\`\`

### Daily Routines — Start with "Routine:"
\`\`\`text
You:   Routine: remind dad to take his medicine at 09:00
Manvi: 🔄 Daily routine set! I'll remind dad to "take his medicine" every day at 09:00.
\`\`\`

### Special Events — Start with "Birthday:" or "Anniversary:"
\`\`\`text
You:   Birthday: Manojna 2026-02-09
Manvi: 🎉 Got it! I've saved Manojna's birthday in my memory.
\`\`\`

### Instant Messages — Start with "Tell" or "Send message to"
\`\`\`text
You:   Tell user I am heading home now
Manvi: ✅ Message successfully sent to user!
(user receives: ✨ Message from Viswanath: I am heading home now)
\`\`\`

---

## 🏗 Tech Stack

| Layer        | Technology                     |
|--------------|--------------------------------|
| Runtime      | Node.js + Express              |
| Messaging    | Meta Cloud API (WhatsApp)      |
| Database     | Supabase (PostgreSQL)          |
| Scheduler    | node-cron (IST timezone-aware) |
| Hosting      | Render.com                     |

---

## 🗄 Database Schema

Manvi's brain runs on four Supabase tables. Run these in your Supabase SQL Editor:

\`\`\`sql
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
\`\`\`

---

## 🚀 Setup — Get Manvi Running

### 1 · Clone the repo

\`\`\`bash
git clone https://github.com/viswabnath/whatsapp-reminder-bot.git
cd whatsapp-reminder-bot
npm install
\`\`\`

### 2 · Configure secrets

Create a `.env` file — **never commit this**:

\`\`\`env
PORT=3000
VERIFY_TOKEN=your_custom_verify_token_here
MY_PHONE_NUMBER=your_whatsapp_number_with_country_code

# Meta Cloud API
PHONE_NUMBER_ID=your_meta_phone_number_id
ACCESS_TOKEN=your_meta_access_token_here

# Supabase
SUPABASE_URL=https://[your-project-id].supabase.co
SUPABASE_KEY=your_supabase_secret_key
\`\`\`

### 3 · Run locally

\`\`\`bash
node src/server.js
\`\`\`

Manvi will be live at `http://localhost:3000`

---

## 🔐 Understanding Meta Tokens

Meta requires two different tokens — they do completely different things.

### `VERIFY_TOKEN` — Webhook Verification
When you set up the webhook in Meta's Developer Dashboard, Meta pings your server with a challenge to verify you own it. You invent a random string, put it in `.env` as `VERIFY_TOKEN`, and paste the exact same string into the Meta Dashboard.

### `ACCESS_TOKEN` — Sending Messages
This token authorizes Manvi to send WhatsApp messages via the Meta Cloud API.

**⚠️ Important: The Expiry Rule**
- **For Development:** Meta gives you a Temporary Access Token that expires every 24 hours. If it expires, you'll see `AxiosError: 401 (Unauthorized)` in logs.
- **For Production:** Generate a 60-day token via the Graph API, or create a System User in Meta Business Settings and generate a Permanent Access Token.

---

## ☁️ Deploy to Render

### 1 · Create a new Web Service
Connect your GitHub repo to Render.

### 2 · Build & Start Commands
\`\`\`text
Build Command:  npm install
Start Command:  node src/server.js
\`\`\`

### 3 · Add Environment Variables
Copy all variables from your `.env` into Render's **Environment Variables** section.

### 4 · Configure Meta Webhook
Once deployed, take your Render URL, append `/webhook`, and paste it into the Meta App Dashboard. Example: `https://manvi-onemark.onrender.com/webhook`

---

## 📁 Project Structure

\`\`\`text
whatsapp-reminder-bot/
├── src/
│   ├── server.js           # Express server, webhook handler & routing
│   ├── scheduler.js        # node-cron IST job runner
│   ├── supabase.js         # Database connection client
│   ├── sendMessage.js      # Meta WhatsApp API wrapper
│   └── parser.js           # Natural language date/time extraction
├── .env                    # 🔒 Never commit — secrets only
├── .gitignore
├── package.json
└── README.md
\`\`\`

---

## 💛 Credits

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org)
[![Maintained by Onemark](https://img.shields.io/badge/Maintained%20by-Onemark-ff69b4)](https://onemark.digital)

**License:** MIT License (standard for open-source tools)

Built with care by [Onemark](https://onemark.digital)  
Maintained by [Viswanath Bodasakurthi](https://github.com/viswabnath)

---
*Manvi means "Goddess of Knowledge" in Sanskrit — a fitting name for your second brain.*