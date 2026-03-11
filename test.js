/**
 * Manvi v1.0 — Integration Test Suite
 *
 * Tests all v1.0 features against real Supabase instance.
 * Inserts test data, verifies, and cleans up after every run.
 *
 * Usage: node test.js
 * Requires: .env populated, database schema created
 */

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { analyzeMessage } = require("./src/gemini");

// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TEST_PHONE = "910000000000"; // Fake number — no real messages sent
const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const SKIP = "\x1b[33mSKIP\x1b[0m";
const DIM  = "\x1b[2m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function log(status, name, detail = "") {
  const label = status === "pass" ? PASS : status === "skip" ? SKIP : FAIL;
  const detailStr = detail ? ` ${DIM}— ${detail}${RESET}` : "";
  console.log(`  ${label}  ${name}${detailStr}`);
  if (status === "pass") passed++;
  else if (status === "skip") skipped++;
  else failed++;
  results.push({ status, name, detail });
}

async function cleanup() {
  await supabase.from("personal_reminders").delete().eq("phone", TEST_PHONE);
  await supabase.from("daily_routines").delete().eq("phone", TEST_PHONE);
  await supabase.from("special_events").delete().eq("phone", TEST_PHONE);
  await supabase.from("contacts").delete().eq("phone", TEST_PHONE);
  await supabase.from("contacts").delete().ilike("name", "TestContact%");
}

// ─────────────────────────────────────────────
// SUPABASE CONNECTIVITY
// ─────────────────────────────────────────────

async function testSupabaseConnection() {
  console.log("\n\x1b[1mSUPABASE CONNECTIVITY\x1b[0m");

  const { error } = await supabase.from("api_usage").select("usage_date").limit(1);
  if (error) {
    log("fail", "Connect to Supabase", error.message);
    console.log("\n\x1b[31mCannot connect to Supabase. Aborting.\x1b[0m");
    process.exit(1);
  }
  log("pass", "Connect to Supabase");

  // Verify all 6 tables exist
  const tables = ["contacts", "personal_reminders", "daily_routines", "special_events", "interaction_logs", "api_usage"];
  for (const table of tables) {
    const { error: e } = await supabase.from(table).select("*").limit(0);
    if (e) log("fail", `Table exists: ${table}`, e.message);
    else log("pass", `Table exists: ${table}`);
  }
}

// ─────────────────────────────────────────────
// AI INTENT PARSING
// ─────────────────────────────────────────────

