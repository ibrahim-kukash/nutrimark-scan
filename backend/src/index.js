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

// Try each Claude model in the chain, then the other provider. The first reader that answers wins.
// An overall budget bounds the wait: a visitor never waits for three full timeouts in a row.
async function readOnce(env, imageBase64, mediaType, models, hint, effort, budgetMs = 45000) {
  const perTry = parseInt(env.READER_TIMEOUT_MS || "30000", 10);
  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);
  const errors = [];
  if (env.ANTHROPIC_API_KEY) {
    for (const model of models) {
      if (remaining() < 5000) break;
      const timeoutMs = Math.min(perTry, remaining());
      try {
        const r = await readWithClaude({ apiKey: env.ANTHROPIC_API_KEY, model, imageBase64, mediaType, timeoutMs, effort, hint });
        if (errors.length) r.fallback_from = errors.join(" | ");
        return r;
      } catch (err) { errors.push(`${model}: ${String(err.message || err).slice(0, 120)}`); }
    }
  }
  if (env.GOOGLE_API_KEY && remaining() >= 5000) {
    try {
      const timeoutMs = Math.min(perTry, remaining());
      const r = await readWithGemini({ apiKey: env.GOOGLE_API_KEY, model: env.GEMINI_MODEL || "unset", imageBase64, mediaType, timeoutMs });
      if (errors.length) r.fallback_from = errors.join(" | ");
      return r;
    } catch (err) { errors.push(`gemini: ${String(err.message || err).slice(0, 120)}`); }
  }
  throw new Error(errors.join(" | ") || "no reader configured");
}

async function handleScan(request, env) {
  const headers = cors(env, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "expected JSON body" }, 400, headers); }
  const { image_base64, media_type, device_id } = body || {};
  if (!image_base64 || !ALLOWED_TYPES.has(media_type)) return json({ error: "image_base64 and a jpeg/png/webp media_type are required" }, 400, headers);
  if (image_base64.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "image too large" }, 413, headers);
  const ip = request.headers.get("CF-Connecting-IP") || "noip";
  const device = `${ip}|${String(device_id || "anon").slice(0, 40)}`;   // limits bind on the network address, not only on a value the caller picks

  const refused = await checkLimits(env.STORE, env, ip);
  if (refused) return json({ error: refused.reason }, refused.status, headers);

  const bytes = Uint8Array.from(atob(image_base64), c => c.charCodeAt(0));
  const key = await sha256Hex(bytes);
  const cached = await cacheGet(env.STORE, key);
  if (cached) return json({ ...cached, cached: true }, 200, headers);

  const scan_id = crypto.randomUUID();
  const primary = env.PRIMARY_MODEL || "claude-sonnet-5";
  const second = env.SECOND_PASS_MODEL || "claude-opus-5";

  if (!env.ANTHROPIC_API_KEY && !env.GOOGLE_API_KEY) return json({ error: "no reader configured" }, 503, headers);

  let attempt = 1, read, passes = [];
  try {
    // extraction, not reasoning: low effort keeps the first read fast; the second model backs it up
    read = await readOnce(env, image_base64, media_type, [primary, second], "", "low");
  } catch (err) {
    // Every failed read leaves a log line, so a visitor's "could not read" can be traced to its cause afterwards.
    const detail = String(err.message || err).slice(0, 300);
    const declined = /\b403\b|forbidden|declined/i.test(detail);   // the provider refused this image, the service itself is up
    await logScan(env.STORE, { scan_id, ts: new Date().toISOString(), device, decision: declined ? "reader_declined" : "reader_unavailable", error: detail, passes: [] },
                  parseInt(env.LOG_TTL_SECONDS || "2592000", 10));
    if (declined) return json({ scan_id, decision: { action: "retake", reasons: ["reader_declined"] }, passes: [{ error: detail }] }, 200, headers);
    return json({ error: "reader unavailable", detail }, 502, headers);
  }
  let per100 = toPer100(read.reading.values, read.reading.basis, read.reading.serving_size);
  let checks = per100 ? consistencyChecks(per100) : [{ code: "basis_unclear", severity: "block", message: "could not put the values on a per-100 basis" }];
  let decision = route(read.reading, checks, { attempt });
  passes.push({ provider: read.provider, model: read.model, usage: read.usage, decision, fallback_from: read.fallback_from });

  if (decision.action === "second_pass") {
    attempt = 2;
    const hint = `A first read was uncertain about: ${decision.reasons.join(", ")}. Read the table again with care and report null for anything not printed.`;
    try {
      read = await readOnce(env, image_base64, media_type, [second], hint, "high", 35000);
    } catch (err) {
      passes.push({ model: second, error: String(err.message || err).slice(0, 200) });
      decision = { action: "retake", reasons: [...decision.reasons, "second_pass_failed"] };
    }
    per100 = toPer100(read.reading.values, read.reading.basis, read.reading.serving_size);
    checks = per100 ? consistencyChecks(per100) : [{ code: "basis_unclear", severity: "block", message: "could not put the values on a per-100 basis" }];
    decision = route(read.reading, checks, { attempt });
    passes.push({ provider: read.provider, model: read.model, usage: read.usage, decision, fallback_from: read.fallback_from });
  }

  const out = { scan_id, reading: read.reading, per100, checks, decision, passes };
  if (decision.action === "grade") {
    const g = grade(read.reading, per100 || {});   // plain water has no table: empty values, the engine grades it A
    Object.assign(out, { grade: g.result, reasons: g.reasons, flags: g.flags, engine_input: g.input });
    await cachePut(env.STORE, key, out, parseInt(env.CACHE_TTL_SECONDS || "604800", 10));
  }
  await logScan(env.STORE, {
    scan_id, ts: new Date().toISOString(), device, category: read.reading.category, basis: read.reading.basis,
    product: read.reading.product_name, language: read.reading.label_language, confidence: read.reading.confidence,
    reader_notes: String(read.reading.notes || "").slice(0, 300), category_reason: String(read.reading.category_reason || "").slice(0, 200),
    per100, grade: out.grade?.grade ?? null, score: out.grade?.score ?? null, decision: decision.action, reasons: decision.reasons,
    passes: passes.map(p => ({ model: p.model, provider: p.provider, usage: p.usage })),
  }, parseInt(env.LOG_TTL_SECONDS || "2592000", 10));
  return json(out, 200, headers);
}

