const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");

const LIMITS = {
  gemini: 40, // 20 (Gemini 3) + 20 (Gemini 2.5) — combined daily free cap
  groq: 500, // Daily safety cap (Groq free tier is generous — adjust as needed)
  openrouter: 50, // Daily safety cap (paid fallback)
  serper: 2500, // Lifetime
  tavily: 1000, // Monthly
};

function getTodayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
}

// Self-Healing Function — creates today's row if it doesn't exist yet
async function ensureRowExists() {
  const today = getTodayIST();
  const { data } = await supabase
    .from("api_usage")
    .select("*")
    .eq("usage_date", today)
    .maybeSingle();

  if (!data) {
    await supabase.from("api_usage").insert([
      {
        usage_date: today,
        gemini_count: 0,
        groq_count: 0,
        openrouter_count: 0,
        tavily_count: 0,
        serper_count: 0,
      },
    ]);
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
  };

  let totalSerper = 0;
  let totalTavily = 0;

  allData?.forEach((row) => {
    totalSerper += row.serper_count || 0;
    if (row.usage_date.startsWith(currentMonth))
      totalTavily += row.tavily_count || 0;
  });

  return {
    gemini: daily.gemini_count,
    groq: daily.groq_count || 0,
    openrouter: daily.openrouter_count,
    serper: totalSerper,
    tavily: totalTavily,
  };
}

async function track(service) {
  await ensureRowExists();
  const today = getTodayIST();

  const { data } = await supabase
    .from("api_usage")
    .select(`${service}_count`)
    .eq("usage_date", today)
    .single();
  const currentCount = data ? data[`${service}_count`] || 0 : 0;

  await supabase
    .from("api_usage")
    .update({ [`${service}_count`]: currentCount + 1 })
    .eq("usage_date", today);

  // Low-credit alerts for search services
  if (service === "serper" || service === "tavily") {
    const stats = await getUsage();
    const rem =
      service === "serper"
        ? LIMITS.serper - stats.serper
        : LIMITS.tavily - stats.tavily;
    if ([50, 10, 0].includes(rem)) {
      await sendWhatsAppMessage(
        process.env.MY_PHONE_NUMBER,
        `⚠️ *Low Credits:* ${service} has ${rem} left!`,
      );
    }
  }
}

module.exports = { getUsage, track, LIMITS };
