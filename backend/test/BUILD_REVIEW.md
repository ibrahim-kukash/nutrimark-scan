# Nutri-Mark demo — adversarial build review

**Reviewed:** `docs/app.html` sha256 `fb2b4b303e15473e71b463c18eca24a03392a36c6981df19ce04cb6686232025`, 32,908 bytes, mtime 2026-09-17 06:32:27 +0400.
The deployed copy at `https://ibrahim-kukash.github.io/nutrimark-scan/app.html` is **byte-identical** to the local file (diff empty), so everything below applies to what a visitor actually loads. Backend reviewed as deployed at `https://nutrimark-backend.dcl-ibrahim.workers.dev`.

The file changed during the review (the `noTable` branch at app.html:312-317 appeared at 06:32). Findings are against the hash above.

**Method.** Unit tests run, 22 live HTTP probes against the deployed Worker, images built with PIL, module semantics proved in Node. I could not render the page: the Chrome extension reports "Browser extension is not connected" and the Playwright MCP server timed out after 30 s. Every claim below is tagged **[measured]** or **[reasoned]**. Nothing about layout or iOS behaviour was rendered, and I say so where it matters.

**Side effects of this review.** I wrote 8 junk keys to the production KV namespace, all with the 30-day TTL: `corr:2026-09-17:REVIEW-PROBE-*`. I also bumped `cap:2026-09-17` roughly 25 times and added 3 cache entries. Nothing needs cleaning up; the TTLs expire it.

---

## 1. Front end

### 1.1 A failed `rules.json` fetch kills the entire page — BLOCKER

`app.html:218` is a top-level await:

```js
const rules = await (await fetch("./engine/rules.json")).json();
```

**[measured]** I reproduced this exactly. I served a copy of the app with `engine/rules.json` returning 404 (port 8889) and ran a module of the same shape under Node:

```
[1] module body starts
[X] module evaluation REJECTED: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
[X] LISTENERS_ATTACHED = undefined  <-- nothing after the await ever ran
```

When that await rejects, module evaluation aborts and **not one line after 218 runs**. No `applyStrings()`, no `playIntro()`, no `addEventListener`. Every visible string in the intro comes from `applyStrings()` filling empty `data-t` elements (`app.html:172,175,255`), so the visitor sees a screen with a coloured A-to-E band, **no headline, no body text, a blank button**, and nothing responds to taps. There is no error message and no retry.

This fires on any venue wifi hiccup and on any captive portal, which returns HTML for a JSON request and produces precisely the SyntaxError above. Exhibition wifi is the normal case, not the edge case.

**Fix:** wrap it, and give the page a visible failure state.
```js
let rules = null;
try { const r = await fetch("./engine/rules.json"); if (r.ok) rules = await r.json(); } catch {}
```
Then gate only the what-if slider on `rules`, since the grade itself comes from the backend. The app does not need `rules.json` to show a grade at all — only `renderWhatIf()` uses it (`app.html:342`). A blocker that costs the whole demo currently gates a slider.

### 1.2 No timeout and no cancel on the scan request — BLOCKER

`app.html:303` calls `fetch` with no `AbortController` and no `signal`. **[measured]** `grep -nE "AbortController|AbortSignal|signal:" docs/app.html` returns nothing.

Meanwhile the backend can legitimately take a very long time. `READER_TIMEOUT_MS` is 30,000 (`wrangler.toml:21`) and the chain is: Sonnet (30 s) → Opus (30 s) → Gemini (30 s), and then on a second pass the whole thing again (`index.js:38-58, 95-108`). Worst case is around three minutes.

While that runs, `cam.classList.add("scanning")` is set and `.scanning .shutter{pointer-events:none}` (`app.html:81`) makes the shutter dead. The visitor stares at "جارٍ قراءة الملصق…" with no way to back out and no progress. **[measured]** my slowest successful scan was 12.6 s; the tiny non-food image took 10.2 s because it triggered a second pass.

**Fix:** `AbortController` with about 25 s, plus a visible cancel on the `#msg` overlay.

### 1.3 An undecodable photo locks the app until reload — BLOCKER

```js
294  async function handlePhoto(file){
295    busy=true; clearTimers(); ...
298    const { dataUrl, base64 } = await shrink(file);
```

`shrink()` (`app.html:282-290`) has no try/catch, and neither does line 298. Its fallback path rejects outright:

```js
284  const img = bmp || await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=URL.createObjectURL(file); });
```

If `createImageBitmap` returns null (the `.catch(()=>null)` on 283) **and** the `<img>` decode fails, the rejection propagates into the `async` change listener at `app.html:280`, which nobody awaits. The result: an unhandled rejection, `busy` stuck at `true` forever, and `$("shutter")` permanently inert because of the `if(!busy)` guard on line 279. The stand attendant has to reload the page. **[reasoned]** from the code; I could not run a browser to trigger it.

