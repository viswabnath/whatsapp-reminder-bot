const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai");
const supabase = require("./supabase"); // We need the DB to check the counter
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GEMINI_DAILY_LIMIT = 20; // Set your strict beta limit here

// --- HELPER: Get today's date in IST (YYYY-MM-DD) ---
function getTodayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

// --- HELPER: Check and Increment Daily Counter ---
async function trackGeminiUsage() {
  const today = getTodayIST();
  let { data } = await supabase.from("api_usage").select("gemini_count").eq("usage_date", today).single();
  
  if (!data) {
    await supabase.from("api_usage").insert([{ usage_date: today, gemini_count: 0 }]);
    data = { gemini_count: 0 };
  }

  if (data.gemini_count < GEMINI_DAILY_LIMIT) {
    await supabase.from("api_usage").update({ gemini_count: data.gemini_count + 1 }).eq("usage_date", today);
    return { allowed: true, remaining: GEMINI_DAILY_LIMIT - (data.gemini_count + 1) };
  }
  return { allowed: false, remaining: 0 };
}

// --- FALLBACK: Route to OpenAI ---
async function callOpenAIFallback(systemPrompt, userMessage) {
  console.log("🔄 Routing to OpenAI Fallback...");
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast, incredibly cheap, great at JSON
      response_format: { type: "json_object" }, // Forces strict JSON
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("OpenAI Fallback Error:", error);
    return { intent: "api_error", targetName: "you", time: null, date: null, taskOrMessage: "Both Gemini and the Fallback AI are currently down." };
  }
}

// --- MAIN ROUTER ---
async function analyzeMessage(userMessage) {
  const currentIST = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });

  const prompt = `
  You are the intelligent brain of a personal WhatsApp assistant named Manvi. 
  Your owner is Viswanath. You are currently talking to a user via WhatsApp.
  
  CRITICAL CONTEXT:
  The current date and time right now is: ${currentIST}. 
  If the user asks for a relative time like "in 5 minutes", use this current time to calculate the exact HH:MM:SS.
  
  Your job is to read the user's message and extract the exact intent.
  You MUST respond with ONLY a valid, raw JSON object. Do not include markdown or conversational text.
  
  Use this exact JSON structure:
  {
    "intent": "reminder" | "routine" | "event" | "instant_message" | "chat" | "query_birthday" | "query_schedule" | "query_routines" | "query_contacts" | "query_reminders" | "query_events" | "delete_task" | "unknown",
    "targetName": "you" (Use "you" if the message is meant for Viswanath, "him", "he", or "owner") OR the extracted name,
    "time": "HH:MM:SS" (in 24-hour format if a time is mentioned/calculated. Assume IST timezone.),
    "date": "YYYY-MM-DD" (if a specific date is mentioned/calculated for queries or events),
    "taskOrMessage": "The cleaned up task/message. For deletions, extract what needs to be deleted (e.g., 'drink water')"
  }

  Examples:
  Message: "What contacts do you have?"
  JSON: {"intent": "query_contacts", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}

  Message: "Show me all active reminders"
  JSON: {"intent": "query_reminders", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}

  Message: "List my daily routines"
  JSON: {"intent": "query_routines", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}

  Message: "What are my special events?"
  JSON: {"intent": "query_events", "targetName": "you", "time": null, "date": null, "taskOrMessage": null}
  
  Message: "When is Manu's birthday?"
  JSON: {"intent": "query_birthday", "targetName": "manu", "time": null, "date": null, "taskOrMessage": null}

  Message: "What is my schedule for tomorrow?"
  JSON: {"intent": "query_schedule", "targetName": "you", "time": null, "date": "2026-02-28", "taskOrMessage": null}
  
  Message: "Remind me in 5 minutes to check logs"
  JSON: {"intent": "reminder", "targetName": "you", "time": "14:12:00", "date": null, "taskOrMessage": "check logs"}
  
  Message: "Tell me a joke"
  JSON: {"intent": "chat", "targetName": null, "time": null, "date": null, "taskOrMessage": "Why do programmers prefer dark mode? Because light attracts bugs!"}

  Message: "Tell him to call me back"
  JSON: {"intent": "instant_message", "targetName": "you", "time": null, "date": null, "taskOrMessage": "call me back"}

  Message: "Delete the reminder to drink water"
  JSON: {"intent": "delete_task", "targetName": "you", "time": null, "date": null, "taskOrMessage": "drink water"}

  Now, analyze this message:
  Message: "${userMessage}"
  `;

  const usage = await trackGeminiUsage();
  let finalJSON;

  if (!usage.allowed) {
    // 🚦 LIMIT REACHED: Route directly to OpenAI
    finalJSON = await callOpenAIFallback(prompt, userMessage);
    finalJSON.ai_meta = "🤖 Fallback AI Active";
    return finalJSON;
  }

  // 2. We have quota! Try Gemini 2.5
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
    const result = await model.generateContent(prompt);
    let text = result.response.text();
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    
   finalJSON = JSON.parse(jsonMatch[0]);
    finalJSON.ai_meta = `⚡ ${usage.remaining} Gemini requests left`;
    return finalJSON;
    
  } catch (error) {
    console.error("Gemini crashed, falling back:", error.message);
   // 🚦 GEMINI CRASHED: Route to OpenAI as safety net
    finalJSON = await callOpenAIFallback(prompt, userMessage);
    finalJSON.ai_meta = "🤖 Fallback AI Active (Gemini Error)";
    return finalJSON;
  }
}

module.exports = { analyzeMessage };