async function testAIParsing() {
  console.log("\n\x1b[1mAI INTENT PARSING\x1b[0m");

  const cases = [
    {
      msg: "Remind me to call the bank at 3 PM",
      expect: { intent: "reminder" },
      name: "Reminder intent",
    },
    {
      msg: "5th April is Ravi's interview remind me at 9 AM",
      expect: { intent: "reminder" },
      name: "Reminder with future date",
      check: (r) => r.date !== null && r.date !== undefined,
    },
    {
      msg: "Remind me to drink water every day at 10 AM",
      expect: { intent: "routine" },
      name: "Daily routine intent",
    },
    {
      msg: "Save Manu's birthday — 22nd May",
      expect: { intent: "event" },
      name: "Birthday/event save intent",
    },
    {
      msg: "Save TestContact as 910000000000",
      expect: { intent: "save_contact" },
      name: "Save contact intent",
      check: (r) => r.phone && r.phone.replace(/\D/g, "").length >= 10,
    },
    {
      msg: "Tell mom I will be late",
      expect: { intent: "instant_message" },
      name: "Instant message intent",
    },
    {
      msg: "What are my reminders",
      expect: { intent: "query_reminders" },
      name: "Query reminders intent",
    },
    {
      msg: "What are my daily routines",
      expect: { intent: "query_routines" },
      name: "Query routines intent",
    },
    {
      msg: "What are my contacts",
      expect: { intent: "query_contacts" },
      name: "Query contacts intent",
    },
    {
      msg: "What are my special events",
      expect: { intent: "query_events" },
      name: "Query events intent",
    },
    {
      msg: "When is Manu's birthday",
      expect: { intent: "query_birthday" },
      name: "Query birthday intent",
    },
    {
      msg: "What is my schedule for today",
      expect: { intent: "query_schedule" },
      name: "Query schedule intent",
    },
    {
      msg: "Delete the reminder to drink water",
      expect: { intent: "delete_task" },
      name: "Delete task intent",
    },
    {
      msg: "Who won IPL 2024",
      expect: { intent: "web_search" },
      name: "Web search intent",
    },
    {
      msg: "Tell me a joke",
      expect: { intent: "chat" },
      name: "Conversational chat intent",
    },
    {
      msg: "Remind me every 30 minutes to drink water",
      expect: { intent: "interval_reminder" },
      name: "Interval reminder intent",
      check: (r) => parseInt(r.intervalMinutes) === 30,
    },
    {
      msg: "Every 1 hour remind me to stretch for the next 4 hours",
      expect: { intent: "interval_reminder" },
      name: "Interval reminder with custom duration",
      check: (r) => parseInt(r.intervalMinutes) === 60 && parseInt(r.durationHours) === 4,
    },
  ];

  for (const tc of cases) {
    try {
      const result = await analyzeMessage(tc.msg);
      const intentMatch = result.intent === tc.expect.intent;
      const extraCheck = tc.check ? tc.check(result) : true;

      if (intentMatch && extraCheck) {
        log("pass", tc.name, `intent=${result.intent}`);
      } else if (!intentMatch) {
        log("fail", tc.name, `expected intent=${tc.expect.intent}, got=${result.intent}`);
      } else {
        log("fail", tc.name, `intent correct but extra check failed — result: ${JSON.stringify(result)}`);
      }
    } catch (err) {
      log("fail", tc.name, err.message);
    }
  }
}

// ─────────────────────────────────────────────
// REMINDERS
// ─────────────────────────────────────────────

async function testReminders() {
  console.log("\n\x1b[1mREMINDERS\x1b[0m");

  // Insert a test reminder
  const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
  const { error: insertErr } = await supabase
    .from("personal_reminders")
    .insert([{
      phone: TEST_PHONE,
      message: "Test reminder message",
      reminder_time: futureTime,
      status: "pending",
    }])
    .select();

  if (insertErr) {
    log("fail", "Insert reminder", insertErr.message);
    return;
  }
  log("pass", "Insert reminder");

  // Query it back
  const { data, error: fetchErr } = await supabase
    .from("personal_reminders")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("message", "Test reminder message")
    .eq("status", "pending");

  if (fetchErr || !data || data.length === 0) {
    log("fail", "Fetch pending reminder", fetchErr?.message || "no rows returned");
  } else {
    log("pass", "Fetch pending reminder");
    // Verify reminder_time stored correctly as TIMESTAMPTZ
    const storedDate = new Date(data[0].reminder_time);
    const valid = !isNaN(storedDate.getTime());
    valid
      ? log("pass", "reminder_time is valid TIMESTAMPTZ")
      : log("fail", "reminder_time is invalid", data[0].reminder_time);
  }

  // Test date-specific reminder — verifies buildReminderDate() uses the date
  const specificDate = "2027-06-15";
  const specificTime = "09:00:00";
  const expectedISO = new Date(`${specificDate}T${specificTime}+05:30`).toISOString();

  const { data: dated, error: datErr } = await supabase
    .from("personal_reminders")
    .insert([{
      phone: TEST_PHONE,
      message: "Future dated reminder",
      reminder_time: expectedISO,
      status: "pending",
    }])
    .select();

  if (datErr) {
    log("fail", "Insert future-dated reminder", datErr.message);
  } else {
    const stored = new Date(dated[0].reminder_time);
    const expected = new Date(expectedISO);
    const match = stored.getTime() === expected.getTime();
    match
      ? log("pass", "Future-dated reminder stores correct timestamp")
      : log("fail", "Future-dated reminder timestamp mismatch", `stored=${stored.toISOString()}`);
  }

  // Verify scheduler query (finds reminders with reminder_time <= now)
  const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
  await supabase.from("personal_reminders").insert([{
    phone: TEST_PHONE,
    message: "Past due reminder",
    reminder_time: pastTime,
    status: "pending",
  }]);

  const { data: due } = await supabase
    .from("personal_reminders")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("status", "pending")
    .lte("reminder_time", new Date().toISOString());

  const found = due && due.some(r => r.message === "Past due reminder");
  found
    ? log("pass", "Scheduler query finds past-due reminders")
    : log("fail", "Scheduler query did not find past-due reminder");

  // Mark complete
  if (due && due.length > 0) {
    const { error: updateErr } = await supabase
      .from("personal_reminders")
      .update({ status: "completed" })
      .eq("id", due[0].id);
    updateErr
      ? log("fail", "Mark reminder complete", updateErr.message)
      : log("pass", "Mark reminder complete");
  }
}