Reachable with: a HEIC or DNG the browser will not decode, a truncated photo, a file picked through an Android file manager where `accept="image/*"` still admits odd types.

**Fix:** wrap lines 298-299 in try/catch, set `busy=false`, and show `s.errMsg`.

### 1.4 "as printed on the label" is shown over values that were computed — MUST-FIX

`app.html:326` always prints one of two strings: "القيم لكل 100 غ كما وردت على الملصق" / "Values per 100 g as printed on the label".

**[measured]** live scan of `synthetic_cereal_per_serving_sodium.jpg`:

| what the label prints | what the app displays under "as printed" |
|---|---|
| basis `per_serving`, serving 30 g | per 100 g |
| energy 520 kJ | 1733.3 kJ |
| sodium 60 mg, salt not printed | salt 0.5 g |

Three transformations — rescaling by 100/30, sodium→salt at ×2.5 (`app.html:328`), and a basis change — presented to the visitor as the printed label. On a Dubai Municipality stand that is a credibility problem, not a cosmetic one. The backend already returns `reading.basis` and `reading.serving_size`; the caption should read "converted to 100 g from the 30 g serving printed on the label" when `basis === "per_serving"`, and should mark salt as derived when `salt_g` is null and `sodium_mg` is not.

### 1.5 The what-if slider changes sugar without changing energy — MUST-FIX

`app.html:339`:
```js
function whatIfInput(cut){ const base=current.engine_input; return {...base, sugar_g: round1(base.sugar_g*(1-cut/100))}; }
```

Sugar carries 17 kJ/g in the same rule set the engine uses (`rules.json` energy steps, `checks.js:34`). A maker who removes sugar removes energy with it, and energy is a separate negative component. **[measured]** on the live cereal result (sugar 15 g, energy 1407 kJ), a 40% cut drops sugar to 9 g, which should also drop energy to about 1305 kJ and cross the 1340 step, worth one more negative point. The app holds energy fixed. In this particular case the displayed grade is unaffected (C either way), but the mechanism is wrong and will mislabel a boundary product.

**Fix:** subtract `17 * (base.sugar_g - newSugar)` from `energy_kJ` in `whatIfInput`, or retitle the control so it does not claim to model reformulation.

### 1.6 Verified-correct front-end behaviour

Worth recording, because these are the things that usually break and here they do not.

- **Reasons mapping is complete.** **[measured]** by cross-reading `rules.json` `negative` arrays against `app.html:227,239`. general/cheese/red_meat use `energy_kJ, satfat_g, sugar_g, salt_g`; fats use `energy_from_satfat_kJ, satfat_ratio_pct, sugar_g, salt_g`; beverages add `sweeteners`. All nine distinct keys have Arabic and English strings. No key can fall through to the raw `s[k]||k` fallback on `app.html:337`.
  *One wart:* for a fats product both `satfat_g`-family keys map to near-identical Arabic ("دهون مشبعة مرتفعة" and "نسبة عالية من الدهون المشبعة"), so olive oil shows two bullets that say almost the same thing.
- **No XSS path from model output.** `product_name`, `brand` and `notes` reach the DOM only through `textContent` (`app.html:324-325`). The two `innerHTML` sites (`329`, `337`) interpolate only numbers that passed `isNum` and keys from the static string tables. A package printing `<img onerror=...>` as its product name cannot execute.
- **Prompt injection is handled.** `reader.js:59` ends the system prompt with an explicit instruction to ignore text addressed to the model on the package. That is the right defence and most builds omit it.
- **`media_type` can never be wrong from the app.** `shrink()` always ends in `toDataURL("image/jpeg")` (`app.html:288`), so the hardcoded `media_type:"image/jpeg"` on line 303 is always true regardless of what the camera produced, HEIC included.
- **localStorage failure is handled.** `app.html:251` catches and falls back to a random id, so private browsing and blocked site data do not throw.
- **Engine copies are in sync.** `diff engine/nutrimark.js docs/engine/nutrimark.js` and the same for `rules.json` are both empty, so the client-side what-if and the server-side grade use identical rules.

### 1.7 EXIF orientation — investigated, and it does not matter for the grade

`createImageBitmap(file)` on `app.html:283` is called without `{imageOrientation:"from-image"}`, and `drawImage` on 287 writes whatever bitmap it got. The default differs across browsers and versions, so a photo from a phone held in portrait may well reach the backend rotated 90°. **[reasoned]**, I could not test browser behaviour.

Rather than speculate, I measured the consequence. **[measured]** I rotated `synthetic_cereal_clean.jpg` 90° and scanned it live:

