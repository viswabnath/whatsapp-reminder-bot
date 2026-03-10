const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai");
const { getUsage, track, LIMITS } = require("./usage");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Tier 1: Gemini 3 Flash Preview
const gemini3Json = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini3Text = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

// Tier 2: Gemini 2.5 Flash
const gemini25Json = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini25Text = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Tier 3: Groq — Llama 3.3 (free)
const groqAI = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});

// Tier 4: OpenRouter — GPT-4o-mini (paid fallback)
const backupAI = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

/**
 * 4-Tier AI Waterfall Router
 *
 * Intent requests  (isSummaryRequest=false): returns parsed JSON with ai_meta field
 * Summary requests (isSummaryRequest=true):  returns { text: string, ai_meta: string }
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
  The current date and time is: ${currentIST}.
  If the user provides a relative time like "in 5 minutes", calculate the exact HH:MM:SS from this reference.

  Your job is to extract the user's intent and return a JSON object.
  Respond with ONLY a valid raw JSON object. No markdown. No explanation.

  IMPORTANT RULES:
- "event": Use ONLY when the user is ASKING TO SAVE or ADD a new birthday, anniversary, or special date to the database. Do NOT use this if the user explicitly asks to be "reminded" of something. 
- "query_birthday": Use ONLY when the user is ASKING FOR INFORMATION about an existing birthday (e.g., 'When is Manu's birthday?'). Do NOT use this if they are trying to save a date.
- "instant_message": Use to forward messages.
- "routine" intent is ONLY for daily recurring tasks at a fixed time (e.g., "every day at 9 AM"). NOT for interval-based reminders like "every 5 minutes" or "every hour". Interval requests should be classified as "chat" with a polite explanation that only daily fixed-time routines are supported.
- "delete_task" intent: extract ONLY the core task name. Strip words like "routine", "reminder", "task", "event" from taskOrMessage. Example: "Delete Drink Water routine" → taskOrMessage: "Drink Water".
- "reminder" intent: Use whenever the user explicitly asks to be "reminded" of something, even if it includes a future date or special occasion. taskOrMessage must be the actual task description. If the user says "remind me in X minutes" with no task specified, use "reminder" as taskOrMessage.
- Vague queries like "list all", "show everything", "what do you have" should be classified as "chat" with taskOrMessage explaining what Manvi can list (reminders, routines, events, contacts).

  JSON structure:
  {
  "intent": "reminder" | "routine" | "event" | "instant_message" | "chat" | "query_birthday" | "query_schedule" | "query_routines" | "query_contacts" | "query_reminders" | "query_events" | "delete_task" | "save_contact" | "web_search" | "unknown",
  "targetName": "you" (if message is for Viswanath, "him", "he", or "owner") OR the extracted name,
  "time": "HH:MM:SS" (24-hour format, IST timezone, or null),
  "date": "YYYY-MM-DD" (if a date is mentioned or calculable, or null),
  "taskOrMessage": "For chat intent: provide a direct response. For save_contact: the extracted name. For all others: extract the task or search query.",
  "phone": "digits only for save_contact (no spaces, no +, no dashes), null for all others"
}

  Examples:
  Message: "What was the recent F1 grand prix and who won?"
  JSON: {"intent": "web_search", "targetName": "you", "time": null, "date": null, "taskOrMessage": "recent F1 grand prix winner and location"}

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
  JSON: {"intent": "chat", "targetName": null, "time": null, "date": null, "taskOrMessage": "Why do programmers prefer dark mode? Because light attracts bugs."}

  Message: "Tell him to call me back"
  JSON: {"intent": "instant_message", "targetName": "you", "time": null, "date": null, "taskOrMessage": "call me back"}

  Message: "Delete the reminder to drink water"
  JSON: {"intent": "delete_task", "targetName": "you", "time": null, "date": null, "taskOrMessage": "drink water", "phone": null}

  Message: "Save Manu as 919876543210"
  JSON: {"intent": "save_contact", "targetName": "Manu", "time": null, "date": null, "taskOrMessage": "Manu", "phone": "919876543210"}

  Message: "Add Dad to contacts, his number is 91 98765 43210"
  JSON: {"intent": "save_contact", "targetName": "Dad", "time": null, "date": null, "taskOrMessage": "Dad", "phone": "919876543210"}

  Message: "${userMessage}"
  `;

  const promptToSend = isSummaryRequest
    ? `Summarize the following search results concisely in plain text. No JSON, no markdown:\n\n${userMessage}`
    : systemPrompt;

  const openAIMessages = [
    {
      role: "system",
      content: isSummaryRequest
        ? "You are Manvi. Summarize search results concisely in plain text."
        : systemPrompt,
    },
    { role: "user", content: userMessage },
  ];

  // --- TIER 1 & 2: GOOGLE GEMINI ---
  let googleResponseText = null;
  let activeBrain = "Gemini 3 Flash";

  if (usageStats.gemini < LIMITS.gemini) {
    try {
      const model = isSummaryRequest ? gemini3Text : gemini3Json;
      const result = await model.generateContent(promptToSend);
      googleResponseText = result.response.text();
    } catch {
      console.warn("[gemini] Tier 1 failed, cascading to Tier 2");
      try {
        const model = isSummaryRequest ? gemini25Text : gemini25Json;
        const result = await model.generateContent(promptToSend);
        googleResponseText = result.response.text();
        activeBrain = "Gemini 2.5 Flash";
      } catch {
        console.warn("[gemini] Tier 2 failed, cascading to Groq");
      }
    }
  }

  if (googleResponseText) {
    await track("gemini");
    const remaining = LIMITS.gemini - (usageStats.gemini + 1);
    const ai_meta = `${activeBrain} — ${remaining} remaining`;

    if (isSummaryRequest) return { text: googleResponseText, ai_meta };

    const match = googleResponseText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Gemini response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  }

  // --- TIER 3: GROQ (FREE — LLAMA 3.3) ---
  try {
    console.log("[groq] Routing to Tier 3");
    const response = await groqAI.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("groq");
    const text = response.choices[0].message.content;
    const remaining = LIMITS.groq - (usageStats.groq + 1);
    const ai_meta = `Groq Llama 3.3 — ${remaining} remaining`;

    if (isSummaryRequest) return { text, ai_meta };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Groq response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (err) {
    console.warn("[groq] Tier 3 failed, cascading to OpenRouter:", err.message);
  }

  // --- TIER 4: OPENROUTER (PAID — GPT-4o-mini) ---
  try {
    console.log("[openrouter] Routing to Tier 4");
    const response = await backupAI.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("openrouter");
    const text = response.choices[0].message.content;
    const ai_meta = `OpenRouter GPT-4o-mini`;

    if (isSummaryRequest) return { text, ai_meta };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in OpenRouter response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (err) {
    console.error("[openrouter] All tiers exhausted:", err.message);
    await track("error");
    return {
      intent: "api_error",
      targetName: "you",
      time: null,
      date: null,
      taskOrMessage: "All AI models are currently offline or daily limits have been reached.",
    };
  }
}

module.exports = { analyzeMessage };