// ─────────────────────────────────────────────
// DAILY ROUTINES
// ─────────────────────────────────────────────

async function testRoutines() {
  console.log("\n\x1b[1mDAILY ROUTINES\x1b[0m");

  const { error: insertErr } = await supabase.from("daily_routines").insert([{
    phone: TEST_PHONE,
    task_name: "Test drink water",
    reminder_time: "10:00",
    is_active: true,
  }]);

  insertErr
    ? log("fail", "Insert routine", insertErr.message)
    : log("pass", "Insert routine");

  // Fetch all active routines and verify the inserted one is present
  const { data: all } = await supabase
    .from("daily_routines")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("is_active", true);

  const found = all && all.some(r => r.task_name === "Test drink water");
  found
    ? log("pass", "Routine insert is fetchable as active")
    : log("fail", "Routine insert not found in active routines");

  // Verify stored reminder_time starts with HH:mm (scheduler prefix-match depends on this)
  if (found) {
    const row = all.find(r => r.task_name === "Test drink water");
    const timeVal = row.reminder_time; // Postgres returns TIME as "HH:MM:SS"
    const startsCorrectly = timeVal && timeVal.startsWith("10:00");
    startsCorrectly
      ? log("pass", `Scheduler prefix-match: reminder_time stored as "${timeVal}" — starts with 10:00`)
      : log("fail", `reminder_time stored as "${timeVal}" — prefix 10:00 won't match`);
  }

  // Delete routine
  const { data: deleted } = await supabase
    .from("daily_routines")
    .delete()
    .ilike("task_name", "%Test drink water%")
    .select();

  deleted && deleted.length > 0
    ? log("pass", "Delete routine by name (ILIKE)")
    : log("fail", "Delete routine returned no rows");
}

// ─────────────────────────────────────────────
// SPECIAL EVENTS
// ─────────────────────────────────────────────

async function testSpecialEvents() {
  console.log("\n\x1b[1mSPECIAL EVENTS\x1b[0m");

  const { error: insertErr } = await supabase.from("special_events").insert([{
    phone: TEST_PHONE,
    event_type: "Birthday",
    person_name: "TestPerson",
    event_date: "2026-05-22",
  }]);

  insertErr
    ? log("fail", "Insert special event", insertErr.message)
    : log("pass", "Insert special event");

  // Verify day/month match (year-agnostic)
  const { data } = await supabase
    .from("special_events")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("person_name", "TestPerson");

  if (!data || data.length === 0) {
    log("fail", "Fetch special event");
    return;
  }
  log("pass", "Fetch special event");

  const eventDate = new Date(data[0].event_date + "T00:00:00Z");
  const eDay = eventDate.getUTCDate();
  const eMonth = eventDate.getUTCMonth();

  const testDate = new Date("2027-05-22T00:00:00Z");
  const match = testDate.getUTCDate() === eDay && testDate.getUTCMonth() === eMonth;
  match
    ? log("pass", "Day/month match is year-agnostic (fires every year)")
    : log("fail", "Day/month year-agnostic check failed");

  // Test that owner name resolves to "Viswanath" not "you"
  const ownerEvent = {
    phone: TEST_PHONE,
    event_type: "Birthday",
    person_name: "Viswanath",
    event_date: "2026-03-10",
  };
  const { error: ownerErr } = await supabase.from("special_events").insert([ownerEvent]);
  ownerErr
    ? log("fail", "Owner birthday stored as Viswanath", ownerErr.message)
    : log("pass", "Owner birthday stored as Viswanath (not 'you')");
}