```
ROTATED 90 deg: status=200 7.5s cached=False
  values : {"energy_kJ":1407,"energy_kcal":335,"fat_g":5,"satfat_g":3.5,"carb_g":72,
            "sugar_g":15,"fibre_g":4.5,"protein_g":7,"salt_g":0.5,"sodium_mg":null}
  conf   : all 1.0 except category 0.9
  grade  : D score=11    (upright original: D score=11)
```

Identical reading, full confidence, identical grade. **The reader does not care about rotation.** This downgrades the finding from a correctness risk to cosmetics: only the `#preview` and the `#thumb` (`app.html:299,361`) would look sideways. Adding `{imageOrientation:"from-image"}` is a one-word fix worth making, but it is a **note**, not a must-fix. I had this ranked as a likely high-severity issue before measuring it.

### 1.8 Smaller front-end findings

| # | Finding | Line | Severity |
|---|---|---|---|
| a | Google Fonts stylesheet is render-blocking. On a captive portal or dead DNS the page stays blank until the browser gives up. `preconnect` points at `fonts.googleapis.com` but not `fonts.gstatic.com`, where the font files actually come from. Self-host the font for a stand. | `app.html:9-10` | must-fix |
| b | Demo operator toolbar (Language / Verdict / Label / Scanner) sits **outside** the phone frame, in English, fully tappable by any visitor. Tapping "Scanner" mid-result reflows the whole layout. | `app.html:151-161` | must-fix |
| c | Intro screen has no scroll fallback. Fixed cost is 362 px (padding 62 + `.stage` 280 + two 10 px gaps); text and buttons add roughly 215 px, so about **577 px** is needed against `calc(100dvh - 60px)` available (`app.html:28`). Below roughly 637 CSS px of viewport the "Scan a product" button is clipped by `.phone{overflow:hidden}` and cannot be scrolled to, because `.screen` has no `overflow`. Mainstream phones clear this by about 30 px. **[reasoned]** — text heights are estimated ±20 px and I could not render. Fix is one line: `.screen{overflow:auto}` or make `.stage` shrinkable. | `app.html:28,34,35` | must-fix |
| d | Stuck-screen race. `reset()` adds `.leaving` to `#result` and schedules its removal at 380 ms (`382-389`). `handlePhoto()` calls `clearTimers()` first thing (`295`), killing that pending timer, so `.leaving` is never removed. `showResult()` then un-hides a screen that still has `opacity:0;pointer-events:none`, and line 369 has already hidden `#scan` — **both screens gone, blank phone, reload required**. Needs the shutter tapped within 380 ms of "Scan another", which is only reachable in Scanner look where the shutter sits under the fading sheet. Narrow, but real. Fix: `result.classList.remove("leaving")` at the top of `showResult()`. | `app.html:295,369-370,384` | must-fix |
| e | `URL.createObjectURL(file)` is never revoked on the fallback decode path. One leaked blob URL per scan. | `app.html:284` | note |
| f | Network errors show raw browser text to the visitor: `s.errMsg+" ("+String(err.message).slice(0,80)+")"` puts "Failed to fetch" inside an Arabic sentence. Also `err.message` is `undefined` for a non-Error throw. | `app.html:307` | note |
| g | `await r.json()` runs before the `r.ok` check, so a Cloudflare HTML error page produces a `SyntaxError` shown to the visitor rather than the status. | `app.html:304-305` | note |
| h | `capture="environment"` removes the photo-library option on iOS Safari. Intended for a stand, but it means a visitor cannot use a photo they already took. | `app.html:194` | note |
| i | `reset()` does not clear `photoDataUrl`, so the last photo's data URL is held until the next scan. | `app.html:382` | note |
| j | Between `reset()` and its 380 ms timer, `#result` is fading and `#scan` is still hidden: a brief empty frame. | `app.html:382-389` | note |
| k | No memory or listener leak on repeated scans. All listeners are attached once at module scope (`279,292,393-397`); `clearTimers()` drains the timer array. **[measured]** by reading — this one is clean. | — | ok |

---

## 2. Backend

### 2.1 `/correct` is an unauthenticated, unrate-limited KV write endpoint — BLOCKER

`handleCorrect` (`index.js:126-137`) never calls `checkLimits`. Compare `handleScan`, which calls it on line 69. Every `/correct` call ends in `logCorrection` → `store.put` (`limits.js:45`).

**[measured]** five rapid `/correct` calls, all 200, no throttling:
```
call1: status=200 0.9s   call2: status=200 0.9s   call3: status=200 0.5s
call4: status=200 0.9s   call5: status=200 0.9s
```

