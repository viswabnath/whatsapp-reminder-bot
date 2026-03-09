const axios = require("axios");
const { track } = require("./usage");

async function searchWeb(query) {
  // 1. Tavily Priority (Monthly)
  try {
    const res = await axios.post("https://api.tavily.com/search", {
      api_key: process.env.TAVILY_API_KEY, query, max_results: 5
    });
    await track("tavily");
    return { source: "Tavily", data: res.data.results.map(r => r.content).join("\n") };
  } catch (e) {
    // 2. Serper Fallback (Lifetime)
    try {
      const res = await axios.post("https://google.serper.dev/search", { q: query }, {
        headers: { "X-API-KEY": process.env.SERPER_API_KEY }
      });
      await track("serper");
      return { source: "Serper", data: res.data.organic.map(r => r.snippet).join("\n") };
    } catch (e2) {
      return null;
    }
  }
}

module.exports = { searchWeb };