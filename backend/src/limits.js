// Rate limits, the daily cap, the result cache and the scan log, all on one KV namespace.
// KV counters are eventually consistent, which is fine for a stand demo: the cap is a ceiling, not an audit.
//
// The store itself has limits (one write a second to the same key; on the free plan a number of writes a day), and a
// write it refuses throws. No such refusal may cost a visitor a label that was already read: the cache and the log
// are written on a best-effort basis, and a counter that cannot be written is tried once more a second later.

const day = () => new Date().toISOString().slice(0, 10);
const minute = () => Math.floor(Date.now() / 60000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bump(store, key, ttl) {
  const cur = parseInt((await store.get(key)) || "0", 10) + 1;
  await store.put(key, String(cur), { expirationTtl: ttl });
  return cur;
}
/** Count, and if the store refuses the write (two requests on one key in the same second), wait and count once more.
 *  A photo takes 5 to 30 seconds to read, so the wait is not felt. Throws if the second try is refused too. */
async function bumpPatiently(store, key, ttl, waitMs) {
  try { return await bump(store, key, ttl); }
  catch { await sleep(waitMs); return bump(store, key, ttl); }
}

/** Returns null when allowed, or {status, reason} when refused.
 *  kind "scan": a photo sent to the reader (the cost). kind "correct": the visitor's answer to a question, or a corrected
 *  value. A correction calls no reader, so it has its own, looser per-minute counter and does not use up the scan
 *  allowance: a label that was read and paid for can always be finished. */
export async function checkLimits(store, env, deviceId, kind = "scan") {
  if ((env.KILL_SWITCH || "off").toLowerCase() === "on") return { status: 503, reason: "scanning paused" };
  const waitMs = parseInt(env.COUNTER_RETRY_MS || "1100", 10);
  if (kind === "correct") {
    const perMinute = parseInt(env.CORRECTIONS_PER_MINUTE || "30", 10);
    let count = 0;
    try { count = await bump(store, `rl:cmin:${deviceId}:${minute()}`, 120); } catch { /* an answer costs nothing: a count that cannot be written is let go */ }
    return count > perMinute ? { status: 429, reason: "too many corrections, wait a minute" } : null;
  }
  const perMin = parseInt(env.PER_DEVICE_PER_MINUTE || "6", 10);
  const perDay = parseInt(env.PER_DEVICE_PER_DAY || "60", 10);
  const cap = parseInt(env.DAILY_SCAN_CAP || "5000", 10);
  const d = day();
  try {
    // The per-address limits come first: a scan they refuse is not read, and must not use up the daily cap that every
    // other visitor shares.
    if ((await bumpPatiently(store, `rl:min:${deviceId}:${minute()}`, 120, waitMs)) > perMin) return { status: 429, reason: "too many scans, wait a minute" };
    if ((await bumpPatiently(store, `rl:day:${deviceId}:${d}`, 172800, waitMs)) > perDay) return { status: 429, reason: "daily limit for this device reached" };
    if ((await bumpPatiently(store, `cap:${d}`, 172800, waitMs)) > cap) return { status: 503, reason: "daily scan cap reached" };
  } catch {
    // A counter could not be written even on the second try. The counters guard the cost of the reader, so the scan is
    // not made; the page is told to try again, not that the service is down.
    return { status: 429, reason: "busy, try again in a moment" };
  }
  return null;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// The version is part of the key: a grade stored by an earlier version of the checks is never served by a later one.
const CACHE_VERSION = "v2";
export async function cacheGet(store, key) {
  try {
    const hit = await store.get(`cache:${CACHE_VERSION}:${key}`, { type: "json" });
    return hit || null;
  } catch { return null; }   // no cache answer: the photo is read
}
export async function cachePut(store, key, value, ttl) {
  try { await store.put(`cache:${CACHE_VERSION}:${key}`, JSON.stringify(value), { expirationTtl: ttl }); } catch { /* a result that cannot be cached is still a result */ }
}

/** Log a scan: values and grade only, never the image. A log line that cannot be written does not fail the scan. */
export async function logScan(store, entry, ttl) {
  const id = entry.scan_id;
  try { await store.put(`log:${day()}:${id}`, JSON.stringify(entry), { expirationTtl: ttl }); } catch { /* best effort */ }
}
export async function logCorrection(store, scanId, correction, ttl) {
  try { await store.put(`corr:${day()}:${scanId}:${Date.now()}`, JSON.stringify(correction), { expirationTtl: ttl }); } catch { /* best effort */ }
}