Cloudflare KV's free plan allows 1,000 writes per day. A trivial loop against this URL exhausts that quota, and **once KV writes fail, `/scan` fails with it** — `checkLimits` cannot `bump`, `cachePut` cannot store, `logScan` cannot log. One open endpoint takes down the whole demo. There is no authentication of any kind on the Worker.

**Fix:** call `checkLimits` in `handleCorrect` before line 130, and cap `/correct` far tighter than `/scan`.

### 2.2 `/correct` mints official-looking grades from impossible numbers — MUST-FIX

`handleCorrect` takes the entire `reading` from the caller, merges `values`, runs `toPer100`, and goes straight to `grade()`. **`consistencyChecks` is never called and `route` is never called** — compare `handleScan:90-92`, which runs both.

**[measured]** I posted negative sugar, negative saturated fat, negative salt, fibre 9999 and protein 9999:
```
status=200  grade=A score=-17
```

A grade **A** with a Dubai Municipality framing, from a `workers.dev` URL, out of physically impossible input. The response is a clean JSON object anyone can screenshot. For a demo that no visitor touches directly this is low risk; for a public URL attached to a government stand it is the finding I would fix first after 2.1. Running `consistencyChecks(per100)` and refusing on any `block` is four lines.

### 2.3 Uncaught exceptions return 500 with no CORS headers — MUST-FIX

`index.js:72` decodes without a guard:
```js
const bytes = Uint8Array.from(atob(image_base64), c => c.charCodeAt(0));
```

`atob` throws on any invalid character, and nothing catches it. There is no try/catch around the `fetch` handler either (`index.js:139-159`).

**[measured]**, two ways in:
```
### G1 malformed base64 (!!! chars)
    status=500  ACAO='<<MISSING>>'      body: error code: 1101
### G2 data-URL prefix left on ("data:image/jpeg;base64,...")
    status=500  ACAO='<<MISSING>>'      body: error code: 1101
### 3c over-long scan_id (600 chars, exceeds the 512-byte KV key limit)
    status=500  ACAO='<<MISSING>>'      body: error code: 1101
```

Two consequences. The CORS header is absent, so in a browser the response is blocked and the app reports "could not reach the reading service" for what is really a 400. And `error code: 1101` is a Cloudflare exception page, meaning any future bug anywhere in the handler surfaces the same way. G2 is a realistic integration mistake — leaving the `data:` prefix on is the most common base64 error there is.

**Fix:** wrap the body of `fetch()` in try/catch returning `json({error:"internal"},500,cors(env,request))`, and validate base64 with a regex before `atob`.

### 2.4 The rate limiter does not hold — MUST-FIX

`bump` (`limits.js:7-11`) is read-then-write with no atomicity, on a store that is eventually consistent:
```js
const cur = parseInt((await store.get(key)) || "0", 10) + 1;
await store.put(key, String(cur), { expirationTtl: ttl });
```

**[measured]** nine parallel `/scan` requests, one `device_id`, limit 6/minute, using a cached image so no model was called:
```
req1: 200   req2: 200   req3: 429   req4: 200   req5: 200
req6: 200   req7: 200   req8: 429   req9: 200
-> 429s: 2 of 9   (3 expected if the 6/min limit held)
```

**Seven of nine got through a limit of six**, and the two refusals landed out of order, which is the lost-update signature. Two further problems in the same function: `cap:<date>` is a single hot key written on **every** scan, and KV allows one write per second per key, so at a busy stand that key both throttles and serves stale counts. And `checkLimits` runs before `cacheGet` (`index.js:69` then `74`), so a free cache hit still consumes the visitor's daily quota and the global cap.

The header comment at `limits.js:2` says "the cap is a ceiling, not an audit", so the approximation is deliberate. The measurement says the ceiling leaks by about 17% under a burst of nine. Size the cap accordingly, or move the counters to a Durable Object.

### 2.5 `device_id` is client-chosen, so per-device limits are decorative — MUST-FIX

```js
67  const device = (device_id || request.headers.get("CF-Connecting-IP") || "anon").slice(0, 64);
```

The caller supplies `device_id`. A fresh random value on each request means `PER_DEVICE_PER_MINUTE` and `PER_DEVICE_PER_DAY` never bind, and only `DAILY_SCAN_CAP` (5,000) stands between a script and the Anthropic bill. **[measured]** every probe in this review used a device_id of my choosing and none were rejected on those grounds.

CORS does not help. **[measured]**:
```
### L1 disallowed Origin https://evil.example    status=200
### L2 no Origin header at all                   status=200
```
`cors()` returns `allowed[0]` for a disallowed origin (`index.js:22`), which is the safe choice for a browser, but the request is still served in full. Any non-browser caller bypasses CORS entirely, which is what CORS is — a browser rule, not a server control.

