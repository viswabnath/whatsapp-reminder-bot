require("dotenv").config();
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");

function getISTComponents() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  return {
    day: parseInt(day),
    month: parseInt(month),
    // YYYY-MM-DD in IST — used as last_fired_date key
    todayIST: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
    }).format(now),
    // HH:mm in IST — used for time comparison
    timeStr: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  };
}

// Guard flags — prevent overlapping cron executions that cause node-cron WARN flood
let reminderRunning = false;
let routineRunning = false;

// CRON 1: One-off reminder dispatch — runs every minute
// Uses .lte so overdue reminders are never missed even if server restarts late
cron.schedule("* * * * *", async () => {
  if (reminderRunning) return;
  reminderRunning = true;

  try {
    const now = new Date().toISOString();

    const { data: dueReminders } = await supabase
      .from("personal_reminders")
      .select("*")
      .lte("reminder_time", now)
      .eq("status", "pending");

    if (dueReminders?.length > 0) {
      for (const reminder of dueReminders) {
        await sendWhatsAppMessage(reminder.phone, `Reminder: ${reminder.message}`);
        await supabase
          .from("personal_reminders")
          .update({ status: "completed" })
          .eq("id", reminder.id);
      }
    }
  } catch (err) {
    console.error("[scheduler] Reminder cron error:", err.message);
  } finally {
    reminderRunning = false;
  }
});

// CRON 2: Daily routine dispatch — runs every minute
//
// OLD APPROACH (broken): exact minute match via LIKE "09:00%"
//   — if server was sleeping at 9:00 AM, routine is silently missed for the day
//
// NEW APPROACH: fire if scheduled time has passed today AND not yet fired today
//   — uses last_fired_date column (DATE) to track per-day firing
//   — server restart at 10:30 AM will still fire a 9:00 AM routine
//   — requires: ALTER TABLE daily_routines ADD COLUMN last_fired_date DATE;
cron.schedule("* * * * *", async () => {
  if (routineRunning) return;
  routineRunning = true;

  try {
    const { timeStr, todayIST } = getISTComponents();

    // Fetch all active routines not yet fired today
    const { data: routines } = await supabase
      .from("daily_routines")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

    if (!routines || routines.length === 0) return;

    for (const routine of routines) {
      // routine.reminder_time is stored as HH:MM:SS by Postgres
      // Compare HH:MM prefix against current IST HH:mm
      const routineHHMM = routine.reminder_time.slice(0, 5); // "09:00"

      // Only fire if scheduled time has passed (or is now) — prevents early firing
      if (timeStr >= routineHHMM) {
        await sendWhatsAppMessage(routine.phone, `Daily Routine: ${routine.task_name}`);
        await supabase
          .from("daily_routines")
          .update({ last_fired_date: todayIST })
          .eq("id", routine.id);
      }
    }
  } catch (err) {
    console.error("[scheduler] Routine cron error:", err.message);
  } finally {
    routineRunning = false;
  }
});

// CRON 3: Special event alerts — runs at 08:30 IST (03:00 UTC)
// Runs once daily so no guard flag needed
cron.schedule("0 3 * * *", async () => {
  try {
    const { day: todayDay, month: todayMonth } = getISTComponents();

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDay = tomorrowDate.getDate();
    const tomorrowMonth = tomorrowDate.getMonth() + 1;

    const { data: events } = await supabase.from("special_events").select("*");

    if (!events) return;

    for (const event of events) {
      const eDate = new Date(event.event_date);
      const eDay = eDate.getDate();
      const eMonth = eDate.getMonth() + 1;

      if (eDay === todayDay && eMonth === todayMonth) {
        await sendWhatsAppMessage(
          event.phone,
          `Today is ${event.person_name}'s ${event.event_type}. Time to reach out.`
        );
      }

      if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await sendWhatsAppMessage(
          event.phone,
          `Advance notice: Tomorrow is ${event.person_name}'s ${event.event_type}. Plan ahead.`
        );
      }
    }
  } catch (err) {
    console.error("[scheduler] Events cron error:", err.message);
  }
});