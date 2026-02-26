require("dotenv").config(); // Important so process.env is available here too!
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase"); // Notice we removed groups.js completely!

// ---------------------------------------------------------
// CRON 1: Standard One-Off Reminders (Runs every minute)
// ---------------------------------------------------------
cron.schedule("* * * * *", async () => {
  const now = new Date().toISOString(); 

  const { data: dueReminders, error } = await supabase
    .from('personal_reminders')
    .select('*')
    .lte('reminder_time', now)
    .eq('status', 'pending');

  if (dueReminders && dueReminders.length > 0) {
    for (const reminder of dueReminders) {
      // Sends to whoever the target phone was set to
      await sendWhatsAppMessage(reminder.phone, `✨ Manvi says: ${reminder.message}`);
      await supabase.from('personal_reminders').update({ status: 'completed' }).eq('id', reminder.id);
    }
  }
});

// ---------------------------------------------------------
// CRON 2: Daily Routines (Runs every minute to check exact times)
// ---------------------------------------------------------
cron.schedule("* * * * *", async () => {
  const nowIST = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
  const currentTime = nowIST.split(' ')[0]; 
  const timePrefix = currentTime.substring(0, 5); 

  const { data: routines } = await supabase
    .from('daily_routines')
    .select('*')
    .eq('is_active', true)
    .like('reminder_time', `${timePrefix}%`); 

  if (routines && routines.length > 0) {
    for (const routine of routines) {
      await sendWhatsAppMessage(routine.phone, `🔄 Routine check: Time to ${routine.task_name}!`);
    }
  }
});

// ---------------------------------------------------------
// CRON 3: Special Events / Birthdays (Runs once daily at 8:00 AM IST)
// ---------------------------------------------------------
cron.schedule("0 8 * * *", async () => {
  const today = new Date();
  const month = today.getMonth() + 1; 
  const day = today.getDate();

  const { data: events } = await supabase
    .from('special_events')
    .select('*');

  if (events) {
    for (const event of events) {
      const eventDate = new Date(event.event_date);
      if (eventDate.getMonth() + 1 === month && eventDate.getDate() === day) {
        await sendWhatsAppMessage(
          event.phone, 
          `🎉 Hey! Just a heads up, today is ${event.person_name}'s ${event.event_type}!`
        );
      }
    }
  }
}, {
  timezone: "Asia/Kolkata"
});

module.exports = {};