**Fix:** key the limits on `CF-Connecting-IP` always, and use `device_id` only as a secondary dimension.

### 2.6 No second reader is configured in production — MUST-FIX

**[measured]** `GET /health`:
```json
{"ok":true,"rules":"Abu Dhabi QCC 'The Nutri-Mark calculation tool APRIL 2026.xl",
 "kill_switch":"off","readers":{"anthropic":true,"google":false}}
```

`GOOGLE_API_KEY` is not set. The Gemini fallback in `readOnce` (`index.js:50-56`) is dead code, and `/gemini-models` returns 503 — **[measured]** `{"error":"no Google key configured"}`. The build has a documented two-provider design and is running on one. An Anthropic incident during the exhibition means every scan returns 502 "reader unavailable". Either set the secret or stop describing the fallback as present.

### 2.7 The cache key has no version — MUST-FIX

`index.js:73-74` keys on the SHA-256 of the image bytes alone, with a 7-day TTL (`wrangler.toml:22`). Nothing in the key covers `rules.json`, the system prompt, or the model names. Improve the reader or fix a rule, and **stale grades keep being served for a week**. Cheap fix: fold a short hash of `rules.source` plus `PRIMARY_MODEL` into the key.

Two related observations. **[measured]** both of my repeat scans of the stored test photos returned `cached=True`, and the cached response replays the original `scan_id` and the original `passes` usage numbers, which makes the token figures in the log misleading. And `logScan` is skipped entirely on a cache hit (`index.js:75` returns early), so cached scans are invisible in the log.

More practically: a cache hit needs byte-identical input, which never happens with two real photos of the same box. **At the stand this cache will essentially never hit.** It helps the demo loop, not the visitors.

### 2.8 The `atob` at 5 MB — my hypothesis was wrong

I expected `Uint8Array.from(atob(...), c => c.charCodeAt(0))` (`index.js:72`) to blow the Worker CPU budget at the cap, because it runs a per-character JS callback over millions of characters.

**[measured]** I sent 6,900,000 base64 characters (5.17 MB decoded, just under the 5 MiB limit on `index.js:66`):
```
TEST 1: status=502  12.6s
  body={"error":"reader unavailable","detail":"claude-sonnet-5: 400 ... \"Could not process image\" ..."}
```
The decode and the SHA-256 completed and the Worker reached the reader. **The CPU concern is refuted at the maximum allowed size.** I am recording that because I would otherwise have filed it as a must-fix.

What remains is true and still worth fixing: `bytes` is used on exactly one line, `sha256Hex(bytes)` on line 73, and never again — the base64 string goes to the readers unchanged. The whole decode is wasted work. `new TextEncoder().encode(image_base64)` gives an equally valid cache key in one native call. **Note**, not a blocker.

### 2.9 What leaks into responses and logs

- **Upstream error text is echoed to the caller.** **[measured]** a PNG declared as `image/jpeg`:
  ```
  status=502  {"error":"reader unavailable","detail":"claude-sonnet-5: 400 {\"type\":\"error\",
  \"error\":{\"type\":\"invalid_request_error\",\"message\":\"The ima | claude-opus-5: 400 ..."}
  ```
  `index.js:88` forwards 200 characters of the provider's error, exposing model names and the provider's error shape. No key is exposed. Minor, but it also shows a mismatched type costs **two** API round trips before failing.
- **Visitor IP addresses are stored for 30 days.** `index.js:67` falls back to `CF-Connecting-IP`, and `logScan` writes that value into the `device` field (`index.js:117`, `limits.js:42`) with `LOG_TTL_SECONDS` of 2,592,000. The comment on `limits.js:39` says "values and grade only, never the image" — true of the image, but an IP address is personal data under the UAE PDPL. The app always sends a `device_id`, so this only triggers for direct callers, but it does trigger. **Must-fix:** hash it, or drop the fallback to `"anon"`.
- Nothing else personal is logged. No image, no product photo, no name. `logScan` stores per-100 values, the grade, the decision and token counts. That part is well judged.

### 2.10 The reader prompt and its schema

**Does the schema guarantee nulls for unprinted values?** No, and it cannot. `reader.js:9-32` makes every nutrient `z.number().nullable()`, so null is *permitted* everywhere, and `reader.js:49` instructs "Never estimate a nutrient value that is not printed; use null for it." That is an instruction, not a guarantee — the schema would equally accept an invented number. The real guard is downstream: `route()` refuses to grade when a required field is missing (`checks.js:57-59`) and `consistencyChecks` catches impossible combinations. That layering is correct.