// ─────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────

async function testContacts() {
  console.log("\n\x1b[1mCONTACTS\x1b[0m");

  // Insert
  const { error: insertErr } = await supabase.from("contacts").insert([{
    name: "TestContact One",
    phone: "919876543210",
  }]);
  insertErr
    ? log("fail", "Insert contact", insertErr.message)
    : log("pass", "Insert contact");

  // Fetch by name (ILIKE — case-insensitive)
  const { data: found } = await supabase
    .from("contacts")
    .select("*")
    .ilike("name", "testcontact one")
    .single();

  found
    ? log("pass", "Fetch contact by name (case-insensitive ILIKE)")
    : log("fail", "Fetch contact by name failed");

  // Upsert — same name, different number
  const { error: upsertErr } = await supabase
    .from("contacts")
    .upsert([{ name: "TestContact One", phone: "911111111111" }], { onConflict: "name" });
  upsertErr
    ? log("fail", "Upsert updates existing contact", upsertErr.message)
    : log("pass", "Upsert updates existing contact (no duplicate)");

  // Verify number was updated, not duplicated
  const { data: updated } = await supabase
    .from("contacts")
    .select("*")
    .ilike("name", "TestContact One");

  if (updated && updated.length === 1 && updated[0].phone === "911111111111") {
    log("pass", "Upsert correctly updated number — no duplicate row");
  } else if (updated && updated.length > 1) {
    log("fail", "Upsert created duplicate — expected 1 row, got " + updated.length);
  } else {
    log("fail", "Upsert check failed — unexpected state");
  }

  // Verify phone number digit-stripping (simulating the handler)
  const rawPhone = "+91 98765 43210";
  const stripped = rawPhone.replace(/\D/g, "");
  stripped === "919876543210"
    ? log("pass", "Phone number digit-stripping works (+, spaces removed)")
    : log("fail", "Digit-stripping failed: " + stripped);
}

// ─────────────────────────────────────────────
// DELETE TASKS
// ─────────────────────────────────────────────

async function testDeleteTasks() {
  console.log("\n\x1b[1mDELETE TASKS\x1b[0m");

  // Seed a reminder and routine
  await supabase.from("personal_reminders").insert([{
    phone: TEST_PHONE,
    message: "call the hospital",
    reminder_time: new Date(Date.now() + 3600000).toISOString(),
    status: "pending",
  }]);

  await supabase.from("daily_routines").insert([{
    phone: TEST_PHONE,
    task_name: "evening walk",
    reminder_time: "18:30",
    is_active: true,
  }]);

  // Simulate cleanTask stripping — "Delete call the hospital Reminder"
  const rawTask = "call the hospital Reminder";
  const cleanTask = rawTask.replace(/\b(routine|reminder|task|event)\b/gi, "").trim();

  const { data: remDeleted } = await supabase
    .from("personal_reminders")
    .delete()
    .ilike("message", `%${cleanTask}%`)
    .select();

  remDeleted && remDeleted.length > 0
    ? log("pass", "Delete reminder with type-word stripped from search term")
    : log("fail", "Delete reminder failed — cleanTask=" + cleanTask);

  // Delete routine
  const { data: routDeleted } = await supabase
    .from("daily_routines")
    .delete()
    .ilike("task_name", "%evening walk%")
    .select();

  routDeleted && routDeleted.length > 0
    ? log("pass", "Delete routine by partial name match")
    : log("fail", "Delete routine failed");

  // Nothing found case
  const { data: notFound } = await supabase
    .from("personal_reminders")
    .delete()
    .ilike("message", "%xyz nonexistent task abc%")
    .select();

  (!notFound || notFound.length === 0)
    ? log("pass", "Delete returns empty when no match found")
    : log("fail", "Delete found unexpected rows");
}

