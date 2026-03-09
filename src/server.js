const express = require("express");
require("dotenv").config();
const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");
const { analyzeMessage } = require("./gemini");
const { searchWeb } = require("./search");
const { getUsage, LIMITS } = require("./usage");
require("./scheduler"); // ⏰ Starts the Cron Job!

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// HELPER 1: Convert AI "HH:MM:SS" to a Supabase IST Timestamp
// ---------------------------------------------------------
function buildReminderDate(timeString) {
  const now = new Date();
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
  let reminderDate = new Date(isoString);

  if (reminderDate < now) {
    reminderDate.setDate(reminderDate.getDate() + 1);
  }
  return reminderDate.toISOString();
}

// ---------------------------------------------------------
// HELPER 2: Send WhatsApp Message AND Log to Database
// ---------------------------------------------------------
async function replyAndLog(phone, name, incomingMsg, botReply) {
  await sendWhatsAppMessage(phone, botReply);
  await supabase.from("interaction_logs").insert([
    {
      sender_name: name,
      sender_phone: phone,
      message: incomingMsg,
      bot_response: botReply,
    },
  ]);
}

app.get("/", (req, res) => res.status(200).send("Manvi is awake! 🧠"));

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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  const messageData = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!messageData?.text?.body) return;

  const message = messageData.text.body;
  const senderPhone = messageData.from;
  const lowerMsg = message.toLowerCase().trim();

  // ---------------------------------------------------------
  // 1. CALLER ID
  // ---------------------------------------------------------
  let senderName = "Guest";
  let isOwner = false;

  if (senderPhone === process.env.MY_PHONE_NUMBER) {
    senderName = "Viswanath";
    isOwner = true;
  } else {
    const { data: senderContact } = await supabase
      .from("contacts")
      .select("name")
      .eq("phone", senderPhone)
      .single();
    if (senderContact) {
      senderName =
        senderContact.name.charAt(0).toUpperCase() +
        senderContact.name.slice(1);
    }
  }

  // ---------------------------------------------------------
  // 2. STATUS DASHBOARD (/limit)
  // ---------------------------------------------------------
  if (lowerMsg === "/limit") {
    const u = await getUsage();
    const statusMsg = `📊 *Manvi System Limits*\n\n🧠 *AI BRAINS*\n• Gemini: ${u.gemini} / ${LIMITS.gemini}\n• OpenRouter: ${u.openrouter} / ${LIMITS.openrouter}\n\n🔍 *SEARCH ENGINES*\n• Tavily (Monthly): ${u.tavily} / ${LIMITS.tavily}\n• Serper (Lifetime): ${u.serper} / ${LIMITS.serper}\n\n*Status:* All systems operational ✅`;
    return await replyAndLog(senderPhone, senderName, message, statusMsg);
  }

  // ---------------------------------------------------------
  // 3. THE DYNAMIC GREETING
  // ---------------------------------------------------------
  if (lowerMsg === "hi" || lowerMsg === "hello" || lowerMsg === "hey") {
    if (isOwner) {
      const ownerText = `Hi Viswanath! 👋 I'm Manvi. My AI brain is online! 🧠\n\nYou can now talk to me naturally:\n📌 "Remind me at 4 PM..."\n🔄 "Set a daily routine..."\n🎉 "Manu's birthday is on..."\n🌐 "Who won the recent F1?"`;
      return await replyAndLog(senderPhone, senderName, message, ownerText);
    } else {
      const guestText = `Hi ${senderName}! 👋 I'm Manvi, Viswanath's personal AI assistant. 🧠`;
      return await replyAndLog(senderPhone, senderName, message, guestText);
    }
  }

  // ---------------------------------------------------------
  // 4. 🧠 WAKE UP THE AI
  // ---------------------------------------------------------
  const aiResult = await analyzeMessage(message);
  const { intent, targetName, time, date, taskOrMessage, ai_meta } = aiResult;

  const respond = async (responseText) => {
    const finalText = ai_meta
      ? `${responseText}\n\n_${ai_meta}_`
      : responseText;
    return await replyAndLog(senderPhone, senderName, message, finalText);
  };

  // ---------------------------------------------------------
  // 5. ADDRESS BOOK
  // ---------------------------------------------------------
  let targetPhone = process.env.MY_PHONE_NUMBER;
  let finalName = "you";

  if (targetName && targetName.toLowerCase() !== "you") {
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .ilike("name", targetName)
      .single();
    if (contact) {
      targetPhone = contact.phone;
      finalName = contact.name.charAt(0).toUpperCase() + contact.name.slice(1);
    } else {
      return await respond(
        `I couldn't find "${targetName}" in the address book. Please check the spelling!`,
      );
    }
  }

  // ---------------------------------------------------------
  // 6. DYNAMIC ROUTING
  // ---------------------------------------------------------
  try {
    if (intent === "chat") {
      return await respond(taskOrMessage);
    }

    if (intent === "api_error") {
      let readableError = taskOrMessage;
      const bracketMatch = readableError.match(/\](.*)/);
      if (bracketMatch && bracketMatch[1])
        readableError = bracketMatch[1].trim();
      return await respond(`⚠️ *Google AI Error:*\n${readableError}`);
    }

    // --- 🌐 WEB SEARCH ---
    else if (intent === "web_search") {
      await respond("🔍 Searching the web for you, one moment...");
      const searchResults = await searchWeb(taskOrMessage);

      if (!searchResults)
        return await respond(
          "I tried searching the web, but my search tools are currently offline. 😔",
        );

      const summaryPrompt = `
        You are Manvi. Viswanath asked: "${message}". 
        I found these search results from ${searchResults.source}:
        ${searchResults.data}
        
        Please provide a concise, friendly answer based ONLY on these results. 
        Mention facts clearly without complex markdown.
      `;

      const summaryText = await analyzeMessage(summaryPrompt, true);
      return await respond(
        `🌐 *Search Results (${searchResults.source})*\n\n${summaryText}`,
      );
    }

    // --- 🗑️ DELETE HANDLER ---
    else if (intent === "delete_task") {
      if (!isOwner)
        return await respond(`🔒 Only Viswanath can delete memories.`);

      const { data: remData } = await supabase
        .from("personal_reminders")
        .delete()
        .ilike("message", `%${taskOrMessage}%`)
        .select();
      if (remData && remData.length > 0)
        return await respond(
          `🗑️ Successfully deleted reminder: "${remData[0].message}"`,
        );

      const { data: routData } = await supabase
        .from("daily_routines")
        .delete()
        .ilike("task_name", `%${taskOrMessage}%`)
        .select();
      if (routData && routData.length > 0)
        return await respond(
          `🗑️ Successfully deleted routine: "${routData[0].task_name}"`,
        );

      const { data: eventData } = await supabase
        .from("special_events")
        .delete()
        .ilike("person_name", `%${taskOrMessage}%`)
        .select();
      if (eventData && eventData.length > 0)
        return await respond(
          `🗑️ Successfully deleted event for: "${eventData[0].person_name}"`,
        );

      return await respond(
        `I couldn't find anything matching "${taskOrMessage}" to delete. Try checking your active lists first!`,
      );
    }

    // --- ADMIN QUERIES ---
    else if (
      [
        "query_routines",
        "query_contacts",
        "query_reminders",
        "query_events",
      ].includes(intent)
    ) {
      if (!isOwner)
        return await respond(
          `🔒 I'm sorry ${senderName}, but only Viswanath has clearance to access my global memory banks.`,
        );

      if (intent === "query_contacts") {
        const { data } = await supabase
          .from("contacts")
          .select("name")
          .order("name");
        let text = "📇 *Saved Address Book:*\n\n";
        if (data && data.length > 0)
          data.forEach(
            (c) =>
              (text += `- ${c.name.charAt(0).toUpperCase() + c.name.slice(1)}\n`),
          );
        else text += "No contacts found.";
        return await respond(text);
      }

      if (intent === "query_reminders") {
        const nowIso = new Date().toISOString();
        const { data } = await supabase
          .from("personal_reminders")
          .select("*")
          .gt("reminder_time", nowIso)
          .order("reminder_time", { ascending: true });
        let text = "🔔 *Active Upcoming Reminders:*\n\n";
        if (data && data.length > 0) {
          data.forEach((r) => {
            const timeString = new Date(r.reminder_time).toLocaleString(
              "en-US",
              {
                timeZone: "Asia/Kolkata",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              },
            );
            text += `- [${timeString}] ${r.group_name ? r.group_name + ": " : ""}${r.message}\n`;
          });
        } else text += "No active reminders pending! 🌴";
        return await respond(text);
      }

      if (intent === "query_routines") {
        const { data } = await supabase
          .from("daily_routines")
          .select("*")
          .eq("is_active", true);
        let text = "🔄 *Active Daily Routines:*\n\n";
        if (data && data.length > 0)
          data.forEach(
            (r) =>
              (text += `- Every day at ${r.reminder_time}: ${r.task_name}\n`),
          );
        else text += "No active routines.";
        return await respond(text);
      }

      if (intent === "query_events") {
        const { data } = await supabase
          .from("special_events")
          .select("*")
          .order("event_date");
        let text = "🎉 *All Special Events:*\n\n";
        if (data && data.length > 0)
          data.forEach(
            (e) =>
              (text += `- ${e.event_date}: ${e.person_name}'s ${e.event_type}\n`),
          );
        else text += "No special events saved.";
        return await respond(text);
      }
    }

    // --- MEMORY RETRIEVAL ---
    else if (intent === "query_birthday") {
      const { data } = await supabase
        .from("special_events")
        .select("event_date")
        .ilike("person_name", finalName)
        .eq("event_type", "birthday")
        .single();
      if (data)
        return await respond(
          `🎂 ${finalName}'s birthday is saved as ${data.event_date}.`,
        );
      else
        return await respond(
          `I checked my memory, but I don't have a birthday saved for ${finalName} yet.`,
        );
    } else if (intent === "query_schedule") {
      if (!date)
        return await respond(
          `Could you specify which day you want to check? (e.g., "What is my schedule for today?")`,
        );
      const { data: events } = await supabase
        .from("special_events")
        .select("*")
        .eq("event_date", date);
      const { data: reminders } = await supabase
        .from("personal_reminders")
        .select("*")
        .like("reminder_time", `${date}%`);

      let scheduleText = `📅 *Your Schedule for ${date}:*\n\n`;
      let hasItems = false;
      if (events && events.length > 0) {
        scheduleText += `*Special Events:*\n`;
        events.forEach((e) => {
          scheduleText += `- ${e.person_name}'s ${e.event_type} 🎉\n`;
        });
        hasItems = true;
      }
      if (reminders && reminders.length > 0) {
        scheduleText += `\n*Reminders:*\n`;
        reminders.forEach((r) => {
          const timeString = new Date(r.reminder_time).toLocaleTimeString(
            "en-US",
            {
              timeZone: "Asia/Kolkata",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            },
          );
          scheduleText += `- ${timeString}: ${r.message}\n`;
        });
        hasItems = true;
      }
      if (!hasItems)
        scheduleText = `Looks like a free day! I don't see any reminders or events scheduled for ${date}. 🌴`;
      return await respond(scheduleText);
    }

    // --- WRITING DATA ---
    else if (intent === "event") {
      const { error } = await supabase
        .from("special_events")
        .insert([
          {
            phone: targetPhone,
            event_type: taskOrMessage,
            person_name: finalName,
            event_date: date,
          },
        ]);
      if (!error)
        await respond(
          `🎉 Got it! I've saved ${finalName}'s ${taskOrMessage} for ${date}.`,
        );
    } else if (intent === "routine") {
      const { error } = await supabase
        .from("daily_routines")
        .insert([
          { phone: targetPhone, task_name: taskOrMessage, reminder_time: time },
        ]);
      if (!error)
        await respond(
          `🔄 Routine set! I'll remind ${finalName} to "${taskOrMessage}" every day at ${time}.`,
        );
    } else if (intent === "instant_message") {
      if (finalName.toLowerCase() === "you") {
        await sendWhatsAppMessage(
          process.env.MY_PHONE_NUMBER,
          `📬 Forwarded from ${senderName}: ${taskOrMessage}`,
        );
        await respond(`✅ I've passed your message to Viswanath!`);
      } else {
        await sendWhatsAppMessage(
          targetPhone,
          `✨ Message from ${senderName}: ${taskOrMessage}`,
        );
        await respond(`✅ Message successfully sent to ${finalName}!`);
      }
    } else if (intent === "reminder") {
      if (!time)
        return await respond(
          `I understood you want a reminder, but I didn't catch the exact time. Could you specify it?`,
        );
      const dbTimestamp = buildReminderDate(time);
      const { error } = await supabase
        .from("personal_reminders")
        .insert([
          {
            phone: targetPhone,
            message: taskOrMessage,
            reminder_time: dbTimestamp,
            group_name: finalName.toLowerCase() === "you" ? null : finalName,
          },
        ]);
      if (!error) {
        const displayTime = new Date(dbTimestamp).toLocaleTimeString("en-US", {
          timeZone: "Asia/Kolkata",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        await respond(`✅ Reminder set for ${finalName} at ${displayTime}.`);
      }
    } else {
      await respond(
        `I'm sorry ${senderName}, my AI didn't quite understand that. Could you rephrase it? 🤖`,
      );
    }
  } catch (error) {
    console.error("Database Routing Error:", error);
    await respond(`Oops, I ran into a database error trying to save that. 🚨`);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});