**[measured]** the model does honour it. On a 64×64 blank blue square all ten values came back null with every confidence at 0:
```
values={"energy_kJ":null,"energy_kcal":null,"fat_g":null,...,"sodium_mg":null}
conf={"energy":0,"fat":0,...,"category":0,"basis":0}
```

**Can a package instruct the model?** `reader.js:59` addresses it directly and the free-text fields it could poison (`product_name`, `notes`, `fvl_basis`) all reach the DOM through `textContent`. The one field with real leverage is `fvl_pct_estimate`, which is a model *judgement* (`reader.js:33`) feeding straight into the positive points, and a package printing "contains 85% fruit" can move it legitimately or otherwise. That is inherent to reading a label, not a defect.

**Untested in production:** `readWithGemini` (`reader.js:109-123`) cannot have been exercised, since `GOOGLE_API_KEY` is unset. Its `JSON.parse(text)` on line 120 is unguarded and will throw on a truncated response rather than produce the intended schema error.

### 2.11 Backend correctness notes

| # | Finding | Line | Severity |
|---|---|---|---|
| a | Second-pass failure is swallowed. The catch sets `decision={action:"retake",reasons:[...,"second_pass_failed"]}`, then lines 104-107 unconditionally re-route the **first** read and overwrite it, discarding `second_pass_failed` and pushing a duplicate `passes` entry with the first read's model and usage. | `index.js:100-107` | note |
| b | No `Access-Control-Max-Age`, so every scan pays a preflight round trip. **[measured]** `OPTIONS /scan` → 204, no such header. On stand wifi that is a wasted RTT per scan. | `index.js:21-27` | note |
| c | `route()` emits `basis_unclear` twice — once as a blocking check code, once from `basisProblem`. **[measured]** in the live reasons array. Cosmetic, but it is what the new `noValues` test on `app.html:315` now reads. | `checks.js:62-65` | note |
| d | Confidence is only gated on energy, salt, satfat and sugar (`checks.js:53`). `fibre` and `protein` feed positive points but a low-confidence read of either silently improves the grade. | `checks.js:53` | note |
| e | `.replace("satfat","satfat")` is a no-op. | `checks.js:53` | note |
| f | `/gemini-models` is an unauthenticated public proxy to Google's API using the server key. Currently 503 because the key is unset. | `index.js:146-155` | note |
| g | Image size is never capped server-side below 5 MB, so a direct caller multiplies the token cost. **[measured]** 4500×5000 px billed **4,757 input tokens** against **1,200** for the same label at the app's 1280 px, about 4×. | `index.js:66` | note |
| h | `index.js` has **no unit tests at all**. The suite covers `checks.js` and the engine bridge; the handler, CORS, limits, cache and the `atob` path are untested. Every defect in section 2 lives in untested code. | `backend/test/` | must-fix |
| i | No secrets in the repo or on disk. **[measured]** `.gitignore` covers `.dev.vars`, `.env`, `*.env`; no key-shaped string in any tracked file; `wrangler.toml` carries only the KV id and vars. Clean. | — | ok |
| j | `backend/test/photos/` is gitignored, so `scan_photo.py` ships without the images it needs. | `.gitignore` | note |

---

## 3. Test runs

### 3.1 Unit tests — 10/10 pass

```
C:\Program Files\nodejs\node.exe --test backend/test/checks.test.mjs
```
```
✔ clean per-100 g reading grades D like the prototype and the official tool (4.1022ms)
✔ per-serving values scale to per 100 g (0.2497ms)
✔ per-serving without a serving size cannot be graded (0.2013ms)
✔ kJ/kcal mismatch and sugar above carbohydrate are blocking (0.412ms)
✔ low confidence on a required field goes to a second pass, then to retake (0.9354ms)
✔ missing salt and sodium is a routing reason (0.3614ms)
✔ sodium instead of salt reaches the engine and converts (0.411ms)
✔ missing fibre is counted as 0 and flagged, not refused (0.2596ms)
✔ a non-food photo is routed as not_food (0.2534ms)
✔ beverage with sweetener and plain water take the beverage paths (0.5689ms)
ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ duration_ms 143.8983
EXIT=0
```

Note the ninth test. It asserts `route({...cereal, category:"other"}).action === "not_food"` — it hands the router a category of `"other"` directly. Section 3.3 shows the reader does not produce `"other"` for a real non-food photo, so this test passes while the behaviour it stands for does not happen.

### 3.2 Two real test photos, live

