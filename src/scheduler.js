require("dotenv").config();
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");

// Helper: Get Current IST Date Components
function getISTComponents() {
  const now = new Date();
  const options = {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  };
  const formatter = new Intl.DateTimeFormat("en-IN", options);
  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  return {
    day: parseInt(day),
    month: parseInt(month),
    timeStr: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  };
}

// ---------------------------------------------------------
// CRON 1: Standard One-Off Reminders (Every minute)
// ---------------------------------------------------------
cron.schedule("* * * * *", async () => {
  const now = new Date().toISOString();
  const { data: dueReminders } = await supabase
    .from("personal_reminders")
    .select("*")
    .lte("reminder_time", now)
    .eq("status", "pending");

  if (dueReminders?.length > 0) {
    for (const reminder of dueReminders) {
      await sendWhatsAppMessage(
        reminder.phone,
        `✨ *Reminder:* ${reminder.message}`,
      );
      await supabase
        .from("personal_reminders")
        .update({ status: "completed" })
        .eq("id", reminder.id);
    }
  }
});

// ---------------------------------------------------------
// CRON 2: Daily Routines (Fixed Formatting)
// ---------------------------------------------------------
cron.schedule("* * * * *", async () => {
  const { timeStr } = getISTComponents();

  const { data: routines } = await supabase
    .from("daily_routines")
    .select("*")
    .eq("is_active", true)
    .like("reminder_time", `${timeStr}%`);

  if (routines?.length > 0) {
    for (const routine of routines) {
      await sendWhatsAppMessage(
        routine.phone,
        `🔄 *Routine:* Time to ${routine.task_name}!`,
      );
    }
  }
});

// ---------------------------------------------------------
// CRON 3: Special Events (The Double-Alert System)
// Runs at 8:30 AM IST daily
// ---------------------------------------------------------
cron.schedule("30 8 * * *", async () => {
  const { day: todayDay, month: todayMonth } = getISTComponents();

  // Calculate Tomorrow
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowDay = tomorrowDate.getDate();
  const tomorrowMonth = tomorrowDate.getMonth() + 1;

  const { data: events } = await supabase.from("special_events").select("*");

  if (events) {
    for (const event of events) {
      const eDate = new Date(event.event_date);
      const eDay = eDate.getDate();
      const eMonth = eDate.getMonth() + 1;

      // 1. Check for TODAY (The Big Day)
      if (eDay === todayDay && eMonth === todayMonth) {
        await sendWhatsAppMessage(
          event.phone,
          `🥳 *TODAY IS THE DAY!*\nIt's ${event.person_name}'s ${event.event_type}! Time to send your best wishes! 🎈`,
        );
      }

      // 2. Check for TOMORROW (The 24h Warning)
      if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await sendWhatsAppMessage(
          event.phone,
          `⏳ *Advance Alert:* Tomorrow is ${event.person_name}'s ${event.event_type}!\n\nI'm letting you know now so you can prepare or plan something special. 🎁`,
        );
      }
    }
  }
});