async function handleCorrect(request, env) {
  const headers = cors(env, request);
  let body;
  try { body = await request.json(); } catch { return json({ error: "expected JSON body" }, 400, headers); }
  const { scan_id, reading, category, values, device_id } = body || {};
  if (!scan_id || typeof scan_id !== "string" || scan_id.length > 64 || !reading || typeof reading !== "object") return json({ error: "scan_id and the reading to correct are required" }, 400, headers);
  const ip = request.headers.get("CF-Connecting-IP") || "noip";
  const refused = await checkLimits(env.STORE, env, ip);
  if (refused) return json({ error: refused.reason }, refused.status, headers);
  if (category && !rules.categories[category]) return json({ error: "unknown category" }, 400, headers);
  const cleanValues = {};
  for (const [k, v] of Object.entries(values || {})) { if (k in (reading.values || {}) && typeof v === "number" && Number.isFinite(v) && v >= 0) cleanValues[k] = v; }
  const corrected = { ...reading, category: category || reading.category, values: { ...reading.values, ...cleanValues } };
  const per100 = toPer100(corrected.values, corrected.basis, corrected.serving_size);
  if (!per100) return json({ error: "basis still unclear" }, 400, headers);
  const blocks = consistencyChecks(per100).filter(c => c.severity === "block");
  if (blocks.length) return json({ error: "values fail consistency checks", checks: blocks }, 400, headers);
  const g = grade(corrected, per100);
  if (!g.result.ok) return json({ error: g.result.error || "cannot grade", missing: g.result.missing }, 400, headers);
  await logCorrection(env.STORE, scan_id, { ts: new Date().toISOString(), category, values, grade: g.result.grade ?? null }, parseInt(env.LOG_TTL_SECONDS || "2592000", 10));
  return json({ scan_id, reading: corrected, per100, grade: g.result, reasons: g.reasons, flags: g.flags, corrected: true }, 200, headers);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Never a bare 500: the browser needs the CORS headers to show the page's own error message.
      return json({ error: "request failed", detail: String(err.message || err).slice(0, 160) }, err.name === "InvalidCharacterError" ? 400 : 500, cors(env, request));
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, request) });
    if (request.method === "GET" && url.pathname === "/health") return json({
      ok: true, rules: rules.source.slice(0, 60), kill_switch: env.KILL_SWITCH || "off",
      readers: { anthropic: !!(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 20), google: !!(env.GOOGLE_API_KEY && env.GOOGLE_API_KEY.length > 20) },
    }, 200, cors(env, request));
    if (request.method === "GET" && url.pathname === "/gemini-models") {
      // Names only, so the fallback model is chosen from what the key can actually call, never from memory.
      if (!env.GOOGLE_API_KEY) return json({ error: "no Google key configured" }, 503, cors(env, request));
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GOOGLE_API_KEY } });
      if (!r.ok) return json({ error: `Google API HTTP ${r.status}` }, 502, cors(env, request));
      const data = await r.json();
      const models = (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => ({ name: m.name.replace("models/", ""), display: m.displayName, input_tokens: m.inputTokenLimit }));
      return json({ configured: env.GEMINI_MODEL, available: models }, 200, cors(env, request));
    }
    if (request.method === "POST" && url.pathname === "/scan") return handleScan(request, env);
    if (request.method === "POST" && url.pathname === "/correct") return handleCorrect(request, env);
    return json({ error: "not found" }, 404, cors(env, request));
}