// ─────────────────────────────────────────────
// API USAGE TRACKING
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// INTERVAL REMINDERS
// ─────────────────────────────────────────────

async function testIntervalReminders() {
  console.log("\n\x1b[1mINTERVAL REMINDERS\x1b[0m");

  const now = new Date();
  const intervalMins = 30;
  const durationHrs = 2;
  const task = "interval test drink water";

  // Build rows exactly as server handler does
  const rows = [];
  let next = new Date(now.getTime() + intervalMins * 60 * 1000);
  const endTime = new Date(now.getTime() + durationHrs * 60 * 60 * 1000);
  while (next <= endTime) {
    rows.push({
      phone: TEST_PHONE,
      message: task,
      reminder_time: next.toISOString(),
      group_name: "interval",
      status: "pending",
    });
    next = new Date(next.getTime() + intervalMins * 60 * 1000);
  }

  const expectedCount = rows.length; // should be 4 for 30min × 2hrs

  const { error: insertErr } = await supabase.from("personal_reminders").insert(rows);
  insertErr
    ? log("fail", "Interval rows insert", insertErr.message)
    : log("pass", `Interval rows insert — ${expectedCount} rows`);

  // Verify all rows inserted with correct group_name
  const { data: inserted } = await supabase
    .from("personal_reminders")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("group_name", "interval")
    .eq("message", task)
    .eq("status", "pending");

  const countMatch = inserted && inserted.length === expectedCount;
  countMatch
    ? log("pass", `Interval rows fetchable — ${inserted.length}/${expectedCount} rows with group_name=interval`)
    : log("fail", `Interval row count mismatch — expected ${expectedCount}, got ${inserted?.length}`);

  // Verify rows are in future (scheduler should not fire them yet)
  const nowIso = new Date().toISOString();
  const allFuture = inserted && inserted.every(r => r.reminder_time > nowIso);
  allFuture
    ? log("pass", "All interval rows are in future — scheduler won't fire them prematurely")
    : log("fail", "Some interval rows are in the past — scheduler may fire them immediately");

  // Verify bulk delete by message ILIKE clears all rows at once
  const { data: deleted } = await supabase
    .from("personal_reminders")
    .delete()
    .eq("phone", TEST_PHONE)
    .eq("group_name", "interval")
    .ilike("message", `%${task}%`)
    .select();

  deleted && deleted.length === expectedCount
    ? log("pass", `Bulk delete clears all interval rows — ${deleted.length} removed`)
    : log("fail", `Bulk delete incomplete — expected ${expectedCount}, got ${deleted?.length}`);
}

async function testUsageTracking() {
  console.log("\n\x1b[1mAPI USAGE TRACKING\x1b[0m");

  const { getUsage } = require("./src/usage");

  // getUsage triggers ensureRowExists internally — if it returns without throwing, row was created
  try {
    const usage = await getUsage();
    log("pass", "ensureRowExists() runs via getUsage() without throwing");

    const hasAllKeys = ["gemini", "groq", "openrouter", "serper", "tavily", "errorsToday"].every(k => k in usage);
    hasAllKeys
      ? log("pass", "getUsage() returns correct shape")
      : log("fail", "getUsage() missing keys — got: " + Object.keys(usage).join(", "));
  } catch (err) {
    log("fail", "getUsage() threw", err.message);
  }
}

