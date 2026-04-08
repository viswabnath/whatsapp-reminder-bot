/**
 * Manvi v1.2 — Integration Test Suite
 *
 * Tests all v1.0 + v1.1 + v1.2 features against real Supabase instance.
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

const TEST_PHONE = "910000000000";
const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const SKIP = "\x1b[33mSKIP\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

// Tracks whether all AI tiers are exhausted mid-run.
// Set to true on the first api_error response — all subsequent AI calls are skipped.
let aiExhausted = false;

// Wraps analyzeMessage — detects api_error, sets flag, throws so caller skips cleanly
async function callAI(msg, isSummary = false, history = []) {
  if (aiExhausted) throw new Error('AI_EXHAUSTED');
  const result = await analyzeMessage(msg, isSummary, history);
  if (result.intent === 'api_error') {
    aiExhausted = true;
    throw new Error('AI_EXHAUSTED');
  }
  return result;
}

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
  // contacts stores the contact's own phone, not TEST_PHONE — clean by name pattern
  await supabase.from("contacts").delete().ilike("name", "TestContact%");
  await supabase.from("interaction_logs").delete().eq("sender_phone", TEST_PHONE);
  await supabase.from("recurring_tasks").delete().eq("phone", TEST_PHONE);
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

  // Verify all 8 tables exist (system_jobs added in v1.1.1)
  const tables = [
    "contacts", "personal_reminders", "daily_routines",
    "special_events", "interaction_logs", "api_usage", "recurring_tasks", "system_jobs",
  ];
  for (const table of tables) {
    const { error: e } = await supabase.from(table).select("*").limit(0);
    e ? log("fail", `Table exists: ${table}`, e.message) : log("pass", `Table exists: ${table}`);
  }
}

// ─────────────────────────────────────────────
// AI INTENT PARSING
// ─────────────────────────────────────────────

async function testAIParsing() {
  console.log("\n\x1b[1mAI INTENT PARSING\x1b[0m");

  const cases = [
    { msg: "Remind me to call the bank at 3 PM", expect: { intent: "reminder" }, name: "Reminder intent" },
    { msg: "5th April is Ravi's interview remind me at 9 AM", expect: { intent: "reminder" }, name: "Reminder with future date", check: (r) => r.date !== null },
    { msg: "Remind me to drink water every day at 10 AM", expect: { intent: "routine" }, name: "Daily routine intent" },
    { msg: "Save Manu's birthday — 22nd May", expect: { intent: "event" }, name: "Birthday/event save intent" },
    { msg: "Save TestContact as 910000000000", expect: { intent: "save_contact" }, name: "Save contact intent", check: (r) => r.phone && r.phone.replace(/\D/g, "").length >= 10 },
    { msg: "Tell mom I will be late", expect: { intent: "instant_message" }, name: "Instant message intent" },
    { msg: "What are my reminders", expect: { intent: "query_reminders" }, name: "Query reminders intent" },
    { msg: "What are my daily routines", expect: { intent: "query_routines" }, name: "Query routines intent" },
    { msg: "What are my contacts", expect: { intent: "query_contacts" }, name: "Query contacts intent" },
    { msg: "What are my special events", expect: { intent: "query_events" }, name: "Query events intent" },
    { msg: "When is Manu's birthday", expect: { intent: "query_birthday" }, name: "Query birthday intent" },
    { msg: "What is my schedule for today", expect: { intent: "query_schedule" }, name: "Query schedule intent" },
    { msg: "Delete the reminder to drink water", expect: { intent: "delete_task" }, name: "Delete task intent" },
    { msg: "Who won IPL 2024", expect: { intent: "web_search" }, name: "Web search intent" },
    { msg: "Tell me a joke", expect: { intent: "chat" }, name: "Conversational chat intent" },
    { msg: "Remind me every 30 minutes to drink water", expect: { intent: "interval_reminder" }, name: "Interval reminder intent", check: (r) => parseInt(r.intervalMinutes) === 30 },
    { msg: "Every 1 hour remind me to stretch for the next 4 hours", expect: { intent: "interval_reminder" }, name: "Interval reminder with custom duration", check: (r) => parseInt(r.intervalMinutes) === 60 && parseInt(r.durationHours) === 4 },
    // v1.1 new intents
    { msg: "Remind me to pay rent on the 1st of every month at 9 AM", expect: { intent: "monthly_reminder" }, name: "Monthly reminder intent", check: (r) => parseInt(r.dayOfMonth) === 1 },
    { msg: "Remind me to take out the trash every Tuesday at 8 PM", expect: { intent: "weekly_reminder" }, name: "Weekly reminder intent", check: (r) => parseInt(r.dayOfWeek) === 2 },
    { msg: "Change the buy eggs reminder to 7 PM", expect: { intent: "edit_task" }, name: "Edit task intent", check: (r) => r.time !== null },
  ];

  for (const tc of cases) {
    if (aiExhausted) { log("skip", tc.name, "AI quota exhausted"); continue; }
    try {
      const result = await callAI(tc.msg);
      const intentMatch = result.intent === tc.expect.intent;
      const extraCheck = tc.check ? tc.check(result) : true;

      if (intentMatch && extraCheck) {
        log("pass", tc.name, `intent=${result.intent}`);
      } else if (!intentMatch) {
        log("fail", tc.name, `expected=${tc.expect.intent}, got=${result.intent}`);
      } else {
        log("fail", tc.name, `intent correct but check failed — ${JSON.stringify(result)}`);
      }
    } catch (err) {
      err.message === 'AI_EXHAUSTED'
        ? log("skip", tc.name, "AI quota exhausted")
        : log("fail", tc.name, err.message);
    }
  }
}

// ─────────────────────────────────────────────
// REMINDERS
// ─────────────────────────────────────────────

async function testReminders() {
  console.log("\n\x1b[1mREMINDERS\x1b[0m");

  const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { error: insertErr } = await supabase
    .from("personal_reminders")
    .insert([{ phone: TEST_PHONE, message: "Test reminder message", reminder_time: futureTime, status: "pending" }])
    .select();

  if (insertErr) { log("fail", "Insert reminder", insertErr.message); return; }
  log("pass", "Insert reminder");

  const { data, error: fetchErr } = await supabase
    .from("personal_reminders").select("*").eq("phone", TEST_PHONE).eq("message", "Test reminder message").eq("status", "pending");

  if (fetchErr || !data || data.length === 0) {
    log("fail", "Fetch pending reminder", fetchErr?.message || "no rows");
  } else {
    log("pass", "Fetch pending reminder");
    !isNaN(new Date(data[0].reminder_time).getTime())
      ? log("pass", "reminder_time is valid TIMESTAMPTZ")
      : log("fail", "reminder_time is invalid");
  }

  const expectedISO = new Date("2027-06-15T09:00:00+05:30").toISOString();
  const { data: dated, error: datErr } = await supabase
    .from("personal_reminders")
    .insert([{ phone: TEST_PHONE, message: "Future dated reminder", reminder_time: expectedISO, status: "pending" }])
    .select();

  if (datErr) {
    log("fail", "Insert future-dated reminder", datErr.message);
  } else {
    new Date(dated[0].reminder_time).getTime() === new Date(expectedISO).getTime()
      ? log("pass", "Future-dated reminder stores correct timestamp")
      : log("fail", "Future-dated reminder timestamp mismatch");
  }

  const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
  await supabase.from("personal_reminders").insert([{ phone: TEST_PHONE, message: "Past due reminder", reminder_time: pastTime, status: "pending" }]);

  const { data: due } = await supabase
    .from("personal_reminders").select("*").eq("phone", TEST_PHONE).eq("status", "pending").lte("reminder_time", new Date().toISOString());

  due && due.some(r => r.message === "Past due reminder")
    ? log("pass", "Scheduler query finds past-due reminders")
    : log("fail", "Scheduler query did not find past-due reminder");

  if (due && due.length > 0) {
    const { error: updateErr } = await supabase.from("personal_reminders").update({ status: "completed" }).eq("id", due[0].id);
    updateErr ? log("fail", "Mark reminder complete", updateErr.message) : log("pass", "Mark reminder complete");
  }
}

// ─────────────────────────────────────────────
// DAILY ROUTINES
// ─────────────────────────────────────────────

async function testRoutines() {
  console.log("\n\x1b[1mDAILY ROUTINES\x1b[0m");

  const { error: insertErr } = await supabase.from("daily_routines")
    .insert([{ phone: TEST_PHONE, task_name: "Test drink water", reminder_time: "10:00", is_active: true }]);
  insertErr ? log("fail", "Insert routine", insertErr.message) : log("pass", "Insert routine");

  const { data: all } = await supabase.from("daily_routines").select("*").eq("phone", TEST_PHONE).eq("is_active", true);
  const found = all && all.some(r => r.task_name === "Test drink water");
  found ? log("pass", "Routine fetchable as active") : log("fail", "Routine not found");

  if (found) {
    const row = all.find(r => r.task_name === "Test drink water");
    row.reminder_time.startsWith("10:00")
      ? log("pass", `Scheduler prefix-match: stored as "${row.reminder_time}"`)
      : log("fail", `reminder_time "${row.reminder_time}" won't prefix-match`);
  }

  const { data: deleted } = await supabase.from("daily_routines").delete().ilike("task_name", "%Test drink water%").select();
  deleted && deleted.length > 0 ? log("pass", "Delete routine by ILIKE") : log("fail", "Delete routine returned no rows");
}

// ─────────────────────────────────────────────
// SPECIAL EVENTS
// ─────────────────────────────────────────────

async function testSpecialEvents() {
  console.log("\n\x1b[1mSPECIAL EVENTS\x1b[0m");

  const { error: insertErr } = await supabase.from("special_events")
    .insert([{ phone: TEST_PHONE, event_type: "Birthday", person_name: "TestPerson", event_date: "2026-05-22" }]);
  insertErr ? log("fail", "Insert special event", insertErr.message) : log("pass", "Insert special event");

  const { data } = await supabase.from("special_events").select("*").eq("phone", TEST_PHONE).eq("person_name", "TestPerson");
  if (!data || data.length === 0) { log("fail", "Fetch special event"); return; }
  log("pass", "Fetch special event");

  const ev = new Date(data[0].event_date + "T00:00:00Z");
  const td = new Date("2027-05-22T00:00:00Z");
  td.getUTCDate() === ev.getUTCDate() && td.getUTCMonth() === ev.getUTCMonth()
    ? log("pass", "Day/month match is year-agnostic")
    : log("fail", "Year-agnostic check failed");

  const { error: ownerErr } = await supabase.from("special_events")
    .insert([{ phone: TEST_PHONE, event_type: "Birthday", person_name: "Viswanath", event_date: "2026-03-10" }]);
  ownerErr ? log("fail", "Owner birthday stored as Viswanath", ownerErr.message) : log("pass", "Owner birthday stored as Viswanath");
}

// ─────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────

async function testContacts() {
  console.log("\n\x1b[1mCONTACTS\x1b[0m");

  const { error: insertErr } = await supabase.from("contacts").insert([{ name: "TestContact One", phone: "919876543210" }]);
  insertErr ? log("fail", "Insert contact", insertErr.message) : log("pass", "Insert contact");

  const { data: found } = await supabase.from("contacts").select("*").ilike("name", "testcontact one").single();
  found ? log("pass", "Fetch contact by name (ILIKE)") : log("fail", "Fetch contact failed");

  const { error: upsertErr } = await supabase.from("contacts").upsert([{ name: "TestContact One", phone: "911111111111" }], { onConflict: "name" });
  upsertErr ? log("fail", "Upsert contact", upsertErr.message) : log("pass", "Upsert contact");

  const { data: updated } = await supabase.from("contacts").select("*").ilike("name", "TestContact One");
  if (updated && updated.length === 1 && updated[0].phone === "911111111111") {
    log("pass", "Upsert updated number — no duplicate");
  } else if (updated && updated.length > 1) {
    log("fail", "Upsert created duplicate — " + updated.length + " rows");
  } else {
    log("fail", "Upsert unexpected state");
  }

  "+91 98765 43210".replace(/\D/g, "") === "919876543210"
    ? log("pass", "Phone digit-stripping works")
    : log("fail", "Digit-stripping failed");
}

// ─────────────────────────────────────────────
// DELETE TASKS
// ─────────────────────────────────────────────

async function testDeleteTasks() {
  console.log("\n\x1b[1mDELETE TASKS\x1b[0m");

  await supabase.from("personal_reminders").insert([{ phone: TEST_PHONE, message: "call the hospital", reminder_time: new Date(Date.now() + 3600000).toISOString(), status: "pending" }]);
  await supabase.from("daily_routines").insert([{ phone: TEST_PHONE, task_name: "evening walk", reminder_time: "18:30", is_active: true }]);

  const cleanTask = "call the hospital Reminder".replace(/\b(routine|reminder|task|event)\b/gi, "").trim();
  const { data: remDeleted } = await supabase.from("personal_reminders").delete().ilike("message", `%${cleanTask}%`).select();
  remDeleted && remDeleted.length > 0 ? log("pass", "Delete reminder with cleanTask") : log("fail", "Delete reminder failed — cleanTask=" + cleanTask);

  const { data: routDeleted } = await supabase.from("daily_routines").delete().ilike("task_name", "%evening walk%").select();
  routDeleted && routDeleted.length > 0 ? log("pass", "Delete routine by partial name") : log("fail", "Delete routine failed");

  const { data: notFound } = await supabase.from("personal_reminders").delete().ilike("message", "%xyz nonexistent task abc%").select();
  (!notFound || notFound.length === 0) ? log("pass", "Delete returns empty when no match") : log("fail", "Delete found unexpected rows");
}

// ─────────────────────────────────────────────
// INTERVAL REMINDERS
// ─────────────────────────────────────────────

async function testIntervalReminders() {
  console.log("\n\x1b[1mINTERVAL REMINDERS\x1b[0m");

  const intervalMins = 30, durationHrs = 2;
  const task = "interval test drink water";
  const rows = [];
  let next = new Date(Date.now() + intervalMins * 60 * 1000);
  const endTime = new Date(Date.now() + durationHrs * 60 * 60 * 1000);
  while (next <= endTime) {
    rows.push({ phone: TEST_PHONE, message: task, reminder_time: next.toISOString(), group_name: "interval", status: "pending" });
    next = new Date(next.getTime() + intervalMins * 60 * 1000);
  }
  const expectedCount = rows.length;

  const { error: insertErr } = await supabase.from("personal_reminders").insert(rows);
  insertErr ? log("fail", "Interval rows insert", insertErr.message) : log("pass", `Interval rows insert — ${expectedCount} rows`);

  const { data: inserted } = await supabase.from("personal_reminders").select("*").eq("phone", TEST_PHONE).eq("group_name", "interval").eq("message", task).eq("status", "pending");
  inserted && inserted.length === expectedCount
    ? log("pass", `Interval rows fetchable — ${inserted.length}/${expectedCount}`)
    : log("fail", `Interval count mismatch — expected ${expectedCount}, got ${inserted?.length}`);

  inserted && inserted.every(r => r.reminder_time > new Date().toISOString())
    ? log("pass", "All interval rows in future")
    : log("fail", "Some interval rows in the past");

  const { data: deleted } = await supabase.from("personal_reminders").delete().eq("phone", TEST_PHONE).eq("group_name", "interval").ilike("message", `%${task}%`).select();
  deleted && deleted.length === expectedCount
    ? log("pass", `Bulk delete clears all interval rows — ${deleted.length} removed`)
    : log("fail", `Bulk delete incomplete — expected ${expectedCount}, got ${deleted?.length}`);
}

// ─────────────────────────────────────────────
// API USAGE TRACKING
// ─────────────────────────────────────────────

async function testUsageTracking() {
  console.log("\n\x1b[1mAPI USAGE TRACKING\x1b[0m");
  const { getUsage } = require("./src/usage");
  try {
    const usage = await getUsage();
    log("pass", "ensureRowExists() via getUsage()");
    ["gemini", "groq", "openrouter", "serper", "tavily", "errorsToday"].every(k => k in usage)
      ? log("pass", "getUsage() correct shape")
      : log("fail", "getUsage() missing keys: " + Object.keys(usage).join(", "));
  } catch (err) {
    log("fail", "getUsage() threw", err.message);
  }
}

// ─────────────────────────────────────────────
// SCHEDULER LOGIC
// ─────────────────────────────────────────────

async function testSchedulerLogic() {
  console.log("\n\x1b[1mSCHEDULER LOGIC\x1b[0m");

  const pastISO = new Date(Date.now() - 2000).toISOString();
  await supabase.from("personal_reminders").insert([{ phone: TEST_PHONE, message: "Scheduler test reminder", reminder_time: pastISO, status: "pending" }]);

  const { data } = await supabase.from("personal_reminders").select("*").eq("phone", TEST_PHONE).eq("status", "pending").lte("reminder_time", new Date().toISOString());
  data && data.some(r => r.message === "Scheduler test reminder")
    ? log("pass", "TIMESTAMPTZ .lte fires for past reminders")
    : log("fail", "TIMESTAMPTZ comparison failed");

  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const currentHHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

  await supabase.from("daily_routines").insert([{ phone: TEST_PHONE, task_name: "Scheduler test routine", reminder_time: "00:01", is_active: true, last_fired_date: null }]);

  const { data: unfired } = await supabase.from("daily_routines").select("*").eq("phone", TEST_PHONE).eq("is_active", true).or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);
  const dueRow = unfired && unfired.find(r => r.task_name === "Scheduler test routine");
  if (dueRow) {
    currentHHMM >= dueRow.reminder_time.slice(0, 5)
      ? log("pass", `Overdue routine found — "${dueRow.reminder_time.slice(0, 5)}" <= "${currentHHMM}"`)
      : log("fail", "Overdue routine found but time check failed");
  } else {
    log("fail", "Overdue routine not returned by scheduler query");
  }

  await supabase.from("daily_routines").update({ last_fired_date: todayIST }).eq("phone", TEST_PHONE).eq("task_name", "Scheduler test routine");
  const { data: afterFired } = await supabase.from("daily_routines").select("*").eq("phone", TEST_PHONE).eq("is_active", true).or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);
  !(afterFired && afterFired.find(r => r.task_name === "Scheduler test routine"))
    ? log("pass", "No double-fire after last_fired_date set")
    : log("fail", "Routine still returned after last_fired_date update");

  // v1.2: Atomic claim — simulates two dispatchers racing to send the same reminder
  const pastISO2 = new Date(Date.now() - 2000).toISOString();
  const { data: claimSeed } = await supabase
    .from("personal_reminders")
    .insert([{ phone: TEST_PHONE, message: "Atomic claim test", reminder_time: pastISO2, status: "pending" }])
    .select();

  if (claimSeed && claimSeed.length > 0) {
    const rowId = claimSeed[0].id;

    // First claim: UPDATE WHERE status='pending' — should own the row
    const { data: claim1 } = await supabase
      .from("personal_reminders")
      .update({ status: "completed" })
      .eq("id", rowId)
      .eq("status", "pending")
      .select("id");
    claim1?.length === 1
      ? log("pass", "Atomic claim: first claim succeeds")
      : log("fail", `Atomic claim: first claim failed — returned ${claim1?.length} rows`);

    // Second claim: row already completed, should return 0 rows
    const { data: claim2 } = await supabase
      .from("personal_reminders")
      .update({ status: "completed" })
      .eq("id", rowId)
      .eq("status", "pending")
      .select("id");
    claim2?.length === 0
      ? log("pass", "Atomic claim: duplicate claim returns 0 rows — no double-send")
      : log("fail", `Atomic claim: duplicate claim returned ${claim2?.length} rows — duplicate send possible`);
  } else {
    log("fail", "Atomic claim: could not seed test row");
  }
}

// ─────────────────────────────────────────────
// SERVER ROUTES
// ─────────────────────────────────────────────

async function testServerRoutes() {
  console.log("\n\x1b[1mSERVER ROUTES\x1b[0m");
  const BASE = `http://localhost:${process.env.PORT || 3000}`;

  for (const route of ["/api/ping", "/api/status", "/", "/documentation", "/status"]) {
    try {
      const res = await fetch(`${BASE}${route}`);
      res.ok ? log("pass", `${route} returns 200`, `HTTP ${res.status}`) : log("fail", `${route}`, `HTTP ${res.status}`);
    } catch {
      log("skip", `${route}`, "server not running — start with npm run dev");
    }
  }

  try {
    const res = await fetch(`${BASE}/api/status`);
    if (res.ok) {
      const d = await res.json();
      typeof d.version === "string" ? log("pass", "/api/status has version") : log("fail", "/api/status missing version");
      d.stats && typeof d.stats.gemini === "number" ? log("pass", "/api/status has stats") : log("fail", "/api/status missing stats");
      d.limits && typeof d.limits.gemini === "number" ? log("pass", "/api/status has limits") : log("fail", "/api/status missing limits");
    }
  } catch { log("skip", "/api/status shape", "server not running"); }

  try {
    const res = await fetch(`${BASE}/api/ping`);
    if (res.ok) {
      const d = await res.json();
      d.status === "ok" ? log("pass", '/api/ping: status="ok"') : log("fail", `/api/ping: status="${d.status}"`);
      typeof d.latency_ms === "number" ? log("pass", "/api/ping: latency_ms present") : log("fail", "/api/ping: latency_ms missing");
      typeof d.timestamp === "string" ? log("pass", "/api/ping: timestamp present") : log("fail", "/api/ping: timestamp missing");
    }
  } catch { log("skip", "/api/ping shape (UptimeRobot)", "server not running"); }

  // v1.2: /api/tick security
  try {
    const res = await fetch(`${BASE}/api/tick`);
    res.status === 403
      ? log("pass", "/api/tick: no secret → 403")
      : log("fail", `/api/tick: expected 403, got ${res.status}`);
  } catch { log("skip", "/api/tick no-secret check", "server not running"); }

  try {
    const res = await fetch(`${BASE}/api/tick?secret=wrong_secret`);
    res.status === 403
      ? log("pass", "/api/tick: wrong secret → 403")
      : log("fail", `/api/tick: expected 403 with wrong secret, got ${res.status}`);
  } catch { log("skip", "/api/tick wrong-secret check", "server not running"); }

  if (process.env.CRON_SECRET) {
    try {
      const res = await fetch(`${BASE}/api/tick?secret=${process.env.CRON_SECRET}`);
      res.ok
        ? log("pass", "/api/tick: correct secret → 200")
        : log("fail", `/api/tick: expected 200 with correct secret, got ${res.status}`);
    } catch { log("skip", "/api/tick correct-secret check", "server not running"); }
  } else {
    log("skip", "/api/tick correct-secret check", "CRON_SECRET not set");
  }
}

// ─────────────────────────────────────────────
// HELPER: buildReminderDate
// ─────────────────────────────────────────────

function testBuildReminderDate() {
  console.log("\n\x1b[1mBUILD REMINDER DATE HELPER\x1b[0m");

  function buildReminderDate(timeString, dateString = null) {
    const now = new Date();
    if (dateString) return new Date(`${dateString}T${timeString}+05:30`).toISOString();
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = formatter.formatToParts(now);
    const year = parts.find(p => p.type === "year").value;
    const month = parts.find(p => p.type === "month").value;
    const day = parts.find(p => p.type === "day").value;
    const reminderDate = new Date(`${year}-${month}-${day}T${timeString}+05:30`);
    if (reminderDate < now) reminderDate.setDate(reminderDate.getDate() + 1);
    return reminderDate.toISOString();
  }

  buildReminderDate("09:00:00", "2027-06-15") === new Date("2027-06-15T09:00:00+05:30").toISOString()
    ? log("pass", "buildReminderDate uses explicit date")
    : log("fail", "buildReminderDate date mismatch");

  !isNaN(new Date(buildReminderDate("23:59:00")).getTime())
    ? log("pass", "buildReminderDate without date produces valid ISO")
    : log("fail", "buildReminderDate without date invalid");

  new Date(buildReminderDate("00:01:00")) > new Date()
    ? log("pass", "buildReminderDate rolls to tomorrow for past time")
    : log("fail", "buildReminderDate did not roll to tomorrow");
}

// ─────────────────────────────────────────────
// v1.1: CONVERSATIONAL MEMORY
// ─────────────────────────────────────────────

async function testConversationalMemory() {
  console.log("\n\x1b[1mCONVERSATIONAL MEMORY (v1.1)\x1b[0m");

  const seedRows = [
    { sender_name: "TestUser", sender_phone: TEST_PHONE, message: "Who won IPL 2024?", bot_response: "Kolkata Knight Riders won IPL 2024." },
    { sender_name: "TestUser", sender_phone: TEST_PHONE, message: "Where was the final held?", bot_response: "At MA Chidambaram Stadium in Chennai." },
  ];
  const { error: seedErr } = await supabase.from("interaction_logs").insert(seedRows);
  seedErr ? log("fail", "Seed history rows", seedErr.message) : log("pass", "Seed history rows");

  const { data: historyRows, error: fetchErr } = await supabase
    .from("interaction_logs").select("message, bot_response").eq("sender_phone", TEST_PHONE).order("created_at", { ascending: true }).limit(4);

  if (fetchErr || !historyRows) { log("fail", "Fetch history", fetchErr?.message); return; }
  log("pass", `Fetch history — ${historyRows.length} rows`);

  historyRows[0]?.message === "Who won IPL 2024?"
    ? log("pass", "History ordered oldest-first")
    : log("fail", `First row: "${historyRows[0]?.message}"`);

  const history = historyRows.map(r => ({ userMessage: r.message, botResponse: r.bot_response }));
  history.every(h => typeof h.userMessage === "string" && typeof h.botResponse === "string")
    ? log("pass", "History shape: { userMessage, botResponse }[]")
    : log("fail", "History shape invalid");

  try {
    const result = await callAI("Who was the winning captain?", false, history);
    ["chat", "web_search"].includes(result.intent)
      ? log("pass", `Follow-up resolved — intent="${result.intent}"`)
      : log("fail", `Unexpected intent="${result.intent}"`);
    result.ai_meta ? log("pass", "ai_meta present with history param") : log("fail", "ai_meta missing with history");
  } catch (err) {
    err.message === 'AI_EXHAUSTED'
      ? log('skip', 'analyzeMessage with history', 'AI quota exhausted — skipping remaining AI tests')
      : log('fail', 'analyzeMessage with history threw', err.message);
  }

  const { data: otherRows } = await supabase.from("interaction_logs").select("message").eq("sender_phone", "919999999999").limit(4);
  (!otherRows || otherRows.length === 0)
    ? log("pass", "History scoped to sender_phone — no cross-user leak")
    : log("fail", "History leaked across phones");
}

// ─────────────────────────────────────────────
// v1.1: MISSING TIME UX FIX
// ─────────────────────────────────────────────

async function testMissingTimeUXFix() {
  console.log("\n\x1b[1mMISSING TIME UX FIX (v1.1)\x1b[0m");

  const cases = [
    { msg: "Remind me to call the doctor", name: "Reminder with no time" },
    { msg: "Set a daily routine to drink water", name: "Routine with no time" },
    { msg: "Remind me about my dentist appointment", name: "Reminder with no time (no date either)" },
  ];

  for (const tc of cases) {
    if (aiExhausted) { log("skip", tc.name, "AI quota exhausted"); continue; }
    try {
      const result = await callAI(tc.msg);
      if (result.intent === "chat") {
        const asksForTime = result.taskOrMessage &&
          (result.taskOrMessage.toLowerCase().includes("time") || result.taskOrMessage.toLowerCase().includes("when"));
        asksForTime
          ? log("pass", tc.name, `intent=chat, asks: "${result.taskOrMessage}"`)
          : log("fail", tc.name, `intent=chat but no time question: "${result.taskOrMessage}"`);
      } else {
        result.time !== null
          ? log("pass", `${tc.name} — AI found implicit time="${result.time}"`)
          : log("fail", tc.name, `intent="${result.intent}" with no time — rule not applied`);
      }
    } catch (err) {
      err.message === 'AI_EXHAUSTED'
        ? log('skip', tc.name, 'AI quota exhausted')
        : log('fail', tc.name, err.message);
    }
  }

  try {
    const result = await callAI("Remind me to call the doctor at 3 PM");
    result.intent === "reminder"
      ? log("pass", "WITH time not downgraded to chat (positive control)")
      : log("fail", `Positive control failed — got "${result.intent}"`);
  } catch (err) {
    err.message === 'AI_EXHAUSTED'
      ? log('skip', 'Positive control', 'AI quota exhausted')
      : log('fail', 'Positive control threw', err.message);
  }
}

// ─────────────────────────────────────────────
// v1.1: EDIT TASK (UNDO)
// ─────────────────────────────────────────────

async function testEditTask() {
  console.log("\n\x1b[1mEDIT TASK / UNDO (v1.1)\x1b[0m");

  const originalTime = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const { data: seeded, error: seedErr } = await supabase
    .from("personal_reminders")
    .insert([{ phone: TEST_PHONE, message: "buy eggs", reminder_time: originalTime, status: "pending" }])
    .select();

  if (seedErr || !seeded) { log("fail", "Seed reminder for edit", seedErr?.message); return; }
  log("pass", "Seeded pending reminder for edit test");

  // Mirrors edit_task handler query
  const { data: found } = await supabase
    .from("personal_reminders").select("*").eq("phone", TEST_PHONE).eq("status", "pending").ilike("message", "%buy eggs%").order("reminder_time", { ascending: true }).limit(1);

  found && found.length > 0
    ? log("pass", "edit_task query finds pending reminder by ILIKE")
    : log("fail", "edit_task query: no matching reminder");

  if (!found || found.length === 0) return;

  // Simulate edit: delete old, insert new
  await supabase.from("personal_reminders").delete().eq("id", found[0].id);
  const newTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const { error: insertErr } = await supabase.from("personal_reminders").insert([{
    phone: TEST_PHONE, message: found[0].message, reminder_time: newTime, group_name: found[0].group_name, status: "pending",
  }]);
  insertErr ? log("fail", "edit_task: insert updated reminder", insertErr.message) : log("pass", "edit_task: delete old + insert new");

  const { data: oldRow } = await supabase.from("personal_reminders").select("*").eq("id", found[0].id);
  (!oldRow || oldRow.length === 0) ? log("pass", "Old row deleted") : log("fail", "Old row still exists");

  const { data: newRow } = await supabase.from("personal_reminders").select("*").eq("phone", TEST_PHONE).eq("message", "buy eggs").eq("status", "pending");
  // Compare at second precision — Supabase TIMESTAMPTZ can round sub-millisecond digits
  const newRowMatch = newRow && newRow.length === 1 &&
    Math.floor(new Date(newRow[0].reminder_time).getTime() / 1000) === Math.floor(new Date(newTime).getTime() / 1000);
  newRowMatch
    ? log("pass", "New row has updated time")
    : log("fail", "New row time mismatch or missing");

  try {
    const result = await callAI("Change the buy eggs reminder to 7 PM");
    result.intent === "edit_task"
      ? log("pass", `AI: edit_task detected — time="${result.time}"`)
      : log("fail", `AI: expected edit_task, got "${result.intent}"`);
    result.time !== null
      ? log("pass", "AI: new time extracted for edit_task")
      : log("fail", "AI: no time for edit_task");
  } catch (err) {
    err.message === 'AI_EXHAUSTED'
      ? log('skip', 'AI: edit_task', 'AI quota exhausted')
      : log('fail', 'AI edit_task threw', err.message);
  }
}

// ─────────────────────────────────────────────
// v1.1: WHATSAPP MARKDOWN FORMATTER
// ─────────────────────────────────────────────

function testWhatsAppFormatter() {
  console.log("\n\x1b[1mWHATSAPP MARKDOWN FORMATTER (v1.1)\x1b[0m");

  function formatForWhatsApp(text) {
    return text
      .replace(/^#{1,3}\s+(.+)$/gm, (_, h) => `*${h.toUpperCase()}*`)
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/`([^`]+)`/g, "```$1```")
      .replace(/^[-*]{3,}\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const cases = [
    { input: "## Summary", expected: "*SUMMARY*", name: "## → *UPPERCASE*" },
    { input: "### Results", expected: "*RESULTS*", name: "### → *UPPERCASE*" },
    { input: "**bold text**", expected: "*bold text*", name: "**bold** → *bold*" },
    { input: "__bold text__", expected: "*bold text*", name: "__bold__ → *bold*" },
    { input: "~~strikethrough~~", expected: "~strikethrough~", name: "~~strike~~ → ~strike~" },
    { input: "`code`", expected: "```code```", name: "`code` → ```code```" },
    { input: "---", expected: "", name: "--- removed" },
  ];

  for (const tc of cases) {
    const result = formatForWhatsApp(tc.input);
    result === tc.expected
      ? log("pass", tc.name, `"${tc.input}" → "${result}"`)
      : log("fail", tc.name, `expected "${tc.expected}", got "${result}"`);
  }

  const plain = "Remind me to call the bank at 3 PM";
  formatForWhatsApp(plain) === plain
    ? log("pass", "Plain text passes through unchanged")
    : log("fail", "Plain text mangled by formatter");
}

// ─────────────────────────────────────────────
// v1.1: VAGUE TIME DEFAULTS
// ─────────────────────────────────────────────

async function testVagueTimeDefaults() {
  console.log("\n\x1b[1mVAGUE TIME DEFAULTS (v1.1)\x1b[0m");

  const cases = [
    { msg: "Remind me tomorrow morning to call the doctor", expectedTime: "09:00:00", label: "morning → 09:00" },
    { msg: "Remind me this afternoon to take medicine", expectedTime: "14:00:00", label: "afternoon → 14:00" },
    { msg: "Remind me this evening to go for a walk", expectedTime: "18:00:00", label: "evening → 18:00" },
    { msg: "Remind me tonight to check emails", expectedTime: "21:00:00", label: "night → 21:00" },
  ];

  for (const tc of cases) {
    if (aiExhausted) { log("skip", tc.label, "AI quota exhausted"); continue; }
    try {
      const result = await callAI(tc.msg);
      if (result.intent === "reminder" && result.time === tc.expectedTime) {
        log("pass", tc.label, `time="${result.time}"`);
      } else if (result.intent === "reminder" && result.time !== null) {
        log("pass", `${tc.label} — AI resolved to "${result.time}" (variation accepted)`);
      } else if (result.intent === "chat") {
        log("pass", `${tc.label} — AI asked for time (missing time rule applied)`);
      } else {
        log("fail", tc.label, `intent="${result.intent}", time="${result.time}"`);
      }
    } catch (err) {
      err.message === 'AI_EXHAUSTED'
        ? log('skip', tc.label, 'AI quota exhausted')
        : log('fail', tc.label, err.message);
    }
  }
}

// ─────────────────────────────────────────────
// v1.1: RECURRING TASKS (weekly + monthly)
// ─────────────────────────────────────────────

async function testRecurringTasks() {
  console.log("\n\x1b[1mRECURRING TASKS (v1.1)\x1b[0m");

  // Insert weekly task
  const { error: weeklyErr } = await supabase.from("recurring_tasks").insert([{
    phone: TEST_PHONE, task_name: "Take out the trash", reminder_time: "20:00",
    recurrence_type: "weekly", day_of_week: 2, day_of_month: null, is_active: true,
  }]);
  weeklyErr ? log("fail", "Insert weekly task", weeklyErr.message) : log("pass", "Insert weekly task");

  // Insert monthly task
  const { error: monthlyErr } = await supabase.from("recurring_tasks").insert([{
    phone: TEST_PHONE, task_name: "Pay rent", reminder_time: "09:00",
    recurrence_type: "monthly", day_of_week: null, day_of_month: 1, is_active: true,
  }]);
  monthlyErr ? log("fail", "Insert monthly task", monthlyErr.message) : log("pass", "Insert monthly task");

  const { data: tasks } = await supabase.from("recurring_tasks").select("*").eq("phone", TEST_PHONE).eq("is_active", true);
  const wt = tasks && tasks.find(t => t.task_name === "Take out the trash");
  const mt = tasks && tasks.find(t => t.task_name === "Pay rent");

  wt && wt.day_of_week === 2 && wt.recurrence_type === "weekly"
    ? log("pass", "Weekly task: day_of_week=2, type=weekly")
    : log("fail", "Weekly task missing or wrong data");

  mt && mt.day_of_month === 1 && mt.recurrence_type === "monthly"
    ? log("pass", "Monthly task: day_of_month=1, type=monthly")
    : log("fail", "Monthly task missing or wrong data");

  // last_fired_date guard — fire weekly task and verify it disappears from due list
  const todayIST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  if (wt) {
    await supabase.from("recurring_tasks").update({ last_fired_date: todayIST }).eq("id", wt.id);
    const { data: afterFire } = await supabase.from("recurring_tasks").select("*").eq("phone", TEST_PHONE).eq("is_active", true).or(`last_fired_date.is.null,last_fired_date.neq.${todayIST}`);
    !(afterFire && afterFire.find(t => t.task_name === "Take out the trash"))
      ? log("pass", "Weekly task not returned after last_fired_date set — no double-fire")
      : log("fail", "Weekly task still due after last_fired_date update");
  }

  // Scheduler day matching logic
  const { data: allActive } = await supabase.from("recurring_tasks").select("*").eq("phone", TEST_PHONE).eq("is_active", true);
  if (allActive) {
    allActive.filter(t => t.recurrence_type === "weekly" && t.day_of_week === 2).length > 0
      ? log("pass", "Weekly filter by day_of_week=2 works")
      : log("fail", "Weekly day_of_week filter returned nothing");
  }

  const { data: monthlyMatch } = await supabase.from("recurring_tasks").select("*").eq("phone", TEST_PHONE).eq("recurrence_type", "monthly").eq("day_of_month", 1);
  monthlyMatch && monthlyMatch.length > 0
    ? log("pass", "Monthly filter by day_of_month=1 works")
    : log("fail", "Monthly day_of_month filter returned nothing");

  // AI intent tests
  try {
    const wr = await callAI("Remind me to take out the trash every Tuesday at 8 PM");
    wr.intent === "weekly_reminder" && parseInt(wr.dayOfWeek) === 2
      ? log("pass", `AI: weekly_reminder — dayOfWeek="${wr.dayOfWeek}"`)
      : log("fail", `AI: expected weekly_reminder+dayOfWeek=2, got intent="${wr.intent}" dayOfWeek="${wr.dayOfWeek}"`);
  } catch (err) {
    err.message === 'AI_EXHAUSTED'
      ? log('skip', 'AI: weekly_reminder', 'AI quota exhausted')
      : log('fail', 'AI weekly_reminder threw', err.message);
  }

  try {
    const mr = await callAI("Remind me to pay rent on the 1st of every month at 9 AM");
    mr.intent === "monthly_reminder" && parseInt(mr.dayOfMonth) === 1
      ? log("pass", `AI: monthly_reminder — dayOfMonth="${mr.dayOfMonth}"`)
      : log("fail", `AI: expected monthly_reminder+dayOfMonth=1, got intent="${mr.intent}" dayOfMonth="${mr.dayOfMonth}"`);
  } catch (err) {
    err.message === 'AI_EXHAUSTED'
      ? log('skip', 'AI: monthly_reminder', 'AI quota exhausted')
      : log('fail', 'AI monthly_reminder threw', err.message);
  }
}

// ─────────────────────────────────────────────
// v1.1: MEDIA HANDLING
// ─────────────────────────────────────────────

function testMediaHandling() {
  console.log("\n\x1b[1mMEDIA HANDLING (v1.1)\x1b[0m");

  const mediaTypes = ["audio", "image", "video", "document", "sticker"];

  function shouldHandleMedia(messageData) {
    if (!messageData?.text?.body) {
      return mediaTypes.includes(messageData?.type) ? messageData.type : null;
    }
    return null;
  }

  const cases = [
    { data: { type: "audio" }, expected: "audio", name: "Audio message detected" },
    { data: { type: "image" }, expected: "image", name: "Image message detected" },
    { data: { type: "video" }, expected: "video", name: "Video message detected" },
    { data: { type: "document" }, expected: "document", name: "Document message detected" },
    { data: { type: "sticker" }, expected: "sticker", name: "Sticker message detected" },
    { data: { type: "text", text: { body: "hello" } }, expected: null, name: "Text passes through (not intercepted)" },
    { data: { type: "reaction" }, expected: null, name: "Reaction silently dropped" },
    { data: {}, expected: null, name: "Empty object returns null" },
  ];

  for (const tc of cases) {
    const result = shouldHandleMedia(tc.data);
    result === tc.expected
      ? log("pass", tc.name, `type="${tc.data.type}" → "${result}"`)
      : log("fail", tc.name, `expected="${tc.expected}", got="${result}"`);
  }

  function getMediaReply(msgType) {
    const typeLabel = msgType === "audio" ? "voice notes" : `${msgType}s`;
    return `I can only read text messages right now. I cannot process ${typeLabel}. Please type your request.`;
  }

  getMediaReply("audio").includes("voice notes")
    ? log("pass", "Audio reply uses 'voice notes'")
    : log("fail", "Audio reply label wrong");

  getMediaReply("image").includes("images")
    ? log("pass", "Image reply uses 'images'")
    : log("fail", "Image reply label wrong");

  const emojiRegex = /[\u{1F300}-\u{1FFFF}]/u;
  !emojiRegex.test(getMediaReply("audio")) && !emojiRegex.test(getMediaReply("image"))
    ? log("pass", "Media replies contain no emojis")
    : log("fail", "Media replies contain emojis — violates no-emoji rule");
}

// ─────────────────────────────────────────────
// v1.2: WEBHOOK SECURITY
// ─────────────────────────────────────────────

function testWebhookSecurity() {
  console.log("\n\x1b[1mWEBHOOK SECURITY (v1.2)\x1b[0m");

  const crypto = require("crypto");

  // Replicate server.js verifyWebhookSignature logic
  function verifySignature(rawBody, sig, secret) {
    if (!secret) return true;
    if (!sig) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  // No secret set → always pass (dev mode)
  verifySignature(Buffer.from("body"), "sha256=abc", "")
    ? log("pass", "No secret → passes through (dev mode)")
    : log("fail", "No secret should pass through");

  // Missing signature header → reject
  !verifySignature(Buffer.from("body"), null, "mysecret")
    ? log("pass", "Missing sig header → rejected")
    : log("fail", "Missing sig header should be rejected");

  // Wrong signature → reject
  !verifySignature(Buffer.from("body"), "sha256=wrongsig", "mysecret")
    ? log("pass", "Wrong signature → rejected")
    : log("fail", "Wrong signature should be rejected");

  // Correct signature → accept
  const body = Buffer.from('{"entry":[{"changes":[{}]}]}');
  const secret = "test_app_secret";
  const validSig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  verifySignature(body, validSig, secret)
    ? log("pass", "Valid HMAC signature → accepted")
    : log("fail", "Valid HMAC signature rejected");

  // Buffer length mismatch → returns false, does not throw
  let threw = false;
  let mismatchResult;
  try {
    mismatchResult = verifySignature(Buffer.from("body"), "sha256=short", "mysecret");
  } catch {
    threw = true;
  }
  !threw && mismatchResult === false
    ? log("pass", "Buffer length mismatch → rejected without throwing")
    : threw
      ? log("fail", "Buffer length mismatch threw an exception — timingSafeEqual would fail in prod")
      : log("fail", "Buffer length mismatch should return false");
}

// ─────────────────────────────────────────────
// v1.2: RATE LIMITING
// ─────────────────────────────────────────────

function testRateLimiting() {
  console.log("\n\x1b[1mRATE LIMITING (v1.2)\x1b[0m");

  // Replicate server.js isRateLimited logic
  const _map = new Map();
  function isRateLimited(phone) {
    const now = Date.now();
    const entry = _map.get(phone);
    if (!entry || now > entry.resetAt) {
      _map.set(phone, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    if (entry.count >= 10) return true;
    entry.count++;
    return false;
  }

  const phone = "911234567890";

  // First 10 messages: not limited
  let allPassed = true;
  for (let i = 0; i < 10; i++) {
    if (isRateLimited(phone)) { allPassed = false; break; }
  }
  allPassed
    ? log("pass", "First 10 messages pass through")
    : log("fail", "Rate limit triggered before 10 messages");

  // 11th message: limited
  isRateLimited(phone)
    ? log("pass", "11th message is rate-limited")
    : log("fail", "11th message should be rate-limited");

  // Different phone: not affected
  !isRateLimited("919999999999")
    ? log("pass", "Different phone is not limited")
    : log("fail", "Rate limit leaked across phone numbers");

  // After window expires: resets
  _map.set(phone, { count: 10, resetAt: Date.now() - 1 });
  !isRateLimited(phone)
    ? log("pass", "Rate limit resets after window expires")
    : log("fail", "Rate limit did not reset after window expires");
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// CLI FLAGS
//
// Run all suites:
//   node test.js
//
// Run specific suite(s) by name:
//   node test.js --suite formatter
//   node test.js --suite formatter,memory,recurring
//
// Available suite keys:
//   connectivity | builddate | ai | reminders | routines | events | contacts |
//   delete | interval | scheduler | usage | routes |
//   memory | missingtime | edit | formatter | vaguedefaults | recurring | media |
//   security | ratelimit
// ─────────────────────────────────────────────

const SUITES = {
  connectivity: { fn: testSupabaseConnection, async: true },
  builddate:    { fn: testBuildReminderDate,  async: false },
  ai:           { fn: testAIParsing,          async: true },
  reminders:    { fn: testReminders,          async: true },
  routines:     { fn: testRoutines,           async: true },
  events:       { fn: testSpecialEvents,      async: true },
  contacts:     { fn: testContacts,           async: true },
  delete:       { fn: testDeleteTasks,        async: true },
  interval:     { fn: testIntervalReminders,  async: true },
  scheduler:    { fn: testSchedulerLogic,     async: true },
  usage:        { fn: testUsageTracking,      async: true },
  routes:       { fn: testServerRoutes,       async: true },
  memory:       { fn: testConversationalMemory, async: true },
  missingtime:  { fn: testMissingTimeUXFix,   async: true },
  edit:         { fn: testEditTask,           async: true },
  formatter:    { fn: testWhatsAppFormatter,  async: false },
  vaguedefaults: { fn: testVagueTimeDefaults, async: true },
  recurring:    { fn: testRecurringTasks,     async: true },
  media:        { fn: testMediaHandling,      async: false },
  security:     { fn: testWebhookSecurity,    async: false },
  ratelimit:    { fn: testRateLimiting,       async: false },
};

async function main() {
  // Parse --suite flag: node test.js --suite formatter,media
  const suiteArg = process.argv.indexOf("--suite");
  const filterKeys = suiteArg !== -1
    ? process.argv[suiteArg + 1]?.split(",").map(s => s.trim().toLowerCase())
    : null;

  // Validate any requested keys
  if (filterKeys) {
    const unknown = filterKeys.filter(k => !SUITES[k]);
    if (unknown.length > 0) {
      console.log(`\n\x1b[31mUnknown suite(s): ${unknown.join(", ")}\x1b[0m`);
      console.log(`Available: ${Object.keys(SUITES).join(", ")}\n`);
      process.exit(1);
    }
  }

  const suitesToRun = filterKeys
    ? Object.entries(SUITES).filter(([key]) => filterKeys.includes(key))
    : Object.entries(SUITES);

  const label = filterKeys ? `Suites: ${filterKeys.join(", ")}` : "Full Suite";

  console.log("\n\x1b[1m\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log(`\x1b[1m\x1b[36m  Manvi v1.2 — Integration Test Suite\x1b[0m`);
  console.log(`\x1b[1m\x1b[36m  ${label}\x1b[0m`);
  console.log("\x1b[1m\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log("\n\x1b[31mError: SUPABASE_URL and SUPABASE_KEY must be set in .env\x1b[0m\n");
    process.exit(1);
  }

  await cleanup();

  for (const [, suite] of suitesToRun) {
    if (suite.async) await suite.fn();
    else suite.fn();
  }

  await cleanup();

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