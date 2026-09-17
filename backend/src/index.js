// Nutri-Mark scan backend. Cloudflare Worker.
// POST /scan     { image_base64, media_type, device_id }  -> reading, checks, grade
// POST /correct  { scan_id, category?, values? }          -> re-graded result, correction logged
// GET  /health
//
// The page holds no keys. This worker holds them as secrets and talks to the readers.

import rules from "../../engine/rules.json";
import { computeGrade, reasons } from "../../engine/nutrimark.js";
import { readWithClaude, readWithGemini } from "./reader.js";
import { toPer100, consistencyChecks, route, toEngineInput } from "./checks.js";
import { checkLimits, sha256Hex, cacheGet, cachePut, logScan, logCorrection } from "./limits.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function cors(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

function grade(reading, per100) {
  const { input, flags } = toEngineInput(reading, per100);
  const result = computeGrade(rules, input);
  return { result, flags, input, reasons: result.ok ? reasons(result) : [] };
}

async function readOnce(env, imageBase64, mediaType, model, hint, effort) {
  const timeoutMs = parseInt(env.READER_TIMEOUT_MS || "20000", 10);
  try {
    return await readWithClaude({ apiKey: env.ANTHROPIC_API_KEY, model, imageBase64, mediaType, timeoutMs, effort, hint });
  } catch (err) {
    if (!env.GOOGLE_API_KEY) throw err;
    const fallback = await readWithGemini({ apiKey: env.GOOGLE_API_KEY, model: env.GEMINI_MODEL || "gemini-2.5-flash", imageBase64, mediaType, timeoutMs });
    fallback.fallback_from = `${model}: ${err.message}`;
    return fallback;
  }
}

async function handleScan(request, env) {
  const headers = cors(env, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "expected JSON body" }, 400, headers); }
  const { image_base64, media_type, device_id } = body || {};
  if (!image_base64 || !ALLOWED_TYPES.has(media_type)) return json({ error: "image_base64 and a jpeg/png/webp media_type are required" }, 400, headers);
  if (image_base64.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "image too large" }, 413, headers);
  const device = (device_id || request.headers.get("CF-Connecting-IP") || "anon").slice(0, 64);

  const refused = await checkLimits(env.STORE, env, device);
  if (refused) return json({ error: refused.reason }, refused.status, headers);

  const bytes = Uint8Array.from(atob(image_base64), c => c.charCodeAt(0));
  const key = await sha256Hex(bytes);
  const cached = await cacheGet(env.STORE, key);
  if (cached) return json({ ...cached, cached: true }, 200, headers);

  const scan_id = crypto.randomUUID();
  const primary = env.PRIMARY_MODEL || "claude-sonnet-5";
  const second = env.SECOND_PASS_MODEL || "claude-opus-5";

  let attempt = 1, read, passes = [];
  read = await readOnce(env, image_base64, media_type, primary, "", "medium");
  let per100 = toPer100(read.reading.values, read.reading.basis, read.reading.serving_size);
  let checks = per100 ? consistencyChecks(per100) : [{ code: "basis_unclear", severity: "block", message: "could not put the values on a per-100 basis" }];
  let decision = route(read.reading, checks, { attempt });
  passes.push({ provider: read.provider, model: read.model, usage: read.usage, decision, fallback_from: read.fallback_from });

  if (decision.action === "second_pass") {
    attempt = 2;
    const hint = `A first read was uncertain about: ${decision.reasons.join(", ")}. Read the table again with care and report null for anything not printed.`;
    read = await readOnce(env, image_base64, media_type, second, hint, "high");
    per100 = toPer100(read.reading.values, read.reading.basis, read.reading.serving_size);
    checks = per100 ? consistencyChecks(per100) : [{ code: "basis_unclear", severity: "block", message: "could not put the values on a per-100 basis" }];
    decision = route(read.reading, checks, { attempt });
    passes.push({ provider: read.provider, model: read.model, usage: read.usage, decision, fallback_from: read.fallback_from });
  }

  const out = { scan_id, reading: read.reading, per100, checks, decision, passes };
  if (decision.action === "grade") {
    const g = grade(read.reading, per100);
    Object.assign(out, { grade: g.result, reasons: g.reasons, flags: g.flags, engine_input: g.input });
    await cachePut(env.STORE, key, out, parseInt(env.CACHE_TTL_SECONDS || "604800", 10));
  }
  await logScan(env.STORE, {
    scan_id, ts: new Date().toISOString(), device, category: read.reading.category, basis: read.reading.basis,
    per100, grade: out.grade?.grade ?? null, score: out.grade?.score ?? null, decision: decision.action, reasons: decision.reasons,
    passes: passes.map(p => ({ model: p.model, provider: p.provider, usage: p.usage })),
  }, parseInt(env.LOG_TTL_SECONDS || "2592000", 10));
  return json(out, 200, headers);
}

async function handleCorrect(request, env) {
  const headers = cors(env, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "expected JSON body" }, 400, headers); }
  const { scan_id, reading, category, values } = body || {};
  if (!scan_id || !reading) return json({ error: "scan_id and the reading to correct are required" }, 400, headers);
  const corrected = { ...reading, category: category || reading.category, values: { ...reading.values, ...(values || {}) } };
  const per100 = toPer100(corrected.values, corrected.basis, corrected.serving_size);
  if (!per100) return json({ error: "basis still unclear" }, 400, headers);
  const g = grade(corrected, per100);
  await logCorrection(env.STORE, scan_id, { ts: new Date().toISOString(), category, values, grade: g.result.grade ?? null }, parseInt(env.LOG_TTL_SECONDS || "2592000", 10));
  return json({ scan_id, reading: corrected, per100, grade: g.result, reasons: g.reasons, flags: g.flags, corrected: true }, 200, headers);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, request) });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, rules: rules.source.slice(0, 60), kill_switch: env.KILL_SWITCH || "off" }, 200, cors(env, request));
    if (request.method === "POST" && url.pathname === "/scan") return handleScan(request, env);
    if (request.method === "POST" && url.pathname === "/correct") return handleCorrect(request, env);
    return json({ error: "not found" }, 404, cors(env, request));
  },
};
