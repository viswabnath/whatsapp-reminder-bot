const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");

const LIMITS = {
  gemini: 1500,     // Daily
  openrouter: 50,   // Daily Safety
  serper: 2500,     // Lifetime
  tavily: 1000      // Monthly
};

function getTodayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

async function getUsage() {
  const today = getTodayIST();
  const currentMonth = today.slice(0, 7);
  const { data: allData } = await supabase.from("api_usage").select("*");
  
  const daily = allData?.find(d => d.usage_date === today) || { gemini_count: 0, openrouter_count: 0 };
  let totalSerper = 0;
  let totalTavily = 0;

  allData?.forEach(row => {
    totalSerper += (row.serper_count || 0);
    if (row.usage_date.startsWith(currentMonth)) totalTavily += (row.tavily_count || 0);
  });

  return { gemini: daily.gemini_count, openrouter: daily.openrouter_count, serper: totalSerper, tavily: totalTavily };
}

async function track(service) {
  const today = getTodayIST();
  await supabase.rpc('increment_api_usage', { target_date: today, column_name: `${service}_count` });

  // 🚨 Alert logic
  if (service === "serper" || service === "tavily") {
    const stats = await getUsage();
    const rem = service === "serper" ? LIMITS.serper - stats.serper : LIMITS.tavily - stats.tavily;
    if ([50, 10, 0].includes(rem)) {
      await sendWhatsAppMessage(process.env.MY_PHONE_NUMBER, `⚠️ *Low Credits:* ${service} has ${rem} left!`);
    }
  }
}

module.exports = { getUsage, track, LIMITS };