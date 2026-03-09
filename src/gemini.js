const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai");
const { getUsage, track, LIMITS } = require("./usage");
require("dotenv").config();

// 🧠 Primary Brains: Google Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Tier 1: Gemini 3 Flash Preview
const gemini3Json = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini3Text = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
});

// Tier 2: Gemini 2.5 Flash
const gemini25Json = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini25Text = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Tier 3: Groq (Llama 3.3 — Lightning Fast & Free)
const groqAI = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});

// Tier 4: OpenRouter (Bulletproof Paid Fallback)
const backupAI = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

/**
 * Main AI Router: The 4-Tier Waterfall System
 *
 * Returns:
 *   - Intent requests  (isSummaryRequest=false): parsed JSON object with ai_meta field
 *   - Summary requests (isSummaryRequest=true):  { text: string, ai_meta: string }
 */
async function analyzeMessage(userMessage, isSummaryRequest = false) {
  const usageStats = await getUsage();
  const currentIST = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: false,
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
    "taskOrMessage": "If intent is 'chat', provide your actual helpful/funny response here. For other intents, extract the cleaned task or search query."
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

  Message: "When is Mom's birthday?"
  JSON: {"intent": "query_birthday", "targetName": "Mom", "time": null, "date": null, "taskOrMessage": null}

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

  const promptToSend = isSummaryRequest
    ? `Summarize the following search results concisely in plain text. Do not use JSON formatting:\n\n${userMessage}`
    : systemPrompt + `\nAnalyze: ${userMessage}`;

  // Shared params for OpenAI-compatible APIs (Groq & OpenRouter)
  const openAIMessages = [
    {
      role: "system",
      content: isSummaryRequest
        ? "You are Manvi. Summarize the following search results concisely in plain text."
        : systemPrompt,
    },
    { role: "user", content: userMessage },
  ];

  // ---------------------------------------------------------
  // TIER 1 & 2: GOOGLE GEMINI
  // ---------------------------------------------------------
  let googleResponseText = null;
  let activeBrain = "Gemini 3 Flash";

  if (usageStats.gemini < LIMITS.gemini) {
    try {
      const activeModel = isSummaryRequest ? gemini3Text : gemini3Json;
      const result = await activeModel.generateContent(promptToSend);
      googleResponseText = result.response.text();
    } catch (err3) {
      console.warn("⚠️ Gemini 3 failed. Cascading to Gemini 2.5...");
      try {
        const activeModel = isSummaryRequest ? gemini25Text : gemini25Json;
        const result = await activeModel.generateContent(promptToSend);
        googleResponseText = result.response.text();
        activeBrain = "Gemini 2.5 Flash";
      } catch (err25) {
        console.warn("⚠️ All Google models failed. Cascading to Groq...");
      }
    }
  }

  if (googleResponseText) {
    await track("gemini");
    const remaining = LIMITS.gemini - (usageStats.gemini + 1);
    const ai_meta = `⚡ ${activeBrain} (${remaining} left)`;

    if (isSummaryRequest) return { text: googleResponseText, ai_meta };

    const cleanJSON = googleResponseText.match(/\{[\s\S]*\}/);
    if (!cleanJSON) throw new Error("No JSON found in Google response");

    const parsed = JSON.parse(cleanJSON[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  }

  // ---------------------------------------------------------
  // TIER 3: GROQ (FREE — LLAMA 3.3)
  // ---------------------------------------------------------
  try {
    console.log("⚡ Routing to Groq Free Tier...");
    const response = await groqAI.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("groq");
    const groqText = response.choices[0].message.content;
    const remaining = LIMITS.groq - (usageStats.groq + 1);
    const ai_meta = `🚀 Groq Fast (Llama 3.3 — ${remaining} left)`;

    if (isSummaryRequest) return { text: groqText, ai_meta };

    const jsonMatch = groqText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in Groq response");

    const parsed = JSON.parse(jsonMatch[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (groqErr) {
    console.warn("⚠️ Groq failed. Cascading to OpenRouter...", groqErr.message);
  }

  // ---------------------------------------------------------
  // TIER 4: OPENROUTER (PAID — GPT-4o-mini)
  // ---------------------------------------------------------
  try {
    console.log("🤖 Routing to OpenRouter Premium...");
    const response = await backupAI.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("openrouter");
    const orText = response.choices[0].message.content;
    const ai_meta = `🤖 OpenRouter (GPT-4o-mini)`;

    if (isSummaryRequest) return { text: orText, ai_meta };

    const jsonMatch = orText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in OpenRouter response");

    const parsed = JSON.parse(jsonMatch[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (backupErr) {
    console.error("OpenRouter Fallback Error:", backupErr);
    return {
      intent: "api_error",
      targetName: "you",
      time: null,
      date: null,
      taskOrMessage: "All AI models are offline or limits reached.",
    };
  }
}

module.exports = { analyzeMessage };
