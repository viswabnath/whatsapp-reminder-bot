const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = "Asia/Kolkata";

function extractReminderTime(text) {
  const match = text.match(/(\d{1,2})[:.](\d{2})\s?(AM|PM)/i);
  if (!match) return null;

  let hour = parseInt(match[1]);
  let minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();

  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;

  const meetingTime = dayjs()
    .tz(IST)
    .hour(hour)
    .minute(minutes)
    .second(0)
    .millisecond(0);

  const reminderTime = meetingTime.subtract(1, "minute");

  return reminderTime.toDate();
}

function extractCleanMessage(text, groupName) {
  let cleaned = text;

  // 1. Erase "remind" or "remind me"
  cleaned = cleaned.replace(/remind\s*(me)?/i, '');

  // 2. Erase the group name (if one was targeted)
  if (groupName) {
    const groupRegex = new RegExp(`\\b${groupName}\\b`, 'i');
    cleaned = cleaned.replace(groupRegex, '');
  }

  // 3. Erase the time (e.g., "at 3:55 PM" or just "3:55 PM")
  const timeRegex = /(at\s+)?\d{1,2}[:.]\d{2}\s?(AM|PM)/i;
  cleaned = cleaned.replace(timeRegex, '');

  // 4. Erase leftover grammar words at the very start (like "to" or "that")
  cleaned = cleaned.replace(/^(to|that|about|for)\s+/i, '');

  // 5. Clean up any awkward double spaces left behind
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || "You have a scheduled reminder!";
}

module.exports = { extractReminderTime, extractCleanMessage };
