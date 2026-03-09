const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai");
const { getUsage, track, LIMITS } = require("./usage");
require("dotenv").config();

// 🧠 Primary Brain: Google Gemini Native
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const primaryModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // or 2.5-flash

// 🧠 Backup Brain: OpenRouter
const backupAI = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// --- MAIN ROUTER ---
async function analyzeMessage(userMessage, isSummaryRequest = false) {
  const usageStats = await getUsage();
  const currentIST = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
  });

  const systemPrompt = `
  You are the intelligent brain of a personal WhatsApp assistant named Manvi. 
  Your owner is Viswanath. You are currently talking to a user via WhatsApp.
  
  CRITICAL CONTEXT:
  The current date and time right now is: ${currentIST}. 
  If the user asks for a relative time like "in 5 minutes", use this current time to calculate the exact HH:MM:SS.
  
  Your job is to read the user's message and extract the exact intent.
  You MUST respond with ONLY a valid, raw JSON object. Do not include markdown or conversational text.
  
  Use this exact JSON structure:
  {
    "intent": "reminder" | "routine" | "event" | "instant_message" | "chat" | "query_birthday" | "query_schedule" | "query_routines" | "query_contacts" | "query_reminders" | "query_events" | "delete_task" | "web_search" | "unknown",
    "targetName": "you" (Use "you" if the message is meant for Viswanath, "him", "he", or "owner") OR the extracted name,
    "time": "HH:MM:SS" (in 24-hour format if a time is mentioned/calculated. Assume IST timezone.),
    "date": "YYYY-MM-DD" (if a specific date is mentioned/calculated for queries or events),
    "taskOrMessage": "The cleaned up task/message. For deletions, extract what needs to be deleted. For web_search, extract the optimized search query."
  }

  Examples:
  Message: "What was the recent f1 grand prix held, where and who won it?"
  JSON: {"intent": "web_search", "targetName": "you", "time": null, "date": null, "taskOrMessage": "recent f1 grand prix winner and location"}

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

  // --- 1. TRY PRIMARY (GEMINI DIRECT) ---
  if (usageStats.gemini < LIMITS.gemini) {
    try {
      const promptToSend = isSummaryRequest
        ? userMessage
        : systemPrompt + `\nAnalyze: ${userMessage}`;
      const result = await primaryModel.generateContent(promptToSend);
      const responseText = result.response.text();

      await track("gemini");

      if (isSummaryRequest) return responseText;

      const cleanJSON = responseText.match(/\{[\s\S]*\}/);
      if (!cleanJSON) throw new Error("No JSON found");

      const parsed = JSON.parse(cleanJSON[0]);
      parsed.ai_meta = `⚡ ${LIMITS.gemini - usageStats.gemini - 1} Gemini left`;
      return parsed;
    } catch (err) {
      console.warn(
        "⚠️ Gemini failed, falling back to OpenRouter...",
        err.message,
      );
    }
  }

  // --- 2. TRY BACKUP (OPENROUTER) ---
  if (usageStats.openrouter < LIMITS.openrouter) {
    try {
      console.log("🔄 Routing to OpenRouter Fallback...");
      const response = await backupAI.chat.completions.create({
        model: "google/gemini-2.0-flash:free",
        messages: [
          {
            role: "system",
            content: isSummaryRequest
              ? "You are Manvi. Summarize the following data concisely."
              : systemPrompt,
          },
          { role: "user", content: userMessage },
        ],
      });

      await track("openrouter");
      const backupText = response.choices[0].message.content;

      if (isSummaryRequest) return backupText;

      const jsonMatch = backupText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found");

      const parsedBackup = JSON.parse(jsonMatch[0]);
      parsedBackup.ai_meta = `🤖 ${LIMITS.openrouter - usageStats.openrouter - 1} OpenRouter left`;
      return parsedBackup;
    } catch (backupErr) {
      console.error("OpenAI Fallback Error:", backupErr);
      return {
        intent: "api_error",
        targetName: "you",
        time: null,
        date: null,
        taskOrMessage: "All AI models are offline or limits reached.",
      };
    }
  }

  return {
    intent: "api_error",
    targetName: "you",
    time: null,
    date: null,
    taskOrMessage: "Daily AI limits reached. Check /limit.",
  };
}

module.exports = { analyzeMessage };