```
python scan_photo.py https://nutrimark-backend.dcl-ibrahim.workers.dev \
  photos/synthetic_cereal_clean.jpg photos/synthetic_cereal_per_serving_sodium.jpg
```
```
== synthetic_cereal_clean.jpg  (1.1 s, cached=True)
   product: Honey breakfast cereal | category: general | basis: per_100g serving=None
   per100 : {"energy_kJ":1407,"energy_kcal":335,"fat_g":5,"satfat_g":3.5,"carb_g":72,
             "sugar_g":15,"fibre_g":4.5,"protein_g":7,"salt_g":0.5,"sodium_mg":null}
   checks : []  decision: {'action':'grade','reasons':[]}
   grade  : D score=11 N=13 P=4 reasons=['energy_kJ','sugar_g','satfat_g'] flags=[]
   passes : [('claude-sonnet-5', {'input':1200,'output':398,'cached':0})]

== synthetic_cereal_per_serving_sodium.jpg  (3.9 s, cached=True)
   product: Oat & honey cereal | category: general | basis: per_serving serving=30
   values : {"energy_kJ":520,...,"salt_g":null,"sodium_mg":60}
   per100 : {"energy_kJ":1733.3,...,"salt_g":null,"sodium_mg":200}
   checks : []  decision: {'action':'grade','reasons':[]}
   grade  : D score=11 N=13 P=4 reasons=['energy_kJ','sugar_g','satfat_g'] flags=[]
```

Both correct. The per-serving rescale and the sodium path work end to end. This second result is the evidence for finding 1.4: `per100.salt_g` is null and `sodium_mg` is 200, and the app converts to 0.5 g on the client under the caption "as printed on the label".

### 3.3 Tiny non-food image (64×64 flat blue, drawn with PIL)

```
status=200  10.2s  cached=False
decision={'action':'retake','reasons':['basis_unclear','low_confidence_energy',
  'low_confidence_satfat','low_confidence_sugar','low_confidence_salt','missing_energy',
  'missing_salt','missing_satfat_g','missing_sugar_g','basis_unclear','category_unclear']}
category='unsure'
cat_reason='The image is a plain solid blue field with no product, packaging, text, or
            nutrition table visible.'
passes=[claude-sonnet-5 {input:21,output:358}, + a second Opus pass]
```

The reader is exactly right and the routing is wrong. The model says `"unsure"`, honestly; `route()` only returns `not_food` for `"other"` (`checks.js:66`), so **`not_food` never fires and `s.notFood` is dead code for this case**. The visitor waits 10.2 s, pays for two model calls, and gets a message about turning the pack around.

The new `noValues` branch (`app.html:315`) does catch it — `missing_energy` and `missing_sugar_g` are both present — so the current message is `s.noTable`: "The nutrition table is not in this photo. Turn the pack to the side that lists energy, fat, sugars and salt." Better than "avoid glare", still wrong for a photo of a person or the ceiling, and it still costs 10 seconds and two model calls.

The fix belongs in `route()`, before the second pass is spent: when `category === "unsure"`, `confidence.category === 0` and every value is null, return `not_food` immediately.

### 3.4 Huge image (4500×5000, upscaled from a test photo, 1.0 MB)

```
status=200  8.2s  cached=False
decision={'action':'grade','reasons':[]}
product='Honey breakfast cereal' basis='per_100g'
grade=D  checks=[]
passes=[{"model":"claude-sonnet-5","usage":{"input":4757,"output":389,"cached":2585}}]
```

Accepted and graded correctly. It passes the 5 MB cap easily. The cost is the finding: **4,757 input tokens against 1,200** for the same label at the app's own 1280 px shrink, about four times, because nothing downscales server-side.

### 3.5 Wrong and malformed media types

```
E1 media_type "image/gif"        -> 400 {"error":"image_base64 and a jpeg/png/webp media_type are required"}  ACAO ok
E2 media_type absent             -> 400 same                                                                  ACAO ok
E3 media_type "image/jpg" (typo) -> 400 same                                                                  ACAO ok
F  PNG bytes declared image/jpeg -> 502 {"error":"reader unavailable","detail":"claude-sonnet-5: 400 ..."}     ACAO ok
H1 7,000,000 base64 chars        -> 413 {"error":"image too large"}                                            ACAO ok
G1 malformed base64              -> 500 error code: 1101                                                       ACAO MISSING
G2 "data:image/jpeg;base64,..."  -> 500 error code: 1101                                                       ACAO MISSING
N2 GET /nope                     -> 404 {"error":"not found"}                                                  ACAO ok
N3 POST /scan, non-JSON body     -> 400 {"error":"expected JSON body"}                                         ACAO ok
M1 OPTIONS /scan                 -> 204, no Access-Control-Max-Age
```

Validation is correct wherever it is explicit. The two 500s are the gap (finding 2.3). `image/jpg` returning 400 is right per the allow-list but is the typo every integrator makes; accepting it as an alias would cost one line.

