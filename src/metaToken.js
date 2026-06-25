const supabase = require("./supabase");

// In-memory cache — avoids a DB read on every message send
let _cache = { token: null, expiresAt: 0 };

// How many days before expiry to trigger a refresh
const REFRESH_BEFORE_DAYS = 10;

async function getAccessToken() {
  // Return cached token if it's not close to expiry
  if (_cache.token && Date.now() < _cache.expiresAt - REFRESH_BEFORE_DAYS * 86400 * 1000) {
    return _cache.token;
  }

  const { data } = await supabase
    .from("config")
    .select("value, expires_at")
    .eq("key", "meta_access_token")
    .single();

  if (data?.value) {
    _cache = { token: data.value, expiresAt: new Date(data.expires_at).getTime() };
    return data.value;
  }

  // Fallback to env var (used before first DB seed or if table doesn't exist)
  return process.env.ACCESS_TOKEN;
}

async function refreshAccessTokenIfNeeded() {
  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    console.warn("[token] META_APP_ID or META_APP_SECRET not set — skipping auto-refresh");
    return;
  }

  const { data } = await supabase
    .from("config")
    .select("value, expires_at")
    .eq("key", "meta_access_token")
    .single();

  if (!data) {
    console.warn("[token] No meta_access_token row in config table — skipping auto-refresh");
    return;
  }

  const expiresAt  = new Date(data.expires_at).getTime();
  const daysLeft   = (expiresAt - Date.now()) / (86400 * 1000);

  if (daysLeft > REFRESH_BEFORE_DAYS) return; // Nothing to do yet

  console.log(`[token] Access token expires in ${daysLeft.toFixed(1)} days — refreshing now`);

  try {
    const url = `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${appId}` +
      `&client_secret=${appSecret}` +
      `&fb_exchange_token=${encodeURIComponent(data.value)}`;

    const res  = await fetch(url);
    const json = await res.json();

    if (!json.access_token) {
      console.error("[token] Refresh failed — Meta response:", JSON.stringify(json));
      return;
    }

    const newExpiry = new Date(Date.now() + json.expires_in * 1000).toISOString();
    await supabase.from("config").upsert({
      key:        "meta_access_token",
      value:      json.access_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });

    _cache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    console.log(`[token] Access token refreshed successfully. New expiry: ${newExpiry}`);
  } catch (err) {
    console.error("[token] Refresh error:", err.message);
  }
}

module.exports = { getAccessToken, refreshAccessTokenIfNeeded };