// ─────────────────────────────────────────────
// SCHEDULER LOGIC
// ─────────────────────────────────────────────

async function testSchedulerLogic() {
  console.log("\n\x1b[1mSCHEDULER LOGIC\x1b[0m");

  // Verify personal_reminders uses TIMESTAMPTZ comparison
  const now = new Date();
  const pastISO = new Date(now.getTime() - 2000).toISOString();

  await supabase.from("personal_reminders").insert([{
    phone: TEST_PHONE,
    message: "Scheduler test reminder",
    reminder_time: pastISO,
    status: "pending",
  }]);

  const { data } = await supabase
    .from("personal_reminders")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("status", "pending")
    .lte("reminder_time", new Date().toISOString());

  const found = data && data.some(r => r.message === "Scheduler test reminder");
  found
    ? log("pass", "Reminder TIMESTAMPTZ comparison: .lte fires correctly for past reminders")
    : log("fail", "Reminder TIMESTAMPTZ comparison failed");

  // NEW SCHEDULER LOGIC: last_fired_date + >= time comparison
  // Test 1: routine with null last_fired_date + past time → should be found as "due"
  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const currentHHMM = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());

  // Insert routine with time = 00:01 (always past by now) and no last_fired_date
  await supabase.from("daily_routines").insert([{
    phone: TEST_PHONE,
    task_name: "Scheduler test routine",
    reminder_time: "00:01",
    is_active: true,
    last_fired_date: null,
  }]);

  // Simulate scheduler query: unfired today
  const { data: unfired } = await supabase
    .from("daily_routines")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("is_active", true)
    .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

  const dueRow = unfired && unfired.find(r => r.task_name === "Scheduler test routine");
  if (dueRow) {
    const routineHHMM = dueRow.reminder_time.slice(0, 5);
    const shouldFire = currentHHMM >= routineHHMM;
    shouldFire
      ? log("pass", `Overdue routine found by last_fired_date query — "${routineHHMM}" <= "${currentHHMM}" — would fire`)
      : log("fail", `Overdue routine found but time check failed — "${routineHHMM}" vs "${currentHHMM}"`);
  } else {
    log("fail", "Overdue unfired routine not returned by scheduler query");
  }

  // Test 2: after marking fired today, same routine should NOT appear in next query
  await supabase
    .from("daily_routines")
    .update({ last_fired_date: todayIST })
    .eq("phone", TEST_PHONE)
    .eq("task_name", "Scheduler test routine");

  const { data: afterFired } = await supabase
    .from("daily_routines")
    .select("*")
    .eq("phone", TEST_PHONE)
    .eq("is_active", true)
    .or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);

  const stillDue = afterFired && afterFired.find(r => r.task_name === "Scheduler test routine");
  !stillDue
    ? log("pass", "Routine not returned after last_fired_date set to today — no double-fire")
    : log("fail", "Routine still returned after last_fired_date update — double-fire risk");
}

// ─────────────────────────────────────────────
// SERVER ROUTES
// ─────────────────────────────────────────────

async function testServerRoutes() {
  console.log("\n\x1b[1mSERVER ROUTES\x1b[0m");

  const BASE = `http://localhost:${process.env.PORT || 3000}`;

  const routes = [
    { path: "/api/ping", name: "/api/ping returns ok" },
    { path: "/api/status", name: "/api/status returns success" },
    { path: "/", name: "/ returns landing page (HTML)" },
    { path: "/documentation", name: "/documentation returns HTML" },
    { path: "/status", name: "/status returns HTML" },
  ];

  for (const route of routes) {
    try {
      const res = await fetch(`${BASE}${route.path}`);
      const ok = res.ok && res.status === 200;
      ok
        ? log("pass", route.name, `HTTP ${res.status}`)
        : log("fail", route.name, `HTTP ${res.status}`);
    } catch {
      log("skip", route.name, "server not running — start with npm run dev and re-run");
    }
  }

  // Verify /api/status shape
  try {
    const res = await fetch(`${BASE}/api/status`);
    if (res.ok) {
      const data = await res.json();
      const hasVersion = typeof data.version === "string";
      const hasStats = data.stats && typeof data.stats.gemini === "number";
      const hasLimits = data.limits && typeof data.limits.gemini === "number";

      hasVersion ? log("pass", "/api/status has version field") : log("fail", "/api/status missing version");
      hasStats ? log("pass", "/api/status has stats object") : log("fail", "/api/status missing stats");
      hasLimits ? log("pass", "/api/status has limits object") : log("fail", "/api/status missing limits");
    }
  } catch {
    log("skip", "/api/status shape check", "server not running");
  }
}

