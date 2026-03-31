const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");

const LIMITS = {
  gemini: 40,        // Daily combined cap: Tier 1 + Tier 2 (free)
  groq: 300,        // Daily safety cap (Groq free tier)
  openrouter: 50,    // Daily safety cap (paid fallback)
  serper: 2500,      // Lifetime cap
  tavily: 1000,      // Monthly cap
};

function getTodayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

async function ensureRowExists() {
  const today = getTodayIST();
  const { data } = await supabase
    .from("api_usage")
    .select("usage_date")
    .eq("usage_date", today)
    .maybeSingle();

  if (!data) {
    await supabase.from("api_usage").insert([{
      usage_date: today,
      gemini_count: 0,
      groq_count: 0,
      openrouter_count: 0,
      tavily_count: 0,
      serper_count: 0,
      error_count: 0,
    }]);
  }
}

async function getUsage() {
  await ensureRowExists();
  const today = getTodayIST();
  const currentMonth = today.slice(0, 7);

  const { data: allData } = await supabase.from("api_usage").select("*");

  const daily = allData?.find((d) => d.usage_date === today) || {
    gemini_count: 0,
    groq_count: 0,
    openrouter_count: 0,
    tavily_count: 0,
    serper_count: 0,
    error_count: 0,
  };

  let totalSerper = 0;
  let totalTavily = 0;
  
  // Track all-time sum for the UI toggle
  const allTime = { gemini: 0, groq: 0, openrouter: 0, tavily: 0, serper: 0 };

  allData?.forEach((row) => {
    totalSerper += row.serper_count || 0;
    if (row.usage_date.startsWith(currentMonth)) totalTavily += row.tavily_count || 0;
    
    allTime.gemini += (row.gemini_count || 0);
    allTime.groq += (row.groq_count || 0);
    allTime.openrouter += (row.openrouter_count || 0);
    allTime.tavily += (row.tavily_count || 0);
    allTime.serper += (row.serper_count || 0);
  });

  const sortedData = [...(allData || [])].sort(
    (a, b) => new Date(a.usage_date) - new Date(b.usage_date)
  );
  // --- 90-DAY HISTORY WITH GAP DETECTION ---
  const historyFull = [];
  const oldestRecord = sortedData[0]?.usage_date || today;

  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
    
    const record = sortedData.find((r) => r.usage_date === dateStr);
    
    if (record) {
      historyFull.push({
        usage_date: dateStr,
        gemini_count: record.gemini_count || 0,
        groq_count: record.groq_count || 0,
        openrouter_count: record.openrouter_count || 0,
        error_count: record.error_count || 0,
        status: record.error_count > 0 ? "error" : "ok",
      });
    } else {
      // If date is AFTER the first record, it's a DOWN day. Otherwise it's EMPTY (before bot started).
      const isDown = dateStr > oldestRecord;
      historyFull.push({
        usage_date: dateStr,
        status: isDown ? "down" : "empty",
      });
    }
  }

  // --- 24-HOUR BUCKETING LOGIC ---
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: recentInteractions } = await supabase
    .from('interaction_logs')
    .select('created_at')
    .gte('created_at', twentyFourHoursAgo);

  const hourlySuccess = new Array(24).fill(0);
  const hourlyErrors = new Array(24).fill(0);
  const nowMs = Date.now();

  const bucketLog = (dateString, targetArray) => {
    const logMs = new Date(dateString).getTime();
    const diffHours = Math.floor((nowMs - logMs) / (1000 * 60 * 60));
    if (diffHours >= 0 && diffHours < 24) targetArray[23 - diffHours]++;
  };

  if (recentInteractions) recentInteractions.forEach(log => bucketLog(log.created_at, hourlySuccess));

  return {
    gemini: daily.gemini_count || 0,
    groq: daily.groq_count || 0,
    openrouter: daily.openrouter_count || 0,
    tavilyToday: daily.tavily_count || 0,
    serperToday: daily.serper_count || 0,
    serper: totalSerper,
    tavily: totalTavily,
    errorsToday: daily.error_count || 0,
    historyLabels: historyFull.map((d) => d.usage_date),
    historyData: historyFull.map((d) => (d.gemini_count || 0) + (d.groq_count || 0) + (d.openrouter_count || 0)),
    errorData: historyFull.map((d) => d.error_count || 0),
    historyRaw: historyFull,
    daysTracked: allData?.length || 1,
    hourlySuccess: hourlySuccess,
    hourlyErrors: hourlyErrors,
    allTimeStats: allTime
  };
}

async function track(service) {
  await ensureRowExists();
  const today = getTodayIST();

  const { data } = await supabase.from("api_usage").select(`${service}_count`).eq("usage_date", today).single();
  const currentCount = data ? (data[`${service}_count`] || 0) : 0;

  await supabase.from("api_usage").update({ [`${service}_count`]: currentCount + 1 }).eq("usage_date", today);

  if (service === "serper" || service === "tavily") {
    const stats = await getUsage();
    const remaining = service === "serper" ? LIMITS.serper - stats.serper : LIMITS.tavily - stats.tavily;
    if ([50, 10, 0].includes(remaining)) {
      await sendWhatsAppMessage(process.env.MY_PHONE_NUMBER, `Low Credits Warning: ${service} has ${remaining} requests remaining.`);
    }
  }
}

module.exports = { getUsage, track, ensureRowExists, LIMITS };