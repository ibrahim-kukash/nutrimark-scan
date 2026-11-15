// Tests of the Worker itself: POST /scan and POST /correct through the real src/index.js, in-process.
// The AI reader is the only stand-in (canned readings); storage is an in-memory map. No network, no keys.
//   node --test backend/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/hooks.mjs", import.meta.url);
const worker = (await import("../src/index.js")).default;

// ---- a small stand: storage, environment, requests ----
function makeStore() {
  const m = new Map();
  return { m,
    async get(k, opt) { const v = m.get(k); if (v === undefined) return null; return opt && opt.type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); } };
}
const makeEnv = (over = {}) => ({ STORE: makeStore(), ANTHROPIC_API_KEY: "x".repeat(40), ALLOWED_ORIGINS: "http://localhost:8888",
  PRIMARY_MODEL: "claude-sonnet-5", SECOND_PASS_MODEL: "claude-opus-5", PER_DEVICE_PER_MINUTE: "1000", PER_DEVICE_PER_DAY: "1000", DAILY_SCAN_CAP: "1000",
  COUNTER_RETRY_MS: "5", ...over });
async function post(env, path, obj, ip = "10.0.0.1") {
  const req = new Request("http://worker.local" + path, { method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:8888", "CF-Connecting-IP": ip }, body: typeof obj === "string" ? obj : JSON.stringify(obj) });
  const res = await worker.fetch(req, env);
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
let photo = 0;
const newPhoto = () => Buffer.from("photo " + (++photo)).toString("base64");   // unique bytes: never a cache hit unless the same string is sent again
/** readings: what the stand-in reader returns, in order (first read, then second read). */
async function scan(readings, env = makeEnv(), image = newPhoto(), ip) {
  globalThis.__READS = readings.map(r => structuredClone(r)); globalThis.__CALLS = 0; globalThis.__HINTS = [];
  const r = await post(env, "/scan", { image_base64: image, media_type: "image/jpeg", device_id: "test" }, ip);
  return { ...r, reads: globalThis.__CALLS, env };
}
/** The request the page sends when the visitor answers a question on the card (docs/app.html: answerBase and sendAnswer):
 *  the reading with its values already per 100, the chosen category, and the answer about a drink when one was given. */
function answer(scanBody, { category, drink, values = {} } = {}) {
  const rd = scanBody.reading, v = scanBody.per100 || {};
  const cat = category || rd.category;
  const unit = rd.basis === "per_100ml" ? "ml" : rd.basis === "per_100g" ? "g" : (cat === "beverages" ? "ml" : "g");
  const reading = { ...rd, basis: rd.basis === "per_serving" ? (unit === "ml" ? "per_100ml" : "per_100g") : rd.basis, serving_size: null, energy_basis: "same_as_table", values: { ...v } };
  const body = { scan_id: scanBody.scan_id, device_id: "test", reading, category: cat, values };
  if (drink) body.drink = drink;
  return body;
}

// ---- readings ----
const sure = { energy: 1, fat: 1, satfat: 1, carb: 1, sugar: 1, fibre: 1, protein: 1, salt: 1, sodium: 1, category: 1, basis: 1 };
const cereal = {
  product_name: "Honey breakfast cereal", brand: null, barcode: null, label_language: "both",
  category: "general", category_reason: "breakfast cereal", nutrition_table_visible: true, ingredients_visible: true,
  basis: "per_100g", serving_size: null, energy_basis: "same_as_table",
  values: { energy_kJ: 1407, energy_kcal: 335, fat_g: 5.0, satfat_g: 3.5, carb_g: 72, sugar_g: 15, polyols_g: null, fibre_g: 4.5, protein_g: 7.0, salt_g: 0.5, sodium_mg: null },
  fvl_pct_estimate: 0, fvl_basis: "none listed", sweeteners_present: false, sweeteners_listed: [], plain_water: false,
  red_meat_20_plus: null, is_cheese: false, confidence: sure, notes: "",
};
const R = (over = {}) => ({ ...structuredClone(cereal), ...over, values: { ...cereal.values, ...(over.values || {}) }, confidence: { ...cereal.confidence, ...(over.confidence || {}) } });
const tableOnly = { product_name: null, category: "unsure", ingredients_visible: false, fvl_basis: "ingredients not in the photo", confidence: { category: 0.2 } };
// Real labels of the 15 Nov 2026 test.
const steak = R({ ...tableOnly, values: { energy_kJ: null, energy_kcal: 127.1, fat_g: 8.7, satfat_g: 3.48, carb_g: 0, sugar_g: 0, fibre_g: null, protein_g: 12.2, salt_g: null, sodium_mg: 111.7 }, confidence: { category: 0.2, salt: 0, fibre: 0 } });
const feta = R({ ...tableOnly, values: { energy_kJ: null, energy_kcal: 184, fat_g: 11.6, satfat_g: 7.9, carb_g: 5.3, sugar_g: 5.3, fibre_g: null, protein_g: 14.5, salt_g: null, sodium_mg: 1200 }, confidence: { category: 0.2, salt: 0, fibre: 0 } });
const colaZero = R({ product_name: "Cola zero", category: "beverages", basis: "per_100ml", ingredients_visible: false,
  values: { energy_kJ: 1, energy_kcal: 0.2, fat_g: 0, satfat_g: 0, carb_g: 0, sugar_g: 0, fibre_g: 0, protein_g: 0, salt_g: 0.02, sodium_mg: null } });
const juice = R({ ...tableOnly, basis: "per_100ml", values: { energy_kJ: null, energy_kcal: 47, fat_g: 0, satfat_g: 0, carb_g: 10.5, sugar_g: 10, fibre_g: 0.2, protein_g: 0.7, salt_g: 0, sodium_mg: null } });
const waterPanel = R({ ...tableOnly, basis: "per_100ml", values: { energy_kJ: 0, energy_kcal: 0, fat_g: 0, satfat_g: 0, carb_g: 0, sugar_g: 0, fibre_g: null, protein_g: 0, salt_g: null, sodium_mg: 0.3 }, confidence: { category: 0.2, salt: 0, fibre: 0 } });
const crackers = R({ product_name: "Multi Seeds Protein Cracker with Zaatar", serving_size: 25, energy_basis: "per_serving",
  values: { energy_kJ: 556, energy_kcal: 133, fat_g: 31.76, satfat_g: 4.96, carb_g: 31, sugar_g: 0, fibre_g: 10.5, protein_g: 30, salt_g: null, sodium_mg: 849 }, confidence: { salt: 0, category: 0.8 } });
const nuts = R({ ...tableOnly, values: { energy_kJ: null, energy_kcal: 588, fat_g: 50, satfat_g: 10, carb_g: 20, sugar_g: 10, fibre_g: 6, protein_g: 25, salt_g: null, sodium_mg: 70 }, confidence: { category: 0.2, salt: 0 } });
const beans = R({ product_name: "Baked beans", serving_size: 200, values: { energy_kJ: 393, energy_kcal: 93, fat_g: 0.25, satfat_g: 0.1, carb_g: 16.4, sugar_g: 4.6, fibre_g: 4, protein_g: 6.2, salt_g: 0.6, sodium_mg: null } });

// ---- the category question ----
test("table-only photo: one read, the visitor names the category, the grade is that category's", async () => {
  const image = newPhoto();
  const s = await scan([feta], makeEnv(), image);
  assert.equal(s.status, 200); assert.equal(s.reads, 1);
  assert.deepEqual(s.body.decision, { action: "ask_category", reasons: ["category_unclear"] });
  assert.equal(s.body.grade, undefined);
  const cheese = await post(s.env, "/correct", answer(s.body, { category: "cheese" }));
  assert.equal(cheese.status, 200); assert.equal(cheese.body.grade.grade, "D"); assert.equal(cheese.body.grade.score, 18);
  const general = await post(s.env, "/correct", answer(s.body, { category: "general" }));
  assert.equal(general.body.grade.grade, "E"); assert.equal(general.body.grade.score, 24);
  assert.ok(general.body.flags.includes("ingredients_not_in_photo_fvl_counted_as_0"));
  // A reply that asks a question is never cached: the very same photo is read again, also after it was answered.
  const again = await scan([feta], s.env, image);
  assert.equal(again.reads, 1); assert.equal(again.body.cached, undefined); assert.equal(again.body.decision.action, "ask_category");
});

test("the visitor's 'Red meat' is graded as red meat, whatever the reader guessed about the meat share", async () => {
  // The reader cannot tell what the product is, guesses cheese, and with that guess says "not 20% red meat".
  // ... or guesses red meat itself, without being sure: its "not 20%" is a guess all the same.
  for (const guess of [{ category: "unsure", confidence: { category: 0.2 } }, { category: "cheese", confidence: { category: 0.5 } }, { category: "red_meat", confidence: { category: 0.5 } }, { category: "red_meat", confidence: { category: 0.59 } }]) for (const flag of [false, null, true]) {
    const s = await scan([{ ...steak, ...guess, confidence: { ...steak.confidence, ...guess.confidence }, red_meat_20_plus: flag }]);
    assert.equal(s.body.decision.action, "ask_category");
    const r = await post(s.env, "/correct", answer(s.body, { category: "red_meat" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.engine_input.category, "red_meat", `graded as ${r.body.engine_input.category} with the reader's flag ${flag}`);
    assert.equal(r.body.grade.grade, "C"); assert.equal(r.body.grade.score, 3);          // as a general food it would be A, score 0
    assert.equal(r.body.flags.includes("red_meat_below_20pct_graded_as_general"), false);
  }
  // A reader that was sure of another group (general food, table only) and whose visitor changes the category to red meat in the editor: red meat.
  const sureGeneral = await scan([{ ...steak, category: "general", confidence: { ...steak.confidence, category: 0.9 }, red_meat_20_plus: false }]);
  assert.equal(sureGeneral.body.decision.action, "grade"); assert.equal(sureGeneral.body.grade.grade, "A");
  const changed = await post(sureGeneral.env, "/correct", answer(sureGeneral.body, { category: "red_meat" }));
  assert.equal(changed.body.engine_input.category, "red_meat"); assert.equal(changed.body.grade.grade, "C");
  // A reader that had the ingredients list in front of it and read "beef 12%" keeps its say, sure of the group or not:
  // the product is graded as a general food and the result says so. A corrected number does not undo that.
  for (const conf of [0.9, 0.5]) {
    const seen = R({ ...steak, product_name: "Beef and vegetable patties", category: "red_meat", ingredients_visible: true, red_meat_20_plus: false, confidence: { ...steak.confidence, category: conf } });
    const s = await scan([seen]);
    const first = conf >= 0.6 ? s : await post(s.env, "/correct", answer(s.body, { category: "red_meat" }));
    assert.equal(first.status, 200); assert.equal(first.body.engine_input.category, "general");
    assert.ok(first.body.flags.includes("red_meat_below_20pct_graded_as_general"));
    const edited = await post(s.env, "/correct", answer({ ...s.body, ...first.body }, { values: { sugar_g: 1 } }));
    assert.equal(edited.body.engine_input.category, "general");
  }
});

// ---- what kind of drink ----
test("a drink photographed without its ingredients is not graded until the visitor has said what could change its letter", async () => {
  // The reader recognises the drink (the name is in the table's heading) but the ingredients are not in the photo.
  const s = await scan([colaZero]);
  assert.equal(s.reads, 1);
  assert.deepEqual(s.body.decision, { action: "ask_drink", reasons: ["drink_facts_unknown"], options: ["sweeteners", "none"] });
  assert.equal(s.body.grade, undefined);
  const silent = await post(s.env, "/correct", answer(s.body, {}));
  assert.equal(silent.status, 400); assert.deepEqual(silent.body.ask, ["drink"]); assert.deepEqual(silent.body.options, ["sweeteners", "none"]);
  const yes = await post(s.env, "/correct", answer(s.body, { drink: "sweeteners" }));
  assert.equal(yes.status, 200); assert.equal(yes.body.grade.grade, "C"); assert.equal(yes.body.grade.score, 4);
  assert.equal(yes.body.grade.points.sweeteners, 4);
  const no = await post(s.env, "/correct", answer(s.body, { drink: "none" }));
  assert.equal(no.status, 200); assert.equal(no.body.grade.grade, "B"); assert.equal(no.body.grade.score, 0);
  // The answer stays with the reading: a later correction of a number is not asked again.
  const later = await post(s.env, "/correct", answer({ ...s.body, reading: yes.body.reading, per100: yes.body.per100 }, { values: { sugar_g: 0.2 } }));
  assert.equal(later.status, 200); assert.equal(later.body.grade.points.sweeteners, 4);
  // "Plain water" is not an answer for a drink that prints energy: it changes nothing.
  const notWater = await post(s.env, "/correct", answer(s.body, { drink: "water" }));
  assert.equal(notWater.status, 200); assert.equal(notWater.body.grade.grade, "B");
  assert.equal((await post(s.env, "/correct", { ...answer(s.body, {}), drink: "champagne" })).status, 400);
});

test("table-only drinks: the category first, then one question about the drink", async () => {
  // A zero cola: B as it stands, C with sweeteners.
  const cola = await scan([{ ...colaZero, product_name: null, category: "unsure", confidence: { ...sure, category: 0.2 } }]);
  assert.equal(cola.body.decision.action, "ask_category");
  const picked = await post(cola.env, "/correct", answer(cola.body, { category: "beverages" }));
  assert.equal(picked.status, 400); assert.deepEqual(picked.body.ask, ["drink"]); assert.deepEqual(picked.body.options, ["sweeteners", "none"]);
  const answered = await post(cola.env, "/correct", answer(cola.body, { category: "beverages", drink: "sweeteners" }));
  assert.equal(answered.status, 200); assert.equal(answered.body.grade.grade, "C");
  // The same numbers named a general food need no such answer.
  assert.equal((await post(cola.env, "/correct", answer(cola.body, { category: "general" }))).status, 200);
  // Plain drinking water, a panel of zeros: A by definition, and the card can say so.
  const water = await scan([waterPanel]);
  const w1 = await post(water.env, "/correct", answer(water.body, { category: "beverages" }));
  assert.equal(w1.status, 400); assert.deepEqual(w1.body.options, ["water", "sweeteners", "none"]);
  const w2 = await post(water.env, "/correct", answer(water.body, { category: "beverages", drink: "water" }));
  assert.equal(w2.status, 200); assert.equal(w2.body.grade.grade, "A"); assert.deepEqual(w2.body.flags.filter(f => f.startsWith("ingredients")), []);
  assert.equal((await post(water.env, "/correct", answer(water.body, { category: "beverages", drink: "none" }))).body.grade.grade, "B");
  // 100% orange juice (real label): E when nobody says it is juice, C when the visitor does. Sweeteners would not change the E, so they are not offered.
  const oj = await scan([juice]);
  const j1 = await post(oj.env, "/correct", answer(oj.body, { category: "beverages" }));
  assert.equal(j1.status, 400); assert.deepEqual(j1.body.options, ["juice", "none"]);
  const j2 = await post(oj.env, "/correct", answer(oj.body, { category: "beverages", drink: "juice" }));
  assert.equal(j2.status, 200); assert.equal(j2.body.grade.grade, "C"); assert.equal(j2.body.grade.score, 5);
  assert.equal(j2.body.flags.includes("ingredients_not_in_photo_fvl_counted_as_0"), false);
  const j3 = await post(oj.env, "/correct", answer(oj.body, { category: "beverages", drink: "none" }));
  assert.equal(j3.body.grade.grade, "E"); assert.ok(j3.body.flags.includes("ingredients_not_in_photo_fvl_counted_as_0"));
});

test("a drink is graded at once when its facts are known, or when nothing the visitor could say would change the letter", async () => {
  const s = await scan([{ ...colaZero, ingredients_visible: true, sweeteners_present: true, sweeteners_listed: ["aspartame", "acesulfame K"] }]);
  assert.equal(s.body.decision.action, "grade"); assert.equal(s.body.grade.grade, "C"); assert.equal(s.body.grade.score, 4);
  const plain = await scan([{ ...colaZero, ingredients_visible: true, sweeteners_present: false }]);
  assert.equal(plain.body.decision.action, "grade"); assert.equal(plain.body.grade.grade, "B");
  // A very sugary drink is E as juice, with sweeteners, or as it stands: no question.
  const syrupy = await scan([R({ product_name: "Energy drink", category: "beverages", basis: "per_100ml", ingredients_visible: false,
    values: { energy_kJ: 400, energy_kcal: 96, fat_g: 0, satfat_g: 0, carb_g: 22, sugar_g: 20, fibre_g: 0, protein_g: 0, salt_g: 0.1 } })]);
  assert.equal(syrupy.body.decision.action, "grade"); assert.equal(syrupy.body.grade.grade, "E");
  // A bottle of water the reader recognised, with a panel of zeros and no sugars row: A, not "the label is incomplete".
  const bottle = await scan([R({ product_name: "Drinking water", category: "beverages", basis: "per_serving", serving_size: 500, plain_water: true, ingredients_visible: false,
    values: { energy_kJ: null, energy_kcal: 0, fat_g: 0, satfat_g: null, carb_g: 0, sugar_g: null, fibre_g: null, protein_g: 0, salt_g: null, sodium_mg: 0 }, confidence: { satfat: 0, sugar: 0, fibre: 0, salt: 0 } })]);
  assert.equal(bottle.reads, 1); assert.deepEqual(bottle.body.decision, { action: "grade", reasons: ["plain_water"] }); assert.equal(bottle.body.grade.grade, "A");
});

// ---- total fat, when the visitor picks the fats group ----
test("the fats group: a fat value the reader was unsure of is confirmed by the visitor before it is graded", async () => {
  const blurred = { ...nuts, confidence: { ...nuts.confidence, fat: 0.3 } };
  const s = await scan([blurred]);
  assert.equal(s.body.decision.action, "ask_category"); assert.equal(s.reads, 1);
  const picked = await post(s.env, "/correct", answer(s.body, { category: "fats" }));
  assert.equal(picked.status, 400); assert.deepEqual(picked.body.confirm, ["fat_g"]);
  const typed = await post(s.env, "/correct", answer(s.body, { category: "fats", values: { fat_g: 49 } }));
  assert.equal(typed.status, 200); assert.equal(typed.body.engine_input.fat_g, 49);
  const later = await post(s.env, "/correct", answer({ ...s.body, reading: typed.body.reading, per100: typed.body.per100 }, { category: "fats" }));
  assert.equal(later.status, 200);                                                        // confirmed once is confirmed
  // Any other group does not grade on total fat, so nothing is asked.
  assert.equal((await post(s.env, "/correct", answer(s.body, { category: "general" }))).status, 200);
  // A fat value read clearly is graded straight away; a missing one is asked for.
  const clear = await scan([nuts]);
  assert.equal((await post(clear.env, "/correct", answer(clear.body, { category: "fats" }))).status, 200);
  const none = await scan([{ ...nuts, values: { ...nuts.values, fat_g: null }, confidence: { ...nuts.confidence, fat: 0 } }]);
  assert.equal(none.body.decision.action, "ask_category");
  const missing = await post(none.env, "/correct", answer(none.body, { category: "fats" }));
  assert.equal(missing.status, 400); assert.deepEqual(missing.body.missing, ["fat_g"]);
});

// ---- calories printed per serving ----
test("calories printed per serving above per-100 g columns: scaled on the reader's word, and the grade is the label's", async () => {
  const s = await scan([crackers]);
  assert.equal(s.reads, 1); assert.equal(s.body.decision.action, "grade");
  assert.equal(s.body.per100.energy_kJ, 2224); assert.equal(s.body.grade.grade, "D"); assert.equal(s.body.grade.score, 15);
  assert.ok(s.body.flags.includes("energy_printed_per_serving_converted"));
  // A reader that calls the energy "same as the table", or cannot tell, is stopped and the label is read again; the same
  // picture on both reads is believed.
  for (const word of ["same_as_table", "unsure"]) {
    const twice = await scan([{ ...crackers, energy_basis: word }, { ...crackers, energy_basis: word }]);
    assert.equal(twice.reads, 2); assert.equal(twice.body.decision.action, "grade", word);
    assert.equal(twice.body.per100.energy_kJ, 2224); assert.equal(twice.body.grade.score, 15);
  }
  // The visitor's answer on such a label keeps the converted energy and the note.
  const asked = await scan([{ ...crackers, ...tableOnly, confidence: { ...crackers.confidence, category: 0.2 } }]);
  assert.equal(asked.body.decision.action, "ask_category");
  const picked = await post(asked.env, "/correct", answer(asked.body, { category: "general" }));
  assert.equal(picked.body.per100.energy_kJ, 2224); assert.equal(picked.body.grade.score, 15);
  assert.ok(picked.body.flags.includes("energy_printed_per_serving_converted"));
});

test("a correct energy is not rewritten because another row was misread", async () => {
  // Baked beans: 393 kJ per 100 g, half-can serving of 200 g printed. Right grade B, score 1.
  const misread = { ...beans, values: { ...beans.values, carb_g: 4.6 } };       // carbohydrate copied from the sugars row: halved, the energy would fit
  // One read with the misread: stopped, and the second read gets it right.
  const fixed = await scan([misread, beans]);
  assert.equal(fixed.reads, 2); assert.equal(fixed.body.grade.grade, "B"); assert.equal(fixed.body.per100.energy_kJ, 393);
  // The first read was stopped for another reason (a blurred salt figure) and only the second read misreads: seen once, not believed.
  const once = await scan([{ ...beans, confidence: { ...sure, salt: 0.3 } }, misread]);
  assert.equal(once.reads, 2); assert.equal(once.body.decision.action, "retake"); assert.equal(once.body.grade, undefined);
  // A reader that cannot tell what the energy is printed for, on the misread: never graded on a rewritten energy.
  const unsure = await scan([{ ...misread, energy_basis: "unsure" }, beans]);
  assert.equal(unsure.body.grade.grade, "B"); assert.equal(unsure.body.per100.energy_kJ, 393);
});

// ---- per-serving rounding, end to end ----
test("a per-serving label with 'carbohydrate 0 g, sugars 1 g' passes the scan and the visitor's answer alike", async () => {
  const cheese = R({ ...tableOnly, basis: "per_serving", serving_size: 28,
    values: { energy_kJ: null, energy_kcal: 85, fat_g: 6, satfat_g: 4, carb_g: 0, sugar_g: 1, fibre_g: 0, protein_g: 7, salt_g: null, sodium_mg: 160 }, confidence: { category: 0.2, salt: 0 } });
  const s = await scan([cheese]);
  assert.equal(s.body.decision.action, "ask_category");
  const ok = await post(s.env, "/correct", answer(s.body, { category: "cheese" }));
  assert.equal(ok.status, 200);
  const body = answer(s.body, { category: "cheese" }); delete body.reading.rounding_scale;
  const lost = await post(s.env, "/correct", body);
  assert.equal(lost.status, 400); assert.deepEqual(lost.body.checks.map(c => c.code), ["sugar_over_carb"]);
});

// ---- limits, storage and cache ----
test("the visitor's answer does not use up the scan allowance, and has its own limit", async () => {
  const env = makeEnv({ PER_DEVICE_PER_DAY: "1", CORRECTIONS_PER_MINUTE: "2" });
  const s = await scan([feta], env);
  assert.equal(s.body.decision.action, "ask_category");                                  // the day's one scan
  assert.equal((await post(env, "/correct", answer(s.body, { category: "cheese" }))).status, 200);
  assert.equal((await scan([feta], env)).status, 429);                                   // a second scan is refused
  assert.equal((await post(env, "/correct", answer(s.body, { category: "general" }))).status, 200);
  assert.equal((await post(env, "/correct", answer(s.body, { category: "cheese" }))).status, 429);   // third answer within the minute
  assert.equal((await post(makeEnv({ KILL_SWITCH: "on" }), "/correct", answer(s.body, { category: "cheese" }))).status, 503);
});

test("a scan refused for one address does not use up the daily cap everyone shares", async () => {
  const env = makeEnv({ PER_DEVICE_PER_MINUTE: "1", DAILY_SCAN_CAP: "2" });
  assert.equal((await scan([cereal], env, newPhoto(), "10.0.0.1")).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await scan([cereal], env, newPhoto(), "10.0.0.1")).status, 429);   // the same address, over its minute limit
  const other = await scan([cereal], env, newPhoto(), "10.0.0.2");
  assert.equal(other.status, 200); assert.equal(other.reads, 1);                         // the second scan of the day that was actually read
  assert.equal((await scan([cereal], env, newPhoto(), "10.0.0.3")).status, 503);         // the cap itself still holds
});

test("a write the store refuses never costs the visitor a label that was read", async () => {
  // The store allows one write a second to a key and, on the free plan, a number of writes a day; a refused write throws.
  const refusing = (prefixes, times = Infinity) => { const env = makeEnv(); const put = env.STORE.put.bind(env.STORE); let left = times;
    env.STORE.put = async (k, v) => { if (left > 0 && prefixes.some(p => k.startsWith(p))) { left--; throw new Error("KV PUT failed: 429 Too Many Requests"); } return put(k, v); }; return env; };
  // The log and the cache cannot be written: the grade is still returned.
  const noLog = await scan([cereal], refusing(["log:", "cache:"]));
  assert.equal(noLog.status, 200); assert.equal(noLog.body.grade.grade, "D");
  // A counter is busy for a moment (another scan wrote the same key in the same second): it is tried once more, and counted.
  for (const key of ["cap:", "rl:min:", "rl:day:"]) {
    const env = refusing([key], 1);
    const s = await scan([cereal], env);
    assert.equal(s.status, 200, key); assert.equal(s.body.grade.grade, "D");
    assert.equal([...env.STORE.m.entries()].find(([k]) => k.startsWith(key))[1], "1");
  }
  // A counter that cannot be written at all: the scan is not made (the counters guard the cost), and the page is told to try again, not that the service is down.
  for (const key of ["cap:", "rl:min:", "rl:day:"]) {
    const s = await scan([cereal], refusing([key]));
    assert.equal(s.status, 429, key); assert.equal(s.reads, 0);
  }
  // The visitor's answer goes through whatever the store refuses.
  const s = await scan([feta]);
  const answered = await post(refusing(["rl:cmin:", "corr:"]), "/correct", answer(s.body, { category: "cheese" }));
  assert.equal(answered.status, 200); assert.equal(answered.body.grade.grade, "D");
  // A store that cannot be read at all for the cache: the photo is simply read.
  const blind = makeEnv(); const get = blind.STORE.get.bind(blind.STORE);
  blind.STORE.get = async (k, o) => { if (k.startsWith("cache:")) throw new Error("KV GET failed"); return get(k, o); };
  const read = await scan([cereal], blind);
  assert.equal(read.status, 200); assert.equal(read.reads, 1);
});

test("a graded photo is answered from the cache; a grade stored by an earlier version of the checks is not", async () => {
  const env = makeEnv(), image = newPhoto();
  const first = await scan([cereal], env, image);
  assert.equal(first.body.grade.grade, "D"); assert.equal(first.reads, 1);
  const second = await scan([cereal], env, image);
  assert.equal(second.body.cached, true); assert.equal(second.reads, 0);
  // An entry under the key the previous version used (no version in it) is ignored: the photo is read again.
  const env2 = makeEnv(), image2 = newPhoto();
  const bytes = Uint8Array.from(atob(image2), c => c.charCodeAt(0));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  await env2.STORE.put(`cache:${digest}`, JSON.stringify({ grade: { ok: true, grade: "A" }, decision: { action: "grade" } }));
  const fresh = await scan([cereal], env2, image2);
  assert.equal(fresh.reads, 1); assert.equal(fresh.body.grade.grade, "D"); assert.equal(fresh.body.cached, undefined);
});

test("a request the page would never send is refused, not crashed on", async () => {
  const s = await scan([feta]);
  for (const category of ["constructor", "__proto__", "toString", "drinks"]) {
    const r = await post(s.env, "/correct", { ...answer(s.body, {}), category });
    assert.equal(r.status, 400, category);
  }
  const body = answer(s.body, { category: "cheese" });
  const noValues = await post(s.env, "/correct", { ...body, reading: { ...body.reading, values: "x" } });
  assert.equal(noValues.status, 400); assert.match(noValues.body.error, /reading to correct/);   // refused as a malformed request, before anything is graded
  assert.equal((await post(s.env, "/correct", { ...body, reading: [] })).status, 400);
  assert.equal((await post(s.env, "/correct", { ...body, values: "x" })).status, 200);   // values that are not a list of fields are simply no correction
  assert.equal((await post(s.env, "/correct", "not json")).status, 400);
});

test("probes: the fat confirmation line is 0.6, and thirty answers a minute are allowed by default", async () => {
  for (const [fat, status] of [[0.59, 400], [0.6, 200], [0.7, 200]]) {
    const s = await scan([{ ...nuts, confidence: { ...nuts.confidence, fat } }]);
    assert.equal((await post(s.env, "/correct", answer(s.body, { category: "fats" }))).status, status, `fat confidence ${fat}`);
  }
  const env = makeEnv(); delete env.CORRECTIONS_PER_MINUTE;
  const s = await scan([feta], env);
  for (let i = 1; i <= 30; i++) assert.equal((await post(env, "/correct", answer(s.body, { category: "cheese" }))).status, 200, `answer ${i}`);
  assert.equal((await post(env, "/correct", answer(s.body, { category: "cheese" }))).status, 429);
});
