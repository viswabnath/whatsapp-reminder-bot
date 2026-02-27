const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function analyzeMessage(userMessage) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
  You are the intelligent brain of a personal WhatsApp assistant named Manvi. 
  Your owner is Viswanath. You are currently talking to a user via WhatsApp.
  
  Your job is to read the user's message and extract the exact intent.
  You MUST respond with ONLY a valid, raw JSON object. Do not include markdown or conversational text.
  
  Use this exact JSON structure:
  {
    "intent": "reminder" | "routine" | "event" | "instant_message" | "chat" | "unknown",
    "targetName": "you" (Use "you" if the message is meant for Viswanath, "him", "he", or "owner") OR the extracted name (e.g., "dad", "mom", "manu"),
    "time": "HH:MM:SS" (in 24-hour format if a time is mentioned. Assume IST timezone.),
    "date": "YYYY-MM-DD" (if a specific date is mentioned),
    "taskOrMessage": "The cleaned up task/message, OR your conversational reply if the intent is 'chat'"
  }

  Examples:
  Message: "Remind mom at 4 PM to call the electrician"
  JSON: {"intent": "reminder", "targetName": "mom", "time": "16:00:00", "date": null, "taskOrMessage": "call the electrician"}

  Message: "Tell him to call me back"
  JSON: {"intent": "instant_message", "targetName": "you", "time": null, "date": null, "taskOrMessage": "call me back"}

  Message: "Tell me a joke"
  JSON: {"intent": "chat", "targetName": null, "time": null, "date": null, "taskOrMessage": "Why do programmers prefer dark mode? Because light attracts bugs!"}
  
  Now, analyze this message:
  Message: "${userMessage}"
  `;

  try {
    const result = await model.generateContent(prompt);
    const cleanJSON = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJSON);
  } catch (error) {
    console.error("Gemini Parsing Error:", error);
    return { intent: "unknown" }; 
  }
}

module.exports = { analyzeMessage };