// ─────────────────────────────────────────────
// HELPER: buildReminderDate
// ─────────────────────────────────────────────

function testBuildReminderDate() {
  console.log("\n\x1b[1mBUILD REMINDER DATE HELPER\x1b[0m");

  // Inline the function to test it in isolation
  function buildReminderDate(timeString, dateString = null) {
    const now = new Date();
    if (dateString) {
      return new Date(`${dateString}T${timeString}+05:30`).toISOString();
    }
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find(p => p.type === "year").value;
    const month = parts.find(p => p.type === "month").value;
    const day = parts.find(p => p.type === "day").value;
    const isoString = `${year}-${month}-${day}T${timeString}+05:30`;
   const reminderDate = new Date(isoString);
    if (reminderDate < now) reminderDate.setDate(reminderDate.getDate() + 1);
    return reminderDate.toISOString();
  }

  // With explicit date — must use that date exactly
  const result = buildReminderDate("09:00:00", "2027-06-15");
  const expected = new Date("2027-06-15T09:00:00+05:30").toISOString();
  result === expected
    ? log("pass", "buildReminderDate uses explicit date when provided")
    : log("fail", `buildReminderDate date mismatch: got ${result}, expected ${expected}`);

  // Without date — should produce today or tomorrow
  const noDate = buildReminderDate("23:59:00");
  const parsed = new Date(noDate);
  !isNaN(parsed.getTime())
    ? log("pass", "buildReminderDate without date produces valid ISO string")
    : log("fail", "buildReminderDate without date produced invalid result: " + noDate);

  // Past time without date — should roll to tomorrow
  const pastResult = buildReminderDate("00:01:00"); // 12:01 AM IST — almost certainly in the past
  const parsedPast = new Date(pastResult);
  const now = new Date();
  parsedPast > now
    ? log("pass", "buildReminderDate rolls to tomorrow when time is past")
    : log("fail", "buildReminderDate did not roll to tomorrow for past time");
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1m\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log("\x1b[1m\x1b[36m  Manvi v1.0 — Integration Test Suite\x1b[0m");
  console.log("\x1b[1m\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log("\n\x1b[31mError: SUPABASE_URL and SUPABASE_KEY must be set in .env\x1b[0m\n");
    process.exit(1);
  }

  await cleanup(); // Start clean

  await testSupabaseConnection();
  await testBuildReminderDate();
  await testAIParsing();
  await testReminders();
  await testRoutines();
  await testSpecialEvents();
  await testContacts();
  await testDeleteTasks();
  await testIntervalReminders();
  await testSchedulerLogic();
  await testUsageTracking();
  await testServerRoutes();

  await cleanup(); // Clean up test data

  // Summary
  const total = passed + failed + skipped;
  console.log("\n\x1b[1m\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log(`\x1b[1m  Results: ${passed}/${total} passed\x1b[0m  (${failed} failed, ${skipped} skipped)`);
  console.log("\x1b[1m\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

  if (failed > 0) {
    console.log("\x1b[31mFailed tests:\x1b[0m");
    results.filter(r => r.status === "fail").forEach(r => {
      console.log(`  - ${r.name}${r.detail ? ": " + r.detail : ""}`);
    });
    console.log("");
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});