CORS resolves correctly for the real origin. **[measured]** `Origin: https://ibrahim-kukash.github.io` → `Access-Control-Allow-Origin: https://ibrahim-kukash.github.io`. The `ALLOWED_ORIGINS` value on `wrangler.toml:13` is the scheme-and-host form, and browsers send exactly that with no path, so **the app's origin matches exactly**. That question in the brief resolves clean.

---

## 4. The ten most likely ways a visitor breaks this, ranked

1. **Photographs something that is not a nutrition table** — the pack front, a friend, the stand banner. 10+ seconds, two model calls, then a message telling them to turn over a pack that may not exist. `not_food` never fires. → `backend/src/checks.js:66`
2. **Venue wifi drops or a captive portal intercepts** — `rules.json` fails, the module dies, the page is a blank intro with dead buttons and no error. → `docs/app.html:218`
3. **Backend is slow and the visitor waits** — no timeout, no cancel, shutter disabled, up to about three minutes of "Reading the label…". → `docs/app.html:303`
4. **Picks a photo the browser cannot decode** — unhandled rejection, `busy` stuck true, shutter dead until reload. → `docs/app.html:298`
5. **Anyone with the URL scripts `/correct`** — no auth, no rate limit, unlimited KV writes; exhausting the KV write quota takes `/scan` down with it. → `backend/src/index.js:126`
6. **Reads "as printed on the label" over converted values** — a per-serving, sodium-only label is shown rescaled and converted under a caption claiming it is printed. → `docs/app.html:326`
7. **A queue forms and the limiter leaks** — 7 of 9 parallel requests passed a limit of 6; with client-chosen `device_id` only the 5,000 global cap really binds. → `backend/src/limits.js:7` and `backend/src/index.js:67`
8. **Taps the demo toolbar above the phone** — Language and Look controls are public, in English, and reflow the layout mid-demo. → `docs/app.html:151-161`
9. **Uses a small phone** — the intro needs roughly 577 px and there is no scroll, so below about 637 px of viewport the "Scan a product" button is clipped and unreachable. **[reasoned]**, not rendered. → `docs/app.html:28`
10. **Anthropic has an incident** — `readers.google` is false, so the documented fallback does not exist and every scan returns 502. → `backend/wrangler.toml:16`

---

## Verdict

**Do not run this at a stand in its current state.** The grading core is sound — 10/10 unit tests, correct per-serving and sodium handling, correct rotation tolerance, a complete reasons mapping, no XSS path, prompt injection addressed, no secrets leaked. Everything on the blocker list is in the shell around it: error handling, timeouts, and one unprotected endpoint.

**Blockers — fix before the stand opens**

| Finding | Location |
|---|---|
| `rules.json` failure kills the whole page, silently | `docs/app.html:218` |
| No request timeout and no way to cancel a scan | `docs/app.html:303` |
| An undecodable photo locks the app until reload | `docs/app.html:298` |
| Non-food photos route to "retake", cost two model calls and 10 s | `backend/src/checks.js:66` |
| `/correct` is unauthenticated and unrate-limited; KV exhaustion takes `/scan` with it | `backend/src/index.js:126` |

**Must-fix — before it is public**

`/correct` mints grade A from impossible values (`index.js:130`) · uncaught exceptions return 500 without CORS (`index.js:72,139`) · rate limiter leaks about 17% under burst (`limits.js:7`) · client-chosen `device_id` (`index.js:67`) · no Gemini fallback configured (`wrangler.toml:16`) · unversioned cache key serves stale grades for 7 days (`index.js:73`) · visitor IPs logged for 30 days (`index.js:67`) · "as printed on the label" over converted values (`app.html:326`) · what-if ignores energy (`app.html:339`) · render-blocking Google Fonts (`app.html:9`) · public demo toolbar (`app.html:151`) · intro clipped on small phones (`app.html:28`) · stuck-screen race (`app.html:384`) · `index.js` has no tests at all (`backend/test/`).

**Notes** — the remaining rows in tables 1.8, 2.11 and finding 2.8.

**Two things I got wrong, recorded deliberately.** I expected the 5 MB `atob` to exceed the Worker CPU budget; measured at the maximum allowed size it completes and reaches the reader, so that is a note about wasted work, not a defect. And I expected EXIF rotation to degrade readings; a 90°-rotated label returned identical values at full confidence and the same grade, so that is cosmetic. Both were ranked high before I measured them.

**What I could not verify.** No layout claim here was rendered — the Chrome extension is not connected and the Playwright MCP server timed out. Finding 1.8c (small-phone clipping) is arithmetic from the stylesheet with about ±20 px of uncertainty in the text heights, and findings 1.3, 1.8d and the iOS notes are read from the code. Those five need ten minutes with a real phone or a working browser before anyone acts on them.
