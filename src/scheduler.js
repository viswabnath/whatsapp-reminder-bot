require("dotenv").config();
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");
const { ensureRowExists } = require("./usage");

// WhatsApp Template name for automated outreach
// This bypasses the 24-hour interaction window limit.
const templateOptions = { templateName: "manvi_reminder" };

function getISTComponents() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  // dayOfWeek in IST — 0=Sunday, 1=Monday ... 6=Saturday
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

// Guard flags — prevent overlapping executions
let reminderRunning = false;
let routineRunning = false;
let recurringRunning = false;
let eventAlertRunning = false;

// Heartbeat tracking (In-memory fallback for dashboard)
const lastHeartbeats = {
  "Reminder Dispatch": null,
  "Routine Dispatch": null,
  "Recurring Task Dispatch": null,
  "Event Alert": null
};

async function recordHeartbeat(jobName) {
  const now = new Date().toISOString();
  lastHeartbeats[jobName] = now;

  try {
    await ensureRowExists();
    await supabase
      .from("system_jobs")
      .upsert({ job_name: jobName, last_fired: now, status: "active" }, { onConflict: "job_name" });
  } catch (e) {
    // Silently fail — in-memory fallback already set
  }
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

    if (dueReminders?.length > 0) {
      for (const reminder of dueReminders) {
        // Atomic claim — prevents duplicate sends if two dispatchers run concurrently
        const { data: claimed } = await supabase
          .from("personal_reminders")
          .update({ status: "completed" })
          .eq("id", reminder.id)
          .eq("status", "pending")
          .select("id");
        if (!claimed?.length) continue;
        await sendWhatsAppMessage(reminder.phone, reminder.message, templateOptions);
      }
    }
  } catch (err) {
    console.error("[scheduler] Reminder dispatch error:", err.message);
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

    if (!routines || routines.length === 0) return;

    for (const routine of routines) {
      const routineHHMM = routine.reminder_time.slice(0, 5);

      if (timeStr >= routineHHMM) {
        // Atomic claim — prevents duplicate sends if two dispatchers run concurrently
        const { data: claimed } = await supabase
          .from("daily_routines")
          .update({ last_fired_date: todayIST })
          .eq("id", routine.id)
          .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`)
          .select("id");
        if (!claimed?.length) continue;
        await sendWhatsAppMessage(routine.phone, routine.task_name, templateOptions);
      }
    }
  } catch (err) {
    console.error("[scheduler] Routine dispatch error:", err.message);
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

    if (!tasks || tasks.length === 0) return;

    for (const task of tasks) {
      const taskHHMM = task.reminder_time.slice(0, 5);

      if (timeStr < taskHHMM) continue;

      let shouldFire = false;

      if (task.recurrence_type === "weekly") {
        shouldFire = task.day_of_week === dayOfWeek;
      } else if (task.recurrence_type === "monthly") {
        const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const tomorrowIST = new Date(nowIST);
        tomorrowIST.setDate(tomorrowIST.getDate() + 1);
        const isLastDayOfMonth = tomorrowIST.getDate() === 1;

        if (isLastDayOfMonth && task.day_of_month > day) {
          shouldFire = true;
        } else {
          shouldFire = task.day_of_month === day;
        }
      }

      if (shouldFire) {
        // Atomic claim — prevents duplicate sends if two dispatchers run concurrently
        const { data: claimed } = await supabase
          .from("recurring_tasks")
          .update({ last_fired_date: todayIST })
          .eq("id", task.id)
          .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`)
          .select("id");
        if (!claimed?.length) continue;
        await sendWhatsAppMessage(task.phone, task.task_name, templateOptions);
      }
    }
  } catch (err) {
    console.error("[scheduler] Recurring dispatch error:", err.message);
  } finally {
    recurringRunning = false;
    await recordHeartbeat("Recurring Task Dispatch");
  }
}

// -----------------------------------------------------------------------
// Cron jobs — call the exported dispatch functions every minute.
// These run when the process is continuously awake (e.g. paid hosting).
// When the process sleeps, /api/tick (called by an external cron service)
// invokes the same functions to catch up on missed dispatches.
// -----------------------------------------------------------------------

cron.schedule("* * * * *", runReminderDispatch);
cron.schedule("* * * * *", runRoutineDispatch);
cron.schedule("* * * * *", runRecurringDispatch);

// CRON: Special event alerts — runs at 08:30 IST (03:00 UTC)
// Kept as cron-only because calling it every minute would duplicate birthday alerts.
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
        await sendWhatsAppMessage(
          event.phone,
          `${event.person_name}'s ${event.event_type} is today.`,
          templateOptions
        );
      }

      if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await sendWhatsAppMessage(
          event.phone,
          `${event.person_name}'s ${event.event_type} is tomorrow.`,
          templateOptions
        );
      }
    }
  } catch (err) {
    console.error("[scheduler] Events cron error:", err.message);
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
