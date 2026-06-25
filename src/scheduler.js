require("dotenv").config();
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");
const { ensureRowExists } = require("./usage");
const { refreshAccessTokenIfNeeded } = require("./metaToken");

function getISTComponents() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  const dowFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dowStr = dowFormatter.format(now).slice(0, 3);

  return {
    day: parseInt(day),
    month: parseInt(month),
    dayOfWeek: dowMap[dowStr],
    todayIST: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
    }).format(now),
    timeStr: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  };
}

// Guard flags — prevent overlapping executions
let reminderRunning = false;
let routineRunning = false;
let recurringRunning = false;
let eventAlertRunning = false;

// Heartbeat tracking (in-memory fallback for dashboard)
const lastHeartbeats = {
  "Reminder Dispatch": null,
  "Routine Dispatch": null,
  "Recurring Task Dispatch": null,
  "Event Alert": null,
};

async function recordHeartbeat(jobName) {
  const now = new Date().toISOString();
  lastHeartbeats[jobName] = now;
  try {
    await ensureRowExists();
    await supabase
      .from("system_jobs")
      .upsert({ job_name: jobName, last_fired: now, status: "active" }, { onConflict: "job_name" });
  } catch (_) {
    // in-memory fallback already set
  }
}

// -----------------------------------------------------------------------
// Template send — bypasses the WhatsApp 24-hour messaging window.
// Set REMINDER_TEMPLATE_NAME in env to the approved template name.
// Falls back to plain text if not configured (requires active 24h window).
// -----------------------------------------------------------------------
function scheduledSend(phone, message) {
  const templateName = process.env.REMINDER_TEMPLATE_NAME;
  return sendWhatsAppMessage(phone, message, templateName ? { templateName } : {});
}

// -----------------------------------------------------------------------
// Exported dispatch functions — called by both cron AND /api/tick
// -----------------------------------------------------------------------

async function runReminderDispatch() {
  if (reminderRunning) return;
  reminderRunning = true;

  try {
    const now = new Date().toISOString();

    const { data: dueReminders } = await supabase
      .from("personal_reminders")
      .select("*")
      .lte("reminder_time", now)
      .eq("status", "pending");

    for (const reminder of dueReminders || []) {
      // Atomic claim — skips row if already taken by a concurrent dispatcher
      const { data: claimed } = await supabase
        .from("personal_reminders")
        .update({ status: "completed" })
        .eq("id", reminder.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed?.length) continue;

      try {
        await scheduledSend(reminder.phone, reminder.message);
      } catch (err) {
        console.error(`[scheduler] reminder ${reminder.id} send failed:`, err?.response?.data || err.message);
        // Revert so it retries next cycle
        await supabase.from("personal_reminders").update({ status: "pending" }).eq("id", reminder.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    reminderRunning = false;
    await recordHeartbeat("Reminder Dispatch");
  }
}

async function runRoutineDispatch() {
  if (routineRunning) return;
  routineRunning = true;

  try {
    const { timeStr, todayIST } = getISTComponents();

    const { data: routines } = await supabase
      .from("daily_routines")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

    for (const routine of routines || []) {
      if (timeStr < routine.reminder_time.slice(0, 5)) continue;

      const { data: claimed } = await supabase
        .from("daily_routines")
        .update({ last_fired_date: todayIST })
        .eq("id", routine.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await scheduledSend(routine.phone, routine.task_name);
      } catch (err) {
        console.error(`[scheduler] routine ${routine.id} send failed:`, err?.response?.data || err.message);
        await supabase.from("daily_routines").update({ last_fired_date: null }).eq("id", routine.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    routineRunning = false;
    await recordHeartbeat("Routine Dispatch");
  }
}

async function runRecurringDispatch() {
  if (recurringRunning) return;
  recurringRunning = true;

  try {
    const { day, dayOfWeek, timeStr, todayIST } = getISTComponents();

    const { data: tasks } = await supabase
      .from("recurring_tasks")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

    for (const task of tasks || []) {
      if (timeStr < task.reminder_time.slice(0, 5)) continue;

      let shouldFire = false;
      if (task.recurrence_type === "weekly") {
        shouldFire = task.day_of_week === dayOfWeek;
      } else if (task.recurrence_type === "monthly") {
        const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const tomorrowIST = new Date(nowIST);
        tomorrowIST.setDate(tomorrowIST.getDate() + 1);
        const isLastDayOfMonth = tomorrowIST.getDate() === 1;
        shouldFire = (isLastDayOfMonth && task.day_of_month > day) || task.day_of_month === day;
      }

      if (!shouldFire) continue;

      const { data: claimed } = await supabase
        .from("recurring_tasks")
        .update({ last_fired_date: todayIST })
        .eq("id", task.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await scheduledSend(task.phone, task.task_name);
      } catch (err) {
        console.error(`[scheduler] recurring task ${task.id} send failed:`, err?.response?.data || err.message);
        await supabase.from("recurring_tasks").update({ last_fired_date: null }).eq("id", task.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    recurringRunning = false;
    await recordHeartbeat("Recurring Task Dispatch");
  }
}

// -----------------------------------------------------------------------
// Cron jobs — fire every minute.
// /api/tick calls the same functions when the process wakes from sleep.
// -----------------------------------------------------------------------

cron.schedule("* * * * *", runReminderDispatch);
cron.schedule("* * * * *", runRoutineDispatch);
cron.schedule("* * * * *", runRecurringDispatch);

// Special event alerts — 08:30 IST (03:00 UTC). Cron-only to avoid duplicates.
cron.schedule("0 3 * * *", async () => {
  if (eventAlertRunning) return;
  eventAlertRunning = true;
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
        await scheduledSend(event.phone, `${event.person_name}'s ${event.event_type} is today.`);
      } else if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await scheduledSend(event.phone, `${event.person_name}'s ${event.event_type} is tomorrow.`);
      }
    }
    // Also check and refresh the Meta access token if expiry is near
    await refreshAccessTokenIfNeeded();
  } catch (_) {
    // silent
  } finally {
    eventAlertRunning = false;
    await recordHeartbeat("Event Alert");
  }
});

module.exports = {
  getHeartbeats: () => lastHeartbeats,
  runReminderDispatch,
  runRoutineDispatch,
  runRecurringDispatch,
};
