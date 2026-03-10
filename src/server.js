const express = require("express");
const { performance } = require("perf_hooks");
require("dotenv").config();

const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");
const { analyzeMessage } = require("./gemini");
const { searchWeb } = require("./search");
const { getUsage, LIMITS } = require("./usage");
const { version } = require("../package.json");
require("./scheduler");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ---------------------------------------------------------
// PAGE ROUTES
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile("public/index.html", { root: "." });
});

app.get("/documentation", (req, res) => {
  res.sendFile("public/documentation.html", { root: "." });
});

app.get("/status", (req, res) => {
  res.sendFile("public/status.html", { root: "." });
});

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

// Converts AI-extracted HH:MM:SS to a full IST-offset ISO timestamp
function buildReminderDate(timeString, dateString = null) {
  const now = new Date();

  // If a specific date was extracted by AI, use it directly
  if (dateString) {
    const reminderDate = new Date(`${dateString}T${timeString}+05:30`);
    return reminderDate.toISOString();
  }

  // Otherwise default to today IST, rolling to tomorrow if time has passed
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

// Formats HH:MM or HH:MM:SS to "9:00 AM" — handles both AI output and Postgres TIME values
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
// /api/ping — used by cron-job.org to keep Render instance awake
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
// STATUS API
// /api/status — feeds the Manvi OS dashboard
// ---------------------------------------------------------
app.get("/api/status", async (req, res) => {
  try {
    const stats = await getUsage();
    const uptimeSeconds = process.uptime();

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
      jobs: [
        {
          name: "Webhook Listener",
          schedule: "Event-Driven",
          description: "Inbound message processor and AI intent router",
          status: "active",
        },
        {
          name: "Reminder Dispatch",
          schedule: "* * * * *",
          description: "Fires pending one-off reminders past their scheduled time",
          status: "scheduled",
        },
        {
          name: "Routine Dispatch",
          schedule: "* * * * *",
          description: "Matches current IST time against active daily routines",
          status: "scheduled",
        },
        {
          name: "Event Alert",
          schedule: "30 8 * * *",
          description: "Double-lock birthday and event alerts at 08:30 IST",
          status: "scheduled",
        },
      ],
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
  res.sendStatus(200);

  const messageData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!messageData?.text?.body) return;

  const message = messageData.text.body;
  const senderPhone = messageData.from;
  const lowerMsg = message.toLowerCase().trim();

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

  // 4. AI INTENT ANALYSIS
  const aiResult = await analyzeMessage(message);
  const { intent, targetName, time, date, taskOrMessage, ai_meta } = aiResult;

  // respond() is the single exit point — appends ai_meta automatically
  // Pass overrideAiMeta when the summarising model differs from the intent model (e.g. web search)
  const respond = async (responseText, overrideAiMeta) => {
    const meta = overrideAiMeta !== undefined ? overrideAiMeta : ai_meta;
    const finalText = meta ? `${responseText}\n\n${meta}` : responseText;
    return await replyAndLog(senderPhone, senderName, message, finalText);
  };

  // 5. ADDRESS BOOK
  // Query-only intents do not need a phone number — bypass address book lookup
  const queryOnlyIntents = [
    "query_birthday", "query_schedule", "query_events",
    "query_reminders", "query_routines", "query_contacts",
    "save_contact", // does not need existing contact — creates one
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

  // 6. INTENT ROUTING
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

      // Strip trailing type hints the AI may include ("Drink Water Routine" → "Drink Water")
      const cleanTask = taskOrMessage.replace(/(routine|reminder|task|event)/gi, "").trim();

      const { data: remData } = await supabase
        .from("personal_reminders")
        .delete()
        .ilike("message", `%${cleanTask}%`)
        .select();
      if (remData?.length > 0)
        return await respond(`Deleted reminder: "${remData[0].message}"`);

      const { data: routData } = await supabase
        .from("daily_routines")
        .delete()
        .ilike("task_name", `%${cleanTask}%`)
        .select();
      if (routData?.length > 0)
        return await respond(`Deleted routine: "${routData[0].task_name}"`);

      const { data: eventData } = await supabase
        .from("special_events")
        .delete()
        .ilike("person_name", `%${cleanTask}%`)
        .select();
      if (eventData?.length > 0)
        return await respond(`Deleted event for: "${eventData[0].person_name}"`);

      return await respond(`No task matching "${cleanTask}" found.`);
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
          .gt("reminder_time", nowIso)
          .order("reminder_time");
        if (!data || data.length === 0) return await respond("No upcoming reminders.");
        let text = "Upcoming Reminders:\n\n";
        data.forEach((r) => {
          const t = new Date(r.reminder_time).toLocaleString("en-US", {
            timeZone: "Asia/Kolkata",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          text += `- [${t}] ${r.group_name ? r.group_name + ": " : ""}${r.message}\n`;
        });
        return await respond(text);
      }

      if (intent === "query_routines") {
        const { data } = await supabase
          .from("daily_routines")
          .select("*")
          .eq("is_active", true);
        if (!data || data.length === 0) return await respond("No active routines.");
        let text = "Active Daily Routines:\n\n";
        data.forEach((r) => (text += `- ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`));
        return await respond(text);
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
      // When owner says "my birthday", finalName is "you" — store as actual name
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

    await respond("Request not understood. Please rephrase.");
  } catch (err) {
    console.error("[webhook] Routing error:", err);
    await respond("Internal error. Please try again.");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`[server] Manvi v${version} running on port ${process.env.PORT || 3000}`);
});