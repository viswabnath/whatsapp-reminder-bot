const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");
require("dotenv").config();

const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");
const { analyzeMessage } = require("./gemini");
const { searchWeb } = require("./search");
const { getUsage, ensureRowExists, LIMITS } = require("./usage");
const { version } = require("../package.json");
const { getHeartbeats, runReminderDispatch, runRoutineDispatch, runRecurringDispatch } = require("./scheduler");

// Prevent unhandled rejections/exceptions from crashing the process and killing cron jobs
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason);
});

const app = express();
// Capture raw body for Meta webhook signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.static("public"));

// ---------------------------------------------------------
// WEBHOOK SIGNATURE VERIFICATION
// Verifies X-Hub-Signature-256 sent by Meta on every webhook POST.
// Set WEBHOOK_APP_SECRET to your Meta App Secret (not the access token).
// If the env var is absent the check is skipped (dev/test convenience).
// ---------------------------------------------------------
function verifyWebhookSignature(req) {
  if (!process.env.WEBHOOK_APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.WEBHOOK_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ---------------------------------------------------------
// PER-USER RATE LIMITING
// Max 10 messages per user per minute (in-memory, resets on restart).
// Protects AI quota from accidental loops or abuse.
// ---------------------------------------------------------
const _rateLimitMap = new Map();

function isRateLimited(phone) {
  const now = Date.now();
  const entry = _rateLimitMap.get(phone);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(phone, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  if (entry.count >= 10) return true;
  entry.count++;
  return false;
}

// ---------------------------------------------------------
// PAGE ROUTES
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/documentation", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/documentation.html"));
});

app.get("/status", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/status.html"));
});

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

