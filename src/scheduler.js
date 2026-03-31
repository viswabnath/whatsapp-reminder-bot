require("dotenv").config();
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");
const { ensureRowExists } = require("./usage");

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

// Guard flags — prevent overlapping cron executions
let reminderRunning = false;
let routineRunning = false;
let recurringRunning = false;

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
    // Ensure daily usage row exists (uptime visualization)
    await ensureRowExists();

    const { error } = await supabase
      .from("system_jobs")
      .upsert({ job_name: jobName, last_fired: now, status: "active" }, { onConflict: "job_name" });
    
    if (error && error.code !== 'PGRST116') {
      // Silently fail if table doesn't exist, fallback is already in lastHeartbeats
    }
  } catch (e) {
    // Silently fail
  }
}

// CRON 1: One-off reminder dispatch — runs every minute
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
    await recordHeartbeat("Reminder Dispatch");
  }
});

// CRON 2: Daily routine dispatch — runs every minute
// Fires if scheduled time has passed today AND not yet fired today (last_fired_date guard)
cron.schedule("* * * * *", async () => {
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
    await recordHeartbeat("Routine Dispatch");
  }
});

// CRON 3: Special event alerts — runs at 08:30 IST (03:00 UTC)
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
  } finally {
    await recordHeartbeat("Event Alert");
  }
});

// CRON 4: Recurring tasks dispatch — runs every minute
//
// Handles weekly and monthly recurring tasks from the recurring_tasks table.
//
// Weekly logic:
//   Fire if today's IST dayOfWeek matches task.day_of_week
//   AND current IST time >= task.reminder_time
//   AND not yet fired today (last_fired_date guard)
//
// Monthly logic:
//   Fire if today's IST day-of-month matches task.day_of_month
//   AND current IST time >= task.reminder_time
//   AND not yet fired today (last_fired_date guard)
//
// Schema required:
//   CREATE TABLE recurring_tasks (
//     id          BIGSERIAL PRIMARY KEY,
//     phone       TEXT NOT NULL,
//     task_name   TEXT NOT NULL,
//     reminder_time TIME NOT NULL,         -- HH:MM — same as daily_routines
//     recurrence_type TEXT NOT NULL,       -- 'weekly' | 'monthly'
//     day_of_week  INTEGER,               -- 0=Sun … 6=Sat, NULL for monthly
//     day_of_month INTEGER,               -- 1-31, NULL for weekly
//     is_active   BOOLEAN DEFAULT TRUE,
//     last_fired_date DATE,               -- prevents double-fire on same day
//     created_at  TIMESTAMPTZ DEFAULT NOW()
//   );
cron.schedule("* * * * *", async () => {
  if (recurringRunning) return;
  recurringRunning = true;

  try {
    const { day, dayOfWeek, timeStr, todayIST } = getISTComponents();

    // Fetch all active recurring tasks not yet fired today
    const { data: tasks } = await supabase
      .from("recurring_tasks")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

    if (!tasks || tasks.length === 0) return;

    for (const task of tasks) {
      const taskHHMM = task.reminder_time.slice(0, 5);

      // Time gate — don't fire before scheduled time
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
        await sendWhatsAppMessage(task.phone, `Reminder: ${task.task_name}`);
        await supabase
          .from("recurring_tasks")
          .update({ last_fired_date: todayIST })
          .eq("id", task.id);
      }
    }
  } catch (err) {
    console.error("[scheduler] Recurring tasks cron error:", err.message);
  } finally {
    recurringRunning = false;
    await recordHeartbeat("Recurring Task Dispatch");
  }
});

module.exports = {
  getHeartbeats: () => lastHeartbeats
};