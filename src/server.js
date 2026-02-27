const express = require("express");
require("dotenv").config();
const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");
const { analyzeMessage } = require("./gemini"); // 🧠 Injecting the AI Brain!
require("./scheduler"); // ⏰ Starts the Cron Job!

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// HEALTH CHECK (Keeps Render Awake)
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.status(200).send("Manvi is awake! 🧠");
});

// ---------------------------------------------------------
// HELPER: Convert AI "HH:MM:SS" to a Supabase IST Timestamp
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

  // Construct a strict ISO string mapped to IST (+05:30)
  const isoString = `${year}-${month}-${day}T${timeString}+05:30`;
  let reminderDate = new Date(isoString);

  // If the time has already passed today, schedule it for tomorrow
  if (reminderDate < now) {
    reminderDate.setDate(reminderDate.getDate() + 1);
  }
  return reminderDate.toISOString();
}

// ---------------------------------------------------------
// WEBHOOK VERIFICATION (Meta Setup)
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
// THE CORE ENGINE: Handling Incoming Messages
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  // 🚀 INSTANT RECEIPT: Tell Meta we got the message to prevent duplicate pings!
  res.sendStatus(200);

  const body = req.body;
  const messageData = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!messageData?.text?.body) return;

  const message = messageData.text.body;
  const senderPhone = messageData.from;
  const lowerMsg = message.toLowerCase().trim();

  // ---------------------------------------------------------
  // 1. CALLER ID: Identify who is texting Manvi
  // ---------------------------------------------------------
  let senderName = "Guest";
  let isOwner = false;

  if (senderPhone === process.env.MY_PHONE_NUMBER) {
    senderName = "Viswanath";
    isOwner = true;
  } else {
    // Look up the incoming phone number in your Supabase Address Book
    const { data: senderContact } = await supabase
      .from("contacts")
      .select("name")
      .eq("phone", senderPhone)
      .single();

    if (senderContact) {
      // Capitalize the first letter so 'manu' becomes 'Manu'
      senderName =
        senderContact.name.charAt(0).toUpperCase() +
        senderContact.name.slice(1);
    }
  }

  // ---------------------------------------------------------
  // 1.5 SECRET LOGGER: Save every interaction to the database
  // ---------------------------------------------------------
  await supabase
    .from("interaction_logs")
    .insert([
      { sender_name: senderName, sender_phone: senderPhone, message: message },
    ]);

  // ---------------------------------------------------------
  // 2. THE DYNAMIC GREETING (Bypass AI for simple Hellos)
  // ---------------------------------------------------------
  if (lowerMsg === "hi" || lowerMsg === "hello" || lowerMsg === "hey") {
    if (isOwner) {
      const ownerText = `Hi Viswanath! 👋 I'm Manvi. My AI brain is online! 🧠

            You can now talk to me naturally:
            📌 "Remind me at 4 PM to review Onemark Stories"
            🔄 "Set a daily routine to remind dad to take his medicine at 9 AM"
            🎉 "Manu's birthday is on Feb 9th 2026"
            ✉️ "Shoot a message to dad and tell him I will be 10 minutes late"`;

      return await sendWhatsAppMessage(senderPhone, ownerText);
    } else {
      const guestText = `Hi ${senderName}! 👋 I'm Manvi, Viswanath's personal AI assistant. 🧠
            
      I help him manage his Second Brain. If you want me to pass a message to him or save a reminder, just let me know!`;

      return await sendWhatsAppMessage(senderPhone, guestText);
    }
  }

  // ---------------------------------------------------------
  // 3. 🧠 WAKE UP THE AI: Let Gemini analyze the message
  // ---------------------------------------------------------
  const aiResult = await analyzeMessage(message);
  const { intent, targetName, time, date, taskOrMessage } = aiResult;

  // ---------------------------------------------------------
  // 4. ADDRESS BOOK: Find out WHO this message is targeting
  // ---------------------------------------------------------
  let targetPhone = process.env.MY_PHONE_NUMBER;
  let finalName = "you";

  if (targetName && targetName.toLowerCase() !== "you") {
    // .ilike() for case-insensitive searching in Supabase
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .ilike("name", targetName)
      .single();

    if (contact) {
      targetPhone = contact.phone;
      finalName = contact.name.charAt(0).toUpperCase() + contact.name.slice(1);
    } else {
      return await sendWhatsAppMessage(
        senderPhone,
        `I couldn't find "${targetName}" in the address book. Please check the spelling!`,
      );
    }
  }

  // ---------------------------------------------------------
  // 5. DYNAMIC ROUTING (Based on AI's understanding)
  // ---------------------------------------------------------
  try {
    if (intent === "chat") {
      // 💬 The Chatbot lives here!
      return await sendWhatsAppMessage(senderPhone, taskOrMessage);
    } else if (intent === "query_birthday") {
      // 🎂 Fetching a saved birthday
      const { data, error } = await supabase
        .from("special_events")
        .select("event_date")
        .ilike("person_name", finalName)
        .eq("event_type", "birthday")
        .single();

      if (data) {
        return await sendWhatsAppMessage(
          senderPhone,
          `🎂 ${finalName}'s birthday is saved as ${data.event_date}.`,
        );
      } else {
        return await sendWhatsAppMessage(
          senderPhone,
          `I checked my memory, but I don't have a birthday saved for ${finalName} yet.`,
        );
      }
    } else if (intent === "query_schedule") {
      // 📅 Fetching the daily schedule
      if (!date) {
        return await sendWhatsAppMessage(
          senderPhone,
          `Could you specify which day you want to check? (e.g., "What is my schedule for today?")`,
        );
      }

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

      if (!hasItems) {
        scheduleText = `Looks like a free day! I don't see any reminders or events scheduled for ${date}. 🌴`;
      }

      return await sendWhatsAppMessage(senderPhone, scheduleText);
    } else if (intent === "event") {
      const { error } = await supabase.from("special_events").insert([
        {
          phone: targetPhone,
          event_type: taskOrMessage,
          person_name: finalName,
          event_date: date,
        },
      ]);
      if (!error)
        await sendWhatsAppMessage(
          senderPhone,
          `🎉 Got it! I've saved ${finalName}'s ${taskOrMessage} for ${date}.`,
        );
    } else if (intent === "routine") {
      const { error } = await supabase
        .from("daily_routines")
        .insert([
          { phone: targetPhone, task_name: taskOrMessage, reminder_time: time },
        ]);
      if (!error)
        await sendWhatsAppMessage(
          senderPhone,
          `🔄 Routine set! I'll remind ${finalName} to "${taskOrMessage}" every day at ${time}.`,
        );
    } else if (intent === "instant_message") {
      if (finalName.toLowerCase() === "you") {
        await sendWhatsAppMessage(
          process.env.MY_PHONE_NUMBER,
          `📬 Forwarded from ${senderName}: ${taskOrMessage}`,
        );
        await sendWhatsAppMessage(
          senderPhone,
          `✅ I've passed your message to Viswanath!`,
        );
      } else {
        await sendWhatsAppMessage(
          targetPhone,
          `✨ Message from ${senderName}: ${taskOrMessage}`,
        );
        await sendWhatsAppMessage(
          senderPhone,
          `✅ Message successfully sent to ${finalName}!`,
        );
      }
    } else if (intent === "reminder") {
      if (!time) {
        return await sendWhatsAppMessage(
          senderPhone,
          `I understood you want a reminder, but I didn't catch the exact time. Could you specify it?`,
        );
      }
      const dbTimestamp = buildReminderDate(time);
      const { error } = await supabase.from("personal_reminders").insert([
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
        await sendWhatsAppMessage(
          senderPhone,
          `✅ Reminder set for ${finalName} at ${displayTime}.`,
        );
      }
    }
    // ---------------------------------------------------------
    // 🛡️ ADMIN-ONLY QUERIES (Protected by Caller ID)
    // ---------------------------------------------------------
    else if (
      [
        "query_routines",
        "query_contacts",
        "query_reminders",
        "query_events",
      ].includes(intent)
    ) {
      // THE SECURITY WALL: Kick out anyone who isn't Viswanath
      if (!isOwner) {
        return await sendWhatsAppMessage(
          senderPhone,
          `🔒 I'm sorry ${senderName}, but only Viswanath has clearance to access my global memory banks.`,
        );
      }

      // 1. Fetch Contacts
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
        return await sendWhatsAppMessage(senderPhone, text);
      }

      // 2. Fetch Active Reminders (Eliminates expired ones!)
      if (intent === "query_reminders") {
        const nowIso = new Date().toISOString();
        const { data } = await supabase
          .from("personal_reminders")
          .select("*")
          .gt("reminder_time", nowIso) // Only fetch times GREATER than right now
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
        return await sendWhatsAppMessage(senderPhone, text);
      }

      // 3. Fetch Daily Routines
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
        return await sendWhatsAppMessage(senderPhone, text);
      }

      // 4. Fetch All Special Events
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
        return await sendWhatsAppMessage(senderPhone, text);
      }
    } else {
      await sendWhatsAppMessage(
        senderPhone,
        `I'm sorry ${senderName}, my AI didn't quite understand that. Could you rephrase it? 🤖`,
      );
    }
  } catch (error) {
    console.error("Database Routing Error:", error);
    await sendWhatsAppMessage(
      senderPhone,
      `Oops, I ran into a database error trying to save that. 🚨`,
    );
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});
