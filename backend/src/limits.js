// Rate limits, the daily cap, the result cache and the scan log, all on one KV namespace.
// KV counters are eventually consistent, which is fine for a stand demo: the cap is a ceiling, not an audit.

const day = () => new Date().toISOString().slice(0, 10);
const minute = () => Math.floor(Date.now() / 60000);

async function bump(store, key, ttl) {
  const cur = parseInt((await store.get(key)) || "0", 10) + 1;
  await store.put(key, String(cur), { expirationTtl: ttl });
  return cur;
}

/** Returns null when allowed, or {status, reason} when refused. */
export async function checkLimits(store, env, deviceId) {
  if ((env.KILL_SWITCH || "off").toLowerCase() === "on") return { status: 503, reason: "scanning paused" };
  const perMin = parseInt(env.PER_DEVICE_PER_MINUTE || "6", 10);
  const perDay = parseInt(env.PER_DEVICE_PER_DAY || "60", 10);
  const cap = parseInt(env.DAILY_SCAN_CAP || "5000", 10);
  const d = day();
  if ((await bump(store, `cap:${d}`, 172800)) > cap) return { status: 503, reason: "daily scan cap reached" };
  if ((await bump(store, `rl:min:${deviceId}:${minute()}`, 120)) > perMin) return { status: 429, reason: "too many scans, wait a minute" };
  if ((await bump(store, `rl:day:${deviceId}:${d}`, 172800)) > perDay) return { status: 429, reason: "daily limit for this device reached" };
  return null;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheGet(store, key) {
  const hit = await store.get(`cache:${key}`, { type: "json" });
  return hit || null;
}
export async function cachePut(store, key, value, ttl) {
  await store.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttl });
}

/** Log a scan: values and grade only, never the image. */
export async function logScan(store, entry, ttl) {
  const id = entry.scan_id;
  await store.put(`log:${day()}:${id}`, JSON.stringify(entry), { expirationTtl: ttl });
}
export async function logCorrection(store, scanId, correction, ttl) {
  await store.put(`corr:${day()}:${scanId}:${Date.now()}`, JSON.stringify(correction), { expirationTtl: ttl });
}
