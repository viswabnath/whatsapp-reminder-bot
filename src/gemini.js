const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeMessage(userMessage) {
  // 1. Force the AI into strict JSON mode with a LIVING model
  const model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash", 
    generationConfig: { responseMimeType: "application/json" }
  });
  
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

  try {
    const result = await model.generateContent(prompt);
    let text = result.response.text();
    
    // 2. Aggressively extract ONLY the JSON block (ignoring any polite filler text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in AI response.");
    }
    
    return JSON.parse(jsonMatch[0]);
    
  } catch (error) {
    console.error("Gemini Parsing Error:", error);
    if (error.message && (error.message.includes("429") || error.message.includes("quota") || error.message.includes("Too Many Requests"))) {
      return { intent: "error_quota" };
    }
    return { intent: "unknown" }; 
  }
}

module.exports = { analyzeMessage };