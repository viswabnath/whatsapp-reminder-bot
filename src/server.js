const express = require("express");
require("dotenv").config();
const { extractReminderTime, extractCleanMessage } = require("./parser");
const supabase = require("./supabase");

const app = express();
const sendWhatsAppMessage = require("./sendMessage");
app.use(express.json());

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
  const body = req.body;
  const messageData = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (messageData?.text?.body) {
    const message = messageData.text.body;
    const phone = messageData.from; // This is the sender's phone number
    const lowerMsg = message.toLowerCase();

    // ---------------------------------------------------------
    // THE ADDRESS BOOK: Find out WHO this message is for
    // ---------------------------------------------------------
    let targetPhone = process.env.MY_PHONE_NUMBER; // Defaults to YOU from .env
    let targetName = "you";

    const { data: contacts } = await supabase.from("contacts").select("*");
    
    if (contacts) {
      for (const contact of contacts) {
        if (lowerMsg.includes(contact.name.toLowerCase())) {
          targetPhone = contact.phone; // Swap to Mom/Dad/Manu's number!
          targetName = contact.name;
          break;
        }
      }
    }

    // ---------------------------------------------------------
    // ROUTE 1: SPECIAL EVENTS (Birthdays / Anniversaries)
    // ---------------------------------------------------------
    if (lowerMsg.startsWith("birthday:") || lowerMsg.startsWith("anniversary:")) {
      const parts = message.split(" ");
      const eventType = parts[0].replace(":", "").toLowerCase();
      const personName = parts[1];
      const eventDate = parts[2];

      const { error } = await supabase.from("special_events").insert([
        {
          phone: targetPhone,
          event_type: eventType,
          person_name: personName,
          event_date: eventDate,
        },
      ]);

      if (!error) {
        await sendWhatsAppMessage(
          phone, 
          `🎉 Got it! I've saved ${personName}'s ${eventType} in my memory.`
        );
      }
    }

    // ---------------------------------------------------------
    // ROUTE 2: DAILY ROUTINES
    // ---------------------------------------------------------
    else if (lowerMsg.startsWith("routine:")) {
      const timeMatch = message.match(/at (\d{2}:\d{2})/);
      const reminderTime = timeMatch ? timeMatch[1] : null;
      const taskName = message.replace(/routine:|at \d{2}:\d{2}/gi, "").trim();

      if (reminderTime && taskName) {
        const { error } = await supabase.from("daily_routines").insert([
          {
            phone: targetPhone,
            task_name: taskName,
            reminder_time: `${reminderTime}:00`,
          },
        ]);
        if (!error) {
          await sendWhatsAppMessage(
            phone,
            `🔄 Daily routine set! I'll remind ${targetName} to "${taskName}" every day at ${reminderTime}.`
          );
        }
      } else {
        await sendWhatsAppMessage(
          phone,
          `I didn't quite catch the time. Please use 24-hour format, like "Routine: Punch logout at 18:00"`
        );
      }
    }

    // ---------------------------------------------------------
    // ROUTE 4: INSTANT MESSAGES (The Dispatcher)
    // ---------------------------------------------------------
    else if (lowerMsg.startsWith("send message to ") || lowerMsg.startsWith("tell ")) {
      
      // If targetName is still "you", she didn't find the name in Supabase
      if (targetName === "you") {
        await sendWhatsAppMessage(phone, "I couldn't find that person in your address book. Make sure their name is spelled exactly as it is in the database.");
      } else {
        // Strip out the command words and the person's name to get the pure message
        let pureMessage = message
          .replace(/send message to/gi, "")
          .replace(/tell/gi, "")
          .replace(new RegExp(targetName, "gi"), "") // Removes the contact name
          .replace(/saying/gi, "") // Removes extra connecting words
          .trim();

        // Send the message instantly to the contact's number
        await sendWhatsAppMessage(targetPhone, `✨ Message from Viswanath: ${pureMessage}`);
        
        // Send a receipt back to YOU
        await sendWhatsAppMessage(phone, `✅ Message successfully sent to ${targetName}!`);
      }
    }

    // ---------------------------------------------------------
    // ROUTE 3: STANDARD ONE-OFF REMINDERS
    // ---------------------------------------------------------
    else {
      const reminderTime = extractReminderTime(message);

      if (reminderTime) {
        const cleanMsg = extractCleanMessage(message, targetName === "you" ? null : targetName);

        const { error } = await supabase.from("personal_reminders").insert([
          {
            phone: targetPhone, 
            message: cleanMsg,
            reminder_time: reminderTime,
            group_name: targetName === "you" ? null : targetName,
          },
        ]);

        if (!error) {
          const displayTime = reminderTime.toLocaleTimeString("en-US", {
            timeZone: "Asia/Kolkata",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          await sendWhatsAppMessage(
            phone,
            `✅ Reminder set for ${targetName} at ${displayTime}`
          );
        }
      } 
      
      // ---------------------------------------------------------
      // THE GREETING (When you say Hi/Hello)
      // ---------------------------------------------------------
      else if (lowerMsg === "hi" || lowerMsg === "hello" || lowerMsg === "hey") {
        const welcomeText = `Hi Viswanath! 👋 I'm Manvi, your Second Brain. Here is how you can save things to my memory:

📌 *One-off Tasks:* Just tell me a time!
_Example: "Remind me at 4:00 PM to review Onemark Stories"_

🔄 *Daily Routines:* Start with "Routine:" and use 24-hour time.
_Example: "Routine: remind dad to take medicine at 18:00"_

🎉 *Special Events:* Start with "Birthday:" or "Anniversary:" followed by the name and YYYY-MM-DD date.
_Example: "Birthday: Manojna 2026-02-09"_

✉️ *Instant Message:* Forward a message to a contact right now!
_Example: "Tell manu I will be 10 minutes late"_`;

        await sendWhatsAppMessage(phone, welcomeText);
      }

      // ---------------------------------------------------------
      // THE TRUE ERROR FALLBACK (When she actually doesn't understand)
      // ---------------------------------------------------------
      else {
        const errorText = `I'm sorry Viswanath, I cannot perform that action or understand that text yet. 🤖

Please try again using one of my exact formats:
📌 *Time-based:* "Remind me at 4:00 PM..."
🔄 *Routine:* "Routine: punch logout at 18:00"
🎉 *Event:* "Birthday: Manojna 2026-02-09"
✉️ *Instant Message:* "Tell manu..."`;

        await sendWhatsAppMessage(phone, errorText);
      }
    }
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});