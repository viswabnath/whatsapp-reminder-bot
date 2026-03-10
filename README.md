# Manvi

A personal AI assistant that works entirely inside WhatsApp. Set reminders, manage daily routines, save contacts, search the web, and forward messages — all by sending a text.

**Live:** [manvi.onrender.com](https://manvi.onrender.com)  
**Docs:** [manvi.onrender.com/documentation](https://manvi.onrender.com/documentation)

---

## Quick start

```bash
git clone https://github.com/viswanathbodasakurthi/manvi-whatsapp-assistant
cd manvi-whatsapp-assistant
npm install
cp .env.example .env   # fill in your keys
npm run dev
```

Full setup guide — including Meta webhook configuration, Supabase schema, and Render deployment — is at [manvi.onrender.com/documentation](https://manvi.onrender.com/documentation).

## What it does

| Feature | Example |
|---|---|
| One-off reminders | "Remind me to call the bank at 3 PM" |
| Daily routines | "Remind me to drink water every day at 10 AM" |
| Birthdays & events | "22nd May is Manu's birthday" |
| Save contacts | "Save Manu as 919876543210" |
| Message contacts | "Tell Manu I'll be 10 minutes late" |
| Web search | "Who won IPL 2024?" |
| Delete tasks | "Delete the drink water routine" |
| Conversational chat | "Explain machine learning simply" |

## Stack

- **Runtime:** Node.js + Express on Render (free tier)
- **Database:** Supabase (PostgreSQL)
- **Messaging:** Meta WhatsApp Cloud API
- **AI:** Gemini 3 Flash → Gemini 2.5 Flash → Groq Llama 3.3 → OpenRouter GPT-4o-mini
- **Search:** Tavily (primary) + Serper (fallback)
- **Timezone:** IST (Asia/Kolkata) throughout

## Environment variables

See `.env.example` for the full list. Requires keys for: Meta, Supabase, Gemini, Groq, OpenRouter, Tavily, Serper.

## Testing

```bash
node test.js
```

Runs the full v1.0 test suite against your Supabase instance. Inserts test data, verifies all features, cleans up after every run.

---

Built by [Viswanath Bodasakurthi](https://viswabnath.github.io/portfolio/) | [Onemark](https://onemark.co.in)