// Converts AI-extracted HH:MM:SS to a full IST-offset ISO timestamp
function buildReminderDate(timeString, dateString = null) {
  const now = new Date();

  if (dateString) {
    const reminderDate = new Date(`${dateString}T${timeString}+05:30`);
    return reminderDate.toISOString();
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;

  const isoString = `${year}-${month}-${day}T${timeString}+05:30`;
  const reminderDate = new Date(isoString);

  if (reminderDate < now) {
    reminderDate.setDate(reminderDate.getDate() + 1);
  }
  return reminderDate.toISOString();
}

// Formats HH:MM or HH:MM:SS to "9:00 AM"
function formatTimeDisplay(rawTime) {
  return new Date(`1970-01-01T${rawTime}`).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Sends WhatsApp message and writes to interaction_logs
async function replyAndLog(phone, name, incomingMsg, botReply) {
  await sendWhatsAppMessage(phone, botReply);
  await supabase.from("interaction_logs").insert([{
    sender_name: name,
    sender_phone: phone,
    message: incomingMsg,
    bot_response: botReply,
  }]);
}

// ---------------------------------------------------------
// HEALTH CHECK
// /api/ping — monitored by UptimeRobot every 5 min
// Returns 200 when healthy, 500 when Supabase is unreachable
// ---------------------------------------------------------
app.get("/api/ping", async (req, res) => {
  const start = performance.now();
  const { error } = await supabase.from("api_usage").select("usage_date").limit(1);
  const latency = Math.round(performance.now() - start);

  res.status(error ? 500 : 200).json({
    status: error ? "degraded" : "ok",
    latency_ms: latency,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------
// TICK — External cron trigger
// /api/tick?secret=... — called by cron-job.org every minute
//
// This is the primary reliability mechanism for hosted environments
// (e.g. Render) where the process may sleep between requests.
// Calling this endpoint runs all three dispatch jobs immediately,
// catching up on any reminders/routines missed during sleep.
//
// Set CRON_SECRET in your environment. Configure cron-job.org to GET:
//   https://your-app.onrender.com/api/tick?secret=YOUR_CRON_SECRET
// every 1 minute.
// ---------------------------------------------------------
app.get("/api/tick", async (req, res) => {
  const incoming = req.query.secret || req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || incoming !== process.env.CRON_SECRET) {
    return res.sendStatus(403);
  }

  // Run all dispatchers in parallel — guard flags prevent overlaps, allSettled ensures one failure
  // doesn't block the others
  await Promise.allSettled([
    runReminderDispatch(),
    runRoutineDispatch(),
    runRecurringDispatch(),
  ]);

  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------
// STATUS API
// /api/status — feeds the Manvi dashboard
// ---------------------------------------------------------
app.get("/api/status", async (req, res) => {
  try {
    const stats = await getUsage();

    const { data: routineFireData } = await supabase
      .from("daily_routines")
      .select("last_fired_date")
      .eq("is_active", true)
      .not("last_fired_date", "is", null)
      .order("last_fired_date", { ascending: false })
      .limit(1);

    const lastRoutineFired = routineFireData?.[0]?.last_fired_date || null;
    const uptimeSeconds = process.uptime();

    // Fetch rich job status from DB if table exists, otherwise use in-memory heartbeats
    const { data: dbJobs } = await supabase.from("system_jobs").select("*");
    const heartbeats = getHeartbeats();

    // Cron health: minute-level jobs must have fired within 10 minutes.
    // Skip check if process just started (< 10 min uptime) — first tick hasn't fired yet.
    const CRON_STALE_MS = 10 * 60 * 1000;
    const now = Date.now();
    const minuteJobNames = ["Reminder Dispatch", "Routine Dispatch", "Recurring Task Dispatch"];
    const cronHealthy = uptimeSeconds < 600
      ? true
      : minuteJobNames.every((name) => {
          const ts = dbJobs?.find(j => j.job_name === name)?.last_fired || heartbeats[name];
          return ts && (now - new Date(ts).getTime()) < CRON_STALE_MS;
        });

    const jobs = [
      {
        name: "Webhook Listener",
        schedule: "Event-Driven",
        description: "Inbound message processor and AI intent router",
        layman: "The 24/7 Receptionist: Instantly reads your message and hands it to the right department.",
        status: "active",
        lastFired: "Live"
      },
      {
        name: "Reminder & Interval Dispatch",
        schedule: "* * * * *",
        description: "Fires pending one-off and interval reminders past their scheduled time",
        layman: "The Watcher: Checks every minute for due reminders — one-off, future-dated, and repeating interval alerts.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Reminder Dispatch')?.last_fired || heartbeats['Reminder Dispatch']
      },
      {
        name: "Routine Dispatch",
        schedule: "* * * * *",
        description: "Matches current IST time against active daily routines",
        layman: "The Habits Manager: Ensures recurring daily habits never get missed.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Routine Dispatch')?.last_fired || heartbeats['Routine Dispatch']
      },
      {
        name: "Recurring Task Dispatch",
        schedule: "* * * * *",
        description: "Fires weekly and monthly recurring tasks on their scheduled day and time",
        layman: "The Calendar: Handles weekly and monthly recurring reminders like rent or trash day.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Recurring Task Dispatch')?.last_fired || heartbeats['Recurring Task Dispatch']
      },
      {
        name: "Event Alert",
        schedule: "30 8 * * *",
        description: "Double-lock birthday and event alerts at 08:30 IST",
        layman: "The Announcer: Wakes up once a day at 8:30 AM to alert you of any birthdays or anniversaries.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Event Alert')?.last_fired || heartbeats['Event Alert']
      },
    ];

    res.json({
      success: true,
      version,
      uptime: {
        days: Math.floor(uptimeSeconds / 86400),
        hours: Math.floor((uptimeSeconds % 86400) / 3600),
        minutes: Math.floor((uptimeSeconds % 3600) / 60),
        seconds: Math.floor(uptimeSeconds % 60),
      },
      limits: LIMITS,
      stats,
      jobs,
      cronHealthy,
    });
  } catch (err) {
    console.error("[status] Failed to fetch system status:", err);
    res.status(500).json({ success: false, error: "Failed to fetch system status" });
  }
});

// ---------------------------------------------------------
// WEBHOOK VERIFICATION
// ---------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------
// MAIN WEBHOOK — Inbound message processor
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  if (!verifyWebhookSignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  try {

  const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!messageData) return;

  // Graceful media/unsupported type handling
  if (!messageData?.text?.body) {
    const mediaTypes = ["audio", "image", "video", "document", "sticker"];
    const msgType = messageData.type;

    if (mediaTypes.includes(msgType)) {
      const senderPhone = messageData.from;
      const typeLabel = msgType === "audio" ? "voice notes" : `${msgType}s`;
      await sendWhatsAppMessage(
        senderPhone,
        `I can only read text messages right now. I cannot process ${typeLabel}. Please type your request.`
      );
    }
    // For unknown/unsupported types (reaction, location, etc.) — silently drop
    return;
  }

  const message = messageData.text.body;
  const senderPhone = messageData.from;
  const lowerMsg = message.toLowerCase().trim();

  // Rate limit: max 10 messages/minute per sender
  if (isRateLimited(senderPhone)) {
    console.warn(`[webhook] Rate limit hit for ${senderPhone}`);
    return;
  }

  // 1. CALLER ID
  let senderName = "Guest";
  let isOwner = false;

  if (senderPhone === process.env.MY_PHONE_NUMBER) {
    senderName = "Viswanath";
    isOwner = true;
  } else {
    const { data: contact } = await supabase
      .from("contacts")
      .select("name")
      .eq("phone", senderPhone)
      .single();
    if (contact) {
      senderName = contact.name.charAt(0).toUpperCase() + contact.name.slice(1);
    }
  }

  // 2. USAGE DASHBOARD
  if (lowerMsg === "/limit") {
    const u = await getUsage();
    const msg =
      `System Limits\n\n` +
      `AI Engines\n` +
      `Gemini: ${u.gemini} / ${LIMITS.gemini}\n` +
      `Groq: ${u.groq} / ${LIMITS.groq}\n` +
      `OpenRouter: ${u.openrouter} / ${LIMITS.openrouter}\n\n` +
      `Search Engines\n` +
      `Tavily (monthly): ${u.tavily} / ${LIMITS.tavily}\n` +
      `Serper (lifetime): ${u.serper} / ${LIMITS.serper}\n\n` +
      `Status: Operational`;
    return await replyAndLog(senderPhone, senderName, message, msg);
  }

  // 3. GREETING
  if (lowerMsg === "hi" || lowerMsg === "hello" || lowerMsg === "hey") {
    const text = isOwner
      ? `Hello Viswanath. Manvi online. You can set reminders, routines, events, search the web, or query your schedule.`
      : `Hello ${senderName}. I am Manvi, Viswanath's personal assistant.`;
    return await replyAndLog(senderPhone, senderName, message, text);
  }

  // 4. CONVERSATIONAL MEMORY — fetch last 4 turns for this sender
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

  // 5. AI INTENT ANALYSIS (with memory context)
  const aiResult = await analyzeMessage(message, false, history);
  const { intent, targetName, time, date, taskOrMessage, ai_meta } = aiResult;

  // respond() is the single exit point — appends ai_meta automatically
  const respond = async (responseText, overrideAiMeta) => {
    const meta = overrideAiMeta !== undefined ? overrideAiMeta : ai_meta;
    const finalText = meta ? `${responseText}\n\n${meta}` : responseText;
    return await replyAndLog(senderPhone, senderName, message, finalText);
  };

  // 6. ADDRESS BOOK
  const queryOnlyIntents = [
    "query_birthday", "query_schedule", "query_events",
    "query_reminders", "query_routines", "query_contacts",
    "save_contact",
  ];

  let targetPhone = process.env.MY_PHONE_NUMBER;
  let finalName = "you";

  if (targetName && targetName.toLowerCase() !== "you") {
    if (!queryOnlyIntents.includes(intent)) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("*")
        .ilike("name", targetName)
        .single();

      if (contact) {
        targetPhone = contact.phone;
        finalName = contact.name.charAt(0).toUpperCase() + contact.name.slice(1);
      } else {
        return await respond(`Contact "${targetName}" not found in address book.`);
      }
    } else {
      finalName = targetName.charAt(0).toUpperCase() + targetName.slice(1);
    }
  }

  // 7. INTENT ROUTING
  try {
    if (intent === "chat") {
      return await respond(taskOrMessage);
    }

    if (intent === "api_error") {
      return await respond(`AI unavailable: ${taskOrMessage}`);
    }

    if (intent === "web_search") {
      const searchResults = await searchWeb(taskOrMessage);
      if (!searchResults) return await respond("Search tools are currently unavailable.");

      const summaryPrompt =
        `Manvi assistant. Viswanath asked: "${message}". ` +
        `Results from ${searchResults.source}: ${searchResults.data}. ` +
        `Provide a concise, accurate response.`;

      const summaryResult = await analyzeMessage(summaryPrompt, true);
      return await respond(
        `Search Results (${searchResults.source})\n\n${summaryResult.text}`,
        summaryResult.ai_meta
      );
    }

    if (intent === "delete_task") {
      if (!isOwner) return await respond("Access denied.");

      const cleanTask = taskOrMessage.replace(/(routine|reminder|task|event)/gi, "").trim();

      // Search all four tables in parallel, then delete the first match (priority order)
      const [
        { data: remMatches },
        { data: routMatches },
        { data: recurMatches },
        { data: eventMatches },
      ] = await Promise.all([
        supabase.from("personal_reminders").select("id, message").ilike("message", `%${cleanTask}%`).limit(1),
        supabase.from("daily_routines").select("id, task_name").ilike("task_name", `%${cleanTask}%`).limit(1),
        supabase.from("recurring_tasks").select("id, task_name").ilike("task_name", `%${cleanTask}%`).limit(1),
        supabase.from("special_events").select("id, person_name").ilike("person_name", `%${cleanTask}%`).limit(1),
      ]);

      if (remMatches?.length > 0) {
        await supabase.from("personal_reminders").delete().eq("id", remMatches[0].id);
        return await respond(`Deleted reminder: "${remMatches[0].message}"`);
      }
      if (routMatches?.length > 0) {
        await supabase.from("daily_routines").delete().eq("id", routMatches[0].id);
        return await respond(`Deleted routine: "${routMatches[0].task_name}"`);
      }
      if (recurMatches?.length > 0) {
        await supabase.from("recurring_tasks").delete().eq("id", recurMatches[0].id);
        return await respond(`Deleted recurring task: "${recurMatches[0].task_name}"`);
      }
      if (eventMatches?.length > 0) {
        await supabase.from("special_events").delete().eq("id", eventMatches[0].id);
        return await respond(`Deleted event for: "${eventMatches[0].person_name}"`);
      }

      return await respond(`No task matching "${cleanTask}" found.`);
    }

    // Feature 1: edit_task — modify the most recent matching reminder
    if (intent === "edit_task") {
      if (!isOwner) return await respond("Access denied.");

      const cleanTask = (aiResult.editTarget || taskOrMessage || "")
        .replace(/(routine|reminder|task|event)/gi, "")
        .trim();

      if (!cleanTask) return await respond("Could not identify which task to edit. Please be more specific.");
      if (!time) return await respond("Please specify the new time for the task.");

      // Find the most recent pending reminder matching the task name
      const { data: matches } = await supabase
        .from("personal_reminders")
        .select("*")
        .eq("phone", targetPhone)
        .eq("status", "pending")
        .ilike("message", `%${cleanTask}%`)
        .order("reminder_time", { ascending: true })
        .limit(1);

      if (!matches || matches.length === 0) {
        return await respond(`No pending reminder found matching "${cleanTask}".`);
      }

      const existing = matches[0];
      // Delete old row and insert updated one
      await supabase.from("personal_reminders").delete().eq("id", existing.id);

      const newTimestamp = buildReminderDate(time, date || null);
      const { error: insertErr } = await supabase.from("personal_reminders").insert([{
        phone: targetPhone,
        message: existing.message,
        reminder_time: newTimestamp,
        group_name: existing.group_name,
        status: "pending",
      }]);

      return await respond(
        !insertErr
          ? `Updated "${existing.message}" to ${formatTimeDisplay(time)}.`
          : "Failed to update reminder. Please try again."
      );
    }

    if (intent === "save_contact") {
      if (!isOwner) return await respond("Access denied.");

      const name = taskOrMessage?.trim();
      const phone = aiResult.phone?.replace(/\D/g, "");

      if (!name) return await respond("Please provide a name for the contact.");
      if (!phone || phone.length < 10) return await respond("Please provide a valid phone number with country code.");

      const { error } = await supabase
        .from("contacts")
        .upsert([{ name, phone }], { onConflict: "name" });

      return await respond(
        !error
          ? `Contact saved: ${name} — ${phone}`
          : "Failed to save contact. Please try again."
      );
    }

    if (["query_routines", "query_contacts", "query_reminders", "query_events"].includes(intent)) {
      if (!isOwner) return await respond("Access denied. These records are private.");

      if (intent === "query_contacts") {
        const { data } = await supabase.from("contacts").select("name").order("name");
        if (!data || data.length === 0) return await respond("No contacts saved.");
        let text = "Address Book:\n\n";
        data.forEach((c) => (text += `- ${c.name.charAt(0).toUpperCase() + c.name.slice(1)}\n`));
        return await respond(text);
      }

      if (intent === "query_reminders") {
        const nowIso = new Date().toISOString();
        const { data } = await supabase
          .from("personal_reminders")
          .select("*")
          .eq("phone", targetPhone)
          .gt("reminder_time", nowIso)
          .order("reminder_time");
        if (!data || data.length === 0) return await respond("No upcoming reminders.");

        const oneOff = data.filter((r) => r.group_name !== "interval");
        const interval = data.filter((r) => r.group_name === "interval");

        let text = "";

        if (oneOff.length > 0) {
          text += "One-off Reminders:\n\n";
          oneOff.forEach((r) => {
            const t = new Date(r.reminder_time).toLocaleString("en-US", {
              timeZone: "Asia/Kolkata", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit", hour12: true,
            });
            text += `- [${t}] ${r.group_name ? r.group_name + ": " : ""}${r.message}\n`;
          });
        }

        if (interval.length > 0) {
          text += `\nInterval Reminders (${interval.length} pending):\n\n`;
          const grouped = {};
          interval.forEach((r) => {
            if (!grouped[r.message]) grouped[r.message] = [];
            grouped[r.message].push(r.reminder_time);
          });
          Object.entries(grouped).forEach(([msg, times]) => {
            const next = new Date(times[0]).toLocaleString("en-US", {
              timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
            });
            text += `- "${msg}" — ${times.length} alerts remaining, next at ${next}\n`;
          });
        }

        return await respond(text.trim());
      }

      if (intent === "query_routines") {
        const { data: dailyData } = await supabase
          .from("daily_routines")
          .select("*")
          .eq("phone", targetPhone)
          .eq("is_active", true);

        const { data: recurData } = await supabase
          .from("recurring_tasks")
          .select("*")
          .eq("phone", targetPhone)
          .eq("is_active", true);

        const hasDailyData = dailyData && dailyData.length > 0;
        const hasRecurData = recurData && recurData.length > 0;

        if (!hasDailyData && !hasRecurData) return await respond("No active routines or recurring tasks.");

        let text = "";

        if (hasDailyData) {
          text += "Daily Routines:\n\n";
          dailyData.forEach((r) => (text += `- ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`));
        }

        if (hasRecurData) {
          text += "\nRecurring Tasks:\n\n";
          const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
          recurData.forEach((r) => {
            if (r.recurrence_type === "weekly") {
              text += `- Every ${DAY_NAMES[r.day_of_week]} at ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`;
            } else {
              text += `- Every month on the ${r.day_of_month} at ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`;
            }
          });
        }

        return await respond(text.trim());
      }

      if (intent === "query_events") {
        const { data } = await supabase.from("special_events").select("*").order("event_date");
        if (!data || data.length === 0) return await respond("No special events saved.");
        let text = "Special Events:\n\n";
        data.forEach((e) => (text += `- ${e.event_date}: ${e.person_name} — ${e.event_type}\n`));
        return await respond(text);
      }
    }

    if (intent === "query_birthday") {
      const { data } = await supabase
        .from("special_events")
        .select("event_date")
        .ilike("person_name", finalName)
        .eq("event_type", "birthday")
        .single();
      return await respond(
        data
          ? `${finalName}'s birthday: ${data.event_date}`
          : `No birthday saved for ${finalName}.`
      );
    }

    if (intent === "query_schedule") {
      if (!date) return await respond("Please specify a date.");

      const { data: events } = await supabase
        .from("special_events")
        .select("*")
        .eq("event_date", date);
      const { data: reminders } = await supabase
        .from("personal_reminders")
        .select("*")
        .like("reminder_time", `${date}%`);

      const hasItems = (events?.length > 0) || (reminders?.length > 0);
      if (!hasItems) return await respond(`No events or reminders found for ${date}.`);

      let text = `Schedule — ${date}\n\n`;
      if (events?.length > 0) {
        text += `Events:\n`;
        events.forEach((e) => (text += `- ${e.person_name} — ${e.event_type}\n`));
      }
      if (reminders?.length > 0) {
        text += `\nReminders:\n`;
        reminders.forEach((r) => {
          const t = new Date(r.reminder_time).toLocaleTimeString("en-US", {
            timeZone: "Asia/Kolkata",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          text += `- ${t}: ${r.message}\n`;
        });
      }
      return await respond(text);
    }

    if (intent === "event") {
      const eventPersonName = finalName.toLowerCase() === "you" ? "Viswanath" : finalName;
      const { error } = await supabase.from("special_events").insert([{
        phone: targetPhone,
        event_type: taskOrMessage,
        person_name: eventPersonName,
        event_date: date,
      }]);
      return await respond(
        !error
          ? `Saved ${eventPersonName}'s ${taskOrMessage} on ${date}.`
          : "Failed to save event. Please try again."
      );
    }

    if (intent === "routine") {
      const { error } = await supabase.from("daily_routines").insert([{
        phone: targetPhone,
        task_name: taskOrMessage,
        reminder_time: time,
      }]);
      return await respond(
        !error
          ? `Routine set — ${taskOrMessage} daily at ${formatTimeDisplay(time)}.`
          : "Failed to save routine. Please try again."
      );
    }

    // Feature 3: weekly_reminder and monthly_reminder intents
    if (intent === "weekly_reminder") {
      const dayOfWeek = parseInt(aiResult.dayOfWeek);
      if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return await respond("Could not determine the day of the week. Please try again.");
      }
      if (!time) return await respond("Please specify a time for the weekly reminder.");

      const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const { error } = await supabase.from("recurring_tasks").insert([{
        phone: targetPhone,
        task_name: taskOrMessage,
        reminder_time: time,
        recurrence_type: "weekly",
        day_of_week: dayOfWeek,
        day_of_month: null,
        is_active: true,
      }]);
      return await respond(
        !error
          ? `Weekly reminder set — "${taskOrMessage}" every ${DAY_NAMES[dayOfWeek]} at ${formatTimeDisplay(time)}.`
          : "Failed to save weekly reminder. Please try again."
      );
    }

    if (intent === "monthly_reminder") {
      const dayOfMonth = parseInt(aiResult.dayOfMonth);
      if (isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        return await respond("Could not determine the day of the month. Please try again.");
      }
      if (!time) return await respond("Please specify a time for the monthly reminder.");

      const { error } = await supabase.from("recurring_tasks").insert([{
        phone: targetPhone,
        task_name: taskOrMessage,
        reminder_time: time,
        recurrence_type: "monthly",
        day_of_week: null,
        day_of_month: dayOfMonth,
        is_active: true,
      }]);
      return await respond(
        !error
          ? `Monthly reminder set — "${taskOrMessage}" on the ${dayOfMonth} of every month at ${formatTimeDisplay(time)}.`
          : "Failed to save monthly reminder. Please try again."
      );
    }

    if (intent === "instant_message") {
      if (finalName.toLowerCase() === "you") {
        await sendWhatsAppMessage(
          process.env.MY_PHONE_NUMBER,
          `Message from ${senderName}: ${taskOrMessage}`
        );
        return await respond("Message forwarded.");
      } else {
        await sendWhatsAppMessage(targetPhone, `Message from ${senderName}: ${taskOrMessage}`);
        return await respond(`Message sent to ${finalName}.`);
      }
    }

    if (intent === "reminder") {
      if (!time) return await respond("Please specify a time for the reminder.");
      if (!taskOrMessage || taskOrMessage.trim() === "") return await respond("Please specify what the reminder is for.");
      const dbTimestamp = buildReminderDate(time, date || null);
      const { error } = await supabase.from("personal_reminders").insert([{
        phone: targetPhone,
        message: taskOrMessage,
        reminder_time: dbTimestamp,
        group_name: finalName.toLowerCase() === "you" ? null : finalName,
      }]);
      return await respond(
        !error
          ? `Reminder set for ${formatTimeDisplay(time)}.`
          : "Failed to save reminder. Please try again."
      );
    }

    if (intent === "interval_reminder") {
      const intervalMins = parseInt(aiResult.intervalMinutes);
      const durationHrs = parseInt(aiResult.durationHours) || 8;
      const task = taskOrMessage || "reminder";

      if (!intervalMins || intervalMins < 1) {
        return await respond("Please specify how often — e.g. every 30 minutes.");
      }
      if (intervalMins < 5) {
        return await respond("Minimum interval is 5 minutes.");
      }

      const now = new Date();
      const endTime = new Date(now.getTime() + durationHrs * 60 * 60 * 1000);
      const rows = [];

      let next = new Date(now.getTime() + intervalMins * 60 * 1000);
      while (next <= endTime) {
        rows.push({
          phone: targetPhone,
          message: task,
          reminder_time: next.toISOString(),
          group_name: "interval",
        });
        next = new Date(next.getTime() + intervalMins * 60 * 1000);
      }

      if (rows.length === 0) {
        return await respond("No reminders could be scheduled in that window.");
      }

      const { error } = await supabase.from("personal_reminders").insert(rows);
      return await respond(
        !error
          ? `Every ${intervalMins} min reminder set for "${task}" — ${rows.length} alerts over the next ${durationHrs} hours.`
          : "Failed to save interval reminder. Please try again."
      );
    }

    await respond("Request not understood. Please rephrase.");
  } catch (err) {
    console.error("[webhook] Routing error:", err);
    await respond("Internal error. Please try again.");
  }

  } catch (err) {
    console.error("[webhook] Unhandled error:", err);
  }
});

app.listen(process.env.PORT || 3000, async () => {
  console.log(`[server] Manvi v${version} running on port ${process.env.PORT || 3000}`);

  if (!process.env.WEBHOOK_APP_SECRET) {
    console.warn("[security] WARNING: WEBHOOK_APP_SECRET not set. Webhook signature verification is disabled.");
  }

  // Eagerly create today's api_usage row so the status dashboard never marks
  // today as "down" just because no messages have been sent yet.
  await ensureRowExists();

  // Self-Ping Keep-Alive (secondary — primary reliability is cron-job.org calling /api/tick)
  // Pings /api/tick every 4 minutes so the process stays awake AND runs dispatch jobs.
  // Note: if the process is already suspended, this interval won't fire — that's why
  // the external cron service (cron-job.org) is the primary mechanism.
  const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); // strip trailing slash
  const CRON_SECRET = process.env.CRON_SECRET;
  if (PUBLIC_URL && CRON_SECRET) {
    console.log(`[keep-alive] Self-pinging /api/tick every 4 min for ${PUBLIC_URL}`);
    const axios = require("axios");
    setInterval(async () => {
      try {
        await axios.get(`${PUBLIC_URL}/api/tick?secret=${CRON_SECRET}`);
      } catch (err) {
        console.warn(`[keep-alive] Self-ping warning: ${err.message}`);
      }
    }, 4 * 60 * 1000); // Every 4 minutes
  } else {
    console.warn("[keep-alive] WARNING: PUBLIC_URL or CRON_SECRET not set. Configure an external cron to call /api/tick every minute.");
  }
});
