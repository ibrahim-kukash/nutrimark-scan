// Unit tests for the checks and the reader-to-engine bridge. No network, no keys.
//   node --test backend/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toPer100, consistencyChecks, route, toEngineInput, energyGap, energyFromServing, prepareReading, drinkFactsUnknown, drinkAnswers, drinkOptions } from "../src/checks.js";
import { computeGrade } from "../../engine/nutrimark.js";

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, "..", "..", "engine", "rules.json"), "utf8"));

const cereal = {
  product_name: "Honey breakfast cereal", brand: null, barcode: null, label_language: "both",
  category: "general", category_reason: "breakfast cereal", basis: "per_100g", serving_size: null,
  values: { energy_kJ: 1407, energy_kcal: 335, fat_g: 5.0, satfat_g: 3.5, carb_g: 72, sugar_g: 15, fibre_g: 4.5, protein_g: 7.0, salt_g: 0.5, sodium_mg: null },
  fvl_pct_estimate: 0, fvl_basis: "none listed", sweeteners_present: false, sweeteners_listed: [], plain_water: false,
  red_meat_20_plus: null, is_cheese: false,
  confidence: { energy: 1, fat: 1, satfat: 1, carb: 1, sugar: 1, fibre: 1, protein: 1, salt: 1, category: 1, basis: 1 }, notes: "",
};

test("clean per-100 g reading grades D like the prototype and the official tool", () => {
  const per100 = toPer100(cereal.values, cereal.basis, cereal.serving_size);
  const checks = consistencyChecks(per100);
  assert.deepEqual(checks.filter(c => c.severity === "block"), []);
  assert.equal(route(cereal, checks).action, "grade");
  const { input, flags } = toEngineInput(cereal, per100);
  assert.deepEqual(flags, []);
  const g = computeGrade(rules, input);
  assert.equal(g.grade, "D"); assert.equal(g.score, 11);
});

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test("per-serving values scale to per 100 g, at full precision", () => {
  const per100 = toPer100({ energy_kJ: 422, fat_g: 1.5, satfat_g: 1.05, carb_g: 21.6, sugar_g: 4.5, fibre_g: 1.35, protein_g: 2.1, salt_g: 0.15, sodium_mg: null, energy_kcal: null }, "per_serving", 30);
  assert.ok(near(per100.energy_kJ, 422 * 100 / 30)); assert.ok(near(per100.sugar_g, 15)); assert.ok(near(per100.salt_g, 0.5));
  assert.equal(per100.sodium_mg, null);
});

test("a converted value is not rounded off a threshold it sits on", () => {
  // A real oil label: per 15 ml, fat 14 g, saturates 1.4 g: exactly 10% of the fat, which is where the first point starts.
  // Rounded to one decimal (93.3 and 9.3) the share reads 9.97% and the point is lost.
  const oil = { ...cereal, category: "fats", basis: "per_serving", serving_size: 15,
    values: { energy_kJ: null, energy_kcal: 124, fat_g: 14, satfat_g: 1.4, carb_g: 0, sugar_g: 0, fibre_g: 0, protein_g: 0, salt_g: null, sodium_mg: 0 } };
  const { per100 } = prepareReading(oil);
  const g = computeGrade(rules, toEngineInput(oil, per100).input);
  assert.equal(g.points.satfat_ratio_pct, 1); assert.equal(g.grade, "C"); assert.equal(g.score, 3);
});

test("per-serving without a serving size cannot be graded", () => {
  assert.equal(toPer100(cereal.values, "per_serving", null), null);
});

test("kJ/kcal mismatch and sugar above carbohydrate are blocking", () => {
  const checks = consistencyChecks({ ...cereal.values, energy_kJ: 1407, energy_kcal: 200, sugar_g: 80, carb_g: 72 });
  const codes = checks.filter(c => c.severity === "block").map(c => c.code);
  assert.ok(codes.includes("kJ_kcal_mismatch")); assert.ok(codes.includes("sugar_over_carb"));
});

test("tiny rounded energies are not a kJ/kcal mismatch: a zero-sugar drink is graded, not refused", () => {
  // Labels print "1 kJ / 0.2 kcal" or "5 kJ / 1 kcal": the ratio is off only because both numbers are rounded.
  for (const [kJ, kcal] of [[1, 0.2], [5, 1], [6, 1], [7, 2], [10, 2], [17, 5]]) {
    const codes = consistencyChecks({ ...cereal.values, energy_kJ: kJ, energy_kcal: kcal, fat_g: 0, satfat_g: 0, carb_g: 0, sugar_g: 0, fibre_g: 0, protein_g: 0, salt_g: 0.02 }).map(c => c.code);
    assert.ok(!codes.includes("kJ_kcal_mismatch"), `${kJ} kJ / ${kcal} kcal was refused`);
  }
  const zero = { ...cereal, product_name: "Cola zero", category: "beverages", basis: "per_100ml", sweeteners_present: true,
    values: { energy_kJ: 1, energy_kcal: 0.2, fat_g: 0, satfat_g: 0, carb_g: 0, sugar_g: 0, fibre_g: 0, protein_g: 0, salt_g: 0.02, sodium_mg: null } };
  const per100 = toPer100(zero.values, zero.basis, zero.serving_size);
  assert.equal(route(zero, consistencyChecks(per100), { attempt: 1 }).action, "grade");
  assert.equal(computeGrade(rules, toEngineInput(zero, per100).input).grade, "C");   // sweeteners 4 points, nothing else
});

test("a real kJ/kcal mismatch still blocks, at small and at large energies", () => {
  for (const [kJ, kcal] of [[1407, 200], [180, 20], [1, 3], [60, 5], [43, 180]]) {
    const codes = consistencyChecks({ ...cereal.values, energy_kJ: kJ, energy_kcal: kcal }).map(c => c.code);
    assert.ok(codes.includes("kJ_kcal_mismatch"), `${kJ} kJ / ${kcal} kcal was accepted`);
  }
});

test("low confidence on a required field goes to a second pass, then to retake", () => {
  const shaky = { ...cereal, confidence: { ...cereal.confidence, sugar: 0.3 } };
  assert.equal(route(shaky, [], { attempt: 1 }).action, "second_pass");
  assert.equal(route(shaky, [], { attempt: 2 }).action, "retake");
});

test("a sodium-only label is judged on the sodium figure's confidence, not on the absent salt line", () => {
  // US-style panel: per serving, kcal only, sodium printed, no salt line. The reader marks the absent salt line 0.
  const usStyle = { ...cereal, basis: "per_serving", serving_size: 40,
    values: { energy_kJ: null, energy_kcal: 170, fat_g: 5, satfat_g: 2.6, carb_g: 29, sugar_g: 19, fibre_g: 1, protein_g: 2, salt_g: null, sodium_mg: 252 } };
  const conf = (salt, sodium) => ({ ...cereal.confidence, salt, ...(sodium === undefined ? {} : { sodium }) });
  assert.equal(route({ ...usStyle, confidence: conf(0, 0.95) }, [], { attempt: 1 }).action, "grade");   // sodium read sharply: graded on the first read
  assert.equal(route({ ...usStyle, confidence: conf(0.9) }, [], { attempt: 1 }).action, "grade");       // a reader that files the sodium figure under 'salt'
  assert.equal(route({ ...usStyle, confidence: conf(0.9, 0) }, [], { attempt: 1 }).action, "grade");
  const blurred = { ...usStyle, confidence: conf(0, 0.3) };                                             // the sodium figure itself is blurred
  assert.deepEqual(route(blurred, [], { attempt: 1 }), { action: "second_pass", reasons: ["low_confidence_salt"] });
  assert.equal(route(blurred, [], { attempt: 2 }).action, "retake");
  assert.equal(route({ ...usStyle, confidence: conf(0) }, [], { attempt: 1 }).action, "second_pass");   // no confidence for either figure: low, never high
});

test("when salt is printed, a sharp sodium confidence does not rescue a blurred salt figure", () => {
  const shakySalt = { ...cereal, confidence: { ...cereal.confidence, salt: 0.3, sodium: 0.95 } };
  assert.deepEqual(route(shakySalt, [], { attempt: 1 }), { action: "second_pass", reasons: ["low_confidence_salt"] });
});

test("missing salt and sodium is a routing reason", () => {
  const noSalt = { ...cereal, values: { ...cereal.values, salt_g: null, sodium_mg: null } };
  const r = route(noSalt, []);
  assert.equal(r.action, "second_pass"); assert.ok(r.reasons.includes("missing_salt"));
});

test("sodium instead of salt reaches the engine and converts", () => {
  const sodium = { ...cereal, values: { ...cereal.values, salt_g: null, sodium_mg: 200 } };
  const per100 = toPer100(sodium.values, "per_100g", null);
  const { input } = toEngineInput(sodium, per100);
  const g = computeGrade(rules, input);
  assert.equal(g.ok, true); assert.equal(g.points.salt_g, 2);   // 200 mg -> 0.5 g salt -> 2 points
});

test("missing fibre is counted as 0 and flagged, not refused", () => {
  const noFibre = { ...cereal, values: { ...cereal.values, fibre_g: null } };
  const per100 = toPer100(noFibre.values, "per_100g", null);
  const { input, flags } = toEngineInput(noFibre, per100);
  assert.ok(flags.includes("fibre_not_declared_counted_as_0"));
  assert.equal(computeGrade(rules, input).ok, true);
});

test("plain bottled water with no table is graded A on the spot", () => {
  const water = { ...cereal, category: "beverages", basis: "unsure", plain_water: true,
    values: { energy_kJ: null, energy_kcal: null, fat_g: null, satfat_g: null, carb_g: null, sugar_g: null, fibre_g: null, protein_g: null, salt_g: null, sodium_mg: null },
    confidence: { energy: 0, fat: 0, satfat: 0, carb: 0, sugar: 0, fibre: 0, protein: 0, salt: 0, category: 0.98, basis: 0.2 } };
  const r = route(water, [], { attempt: 1 });
  assert.equal(r.action, "grade");
  const { input } = toEngineInput(water, {});
  assert.equal(computeGrade(rules, input).grade, "A");
});

test("a confidently read label that omits sugars, saturates and salt is incomplete, not unreadable", () => {
  const tea = { ...cereal, category: "general", basis: "per_100g",
    values: { energy_kJ: null, energy_kcal: 189.1, fat_g: 3.8, satfat_g: null, carb_g: 42.6, sugar_g: null, fibre_g: null, protein_g: 3.9, salt_g: null, sodium_mg: null },
    confidence: { energy: 0.96, fat: 0.95, satfat: 0, carb: 0.95, sugar: 0, fibre: 0, protein: 0.95, salt: 0, category: 0.9, basis: 0.95 } };
  assert.equal(route(tea, [], { attempt: 1 }).action, "second_pass");
  const r = route(tea, [], { attempt: 2 });
  assert.equal(r.action, "incomplete_label");
  assert.deepEqual(r.missing.sort(), ["salt", "satfat_g", "sugar_g"]);
});

test("a non-food photo is routed as not_food", () => {
  assert.equal(route({ ...cereal, category: "other" }, []).action, "not_food");
});

test("a recognised product with no values at all is a no-table retake on the first read, never a second read", () => {
  const front = { ...cereal, category: "beverages", basis: "unsure", plain_water: false,
    values: { energy_kJ: null, energy_kcal: null, fat_g: null, satfat_g: null, carb_g: null, sugar_g: null, fibre_g: null, protein_g: null, salt_g: null, sodium_mg: null },
    confidence: { energy: 0, fat: 0, satfat: 0, carb: 0, sugar: 0, fibre: 0, protein: 0, salt: 0, category: 0.9, basis: 0.1 } };
  const r = route(front, [], { attempt: 1 });
  assert.equal(r.action, "retake"); assert.ok(r.reasons.includes("no_table_in_photo"));
});

test("a front-of-pack calorie badge never blames the label", () => {
  const badge = { ...cereal, category: "general", basis: "per_serving", serving_size: 30, nutrition_table_visible: false,
    values: { energy_kJ: null, energy_kcal: 150, fat_g: null, satfat_g: null, carb_g: null, sugar_g: null, fibre_g: null, protein_g: null, salt_g: null, sodium_mg: null },
    confidence: { energy: 0.95, fat: 0, satfat: 0, carb: 0, sugar: 0, fibre: 0, protein: 0, salt: 0, category: 0.9, basis: 0.9 } };
  assert.notEqual(route(badge, [], { attempt: 2 }).action, "incomplete_label");
});

test("the reader's table flag alone never licenses an incomplete-label claim", () => {
  const badge = { ...cereal, category: "general", basis: "per_serving", serving_size: 30, nutrition_table_visible: true,
    values: { energy_kJ: null, energy_kcal: 150, fat_g: null, satfat_g: null, carb_g: null, sugar_g: null, fibre_g: null, protein_g: null, salt_g: null, sodium_mg: null },
    confidence: { energy: 0.95, fat: 0, satfat: 0, carb: 0, sugar: 0, fibre: 0, protein: 0, salt: 0, category: 0.9, basis: 0.9 } };
  assert.equal(route(badge, [], { attempt: 2 }).action, "retake");
});

test("the table flag plus two confident values is enough evidence of a real table", () => {
  const partial = { ...cereal, category: "general", basis: "per_100g", nutrition_table_visible: true,
    values: { energy_kJ: null, energy_kcal: 150, fat_g: 2, satfat_g: null, carb_g: null, sugar_g: null, fibre_g: null, protein_g: null, salt_g: null, sodium_mg: null },
    confidence: { energy: 0.95, fat: 0.95, satfat: 0, carb: 0, sugar: 0, fibre: 0, protein: 0, salt: 0, category: 0.9, basis: 0.95 } };
  const r = route(partial, [], { attempt: 2 });
  assert.equal(r.action, "incomplete_label"); assert.deepEqual(r.missing.sort(), ["salt", "satfat_g", "sugar_g"]);
});

test("an unsure category with no values at all is not food, not a retake", () => {
  const nothing = { ...cereal, category: "unsure",
    values: { energy_kJ: null, energy_kcal: null, fat_g: null, satfat_g: null, carb_g: null, sugar_g: null, fibre_g: null, protein_g: null, salt_g: null, sodium_mg: null },
    confidence: { energy: 0, fat: 0, satfat: 0, carb: 0, sugar: 0, fibre: 0, protein: 0, salt: 0, category: 0, basis: 0 } };
  const r = route(nothing, [], { attempt: 1 });
  assert.equal(r.action, "not_food"); assert.ok(r.reasons.includes("no_values_found"));
});

test("beverage with sweetener and plain water take the beverage paths", () => {
  const cola = { ...cereal, category: "beverages", basis: "per_100ml", values: { energy_kJ: 180, energy_kcal: 43, fat_g: 0, satfat_g: 0, carb_g: 10.6, sugar_g: 10.6, fibre_g: 0, protein_g: 0, salt_g: 0.01, sodium_mg: null }, sweeteners_present: true };
  const g1 = computeGrade(rules, toEngineInput(cola, cola.values).input);
  assert.equal(g1.category, "beverages"); assert.equal(g1.points.sweeteners, 4); assert.equal(g1.grade, "E");
  const water = { ...cola, plain_water: true, sweeteners_present: false, values: { ...cola.values, energy_kJ: 0, sugar_g: 0 } };
  assert.equal(computeGrade(rules, toEngineInput(water, water.values).input).grade, "A");
});

// ---- Fixes from the real-label test of 15 Nov 2026 (44 UAE label photos plus four products checked by hand) ----

// A real jar: "Calories per serving 556 kJ / 133 kcal" printed above columns per 100 g and per 25 g. Read on 15 Nov 2026.
const seedCrackers = { ...cereal, product_name: "Multi Seeds Protein Cracker with Zaatar", category: "general", basis: "per_100g", serving_size: 25,
  values: { energy_kJ: 556, energy_kcal: 133, fat_g: 31.76, satfat_g: 4.96, carb_g: 31, sugar_g: 0, fibre_g: 10.5, protein_g: 30, salt_g: null, sodium_mg: 849 },
  confidence: { ...cereal.confidence, salt: 0, sodium: 1, category: 0.8 } };

test("calories printed per serving above per-100 g columns are scaled when the reader says so, and the grade is the label's real one", () => {
  const reading = { ...structuredClone(seedCrackers), energy_basis: "per_serving" };
  const { per100, checks } = prepareReading(reading);
  assert.equal(per100.energy_kJ, 2224); assert.equal(per100.energy_kcal, 532);
  assert.equal(per100.satfat_g, 4.96); assert.equal(per100.sodium_mg, 849);          // nothing but energy is touched
  assert.equal(reading.energy_converted_from_serving, true);
  assert.deepEqual(checks.filter(c => c.severity === "block"), []);
  assert.equal(route(reading, checks, { attempt: 1 }).action, "grade");
  const { input, flags } = toEngineInput(reading, per100);
  assert.ok(flags.includes("energy_printed_per_serving_converted"));
  const g = computeGrade(rules, input);
  assert.equal(g.grade, "D"); assert.equal(g.score, 15);                              // before the fix: C, score 10, from 556 kJ
});

test("an energy that already fits the other values is never rescaled, whatever serving size is printed", () => {
  const per100 = toPer100(cereal.values, "per_100g", null);
  // 90 and 110: scaled from those servings the energy would still fit, so only the "it already fits" rule keeps it as printed.
  for (const serving_size of [30, 25, 250, 100, 90, 110, null]) for (const energy_basis of [undefined, "unsure", "same_as_table", "per_serving"]) for (const attempt of [1, 2]) for (const patternBefore of [false, true]) {
    const r = energyFromServing(per100, { basis: "per_100g", serving_size, energy_basis }, { attempt, patternBefore });
    const scaledAlsoFits = serving_size === 90 || serving_size === 110;
    if (energy_basis === "per_serving" && scaledAlsoFits) continue;                    // the reader saw the words and the numbers do not contradict it: scaled
    assert.ok(!r || !r.per100, `rescaled at serving ${serving_size}, ${energy_basis}, attempt ${attempt}`);
    // A reader that could not tell, on a label where both readings of the energy fit: nobody knows, so the read stops.
    const unsure = energy_basis === undefined || energy_basis === "unsure";
    assert.equal(!!(r && r.problem), unsure && scaledAlsoFits, `serving ${serving_size}, ${energy_basis}`);
  }
  const reading = { ...structuredClone(cereal), serving_size: 30 };
  assert.equal(prepareReading(reading).per100.energy_kJ, 1407);
  assert.equal(reading.energy_converted_from_serving, undefined);
});

test("a per-serving label is converted by its serving size alone: the energy rescue does not apply to it", () => {
  // 127 kJ per 30 g serving beside macronutrients that imply about 1500 kJ per 100 g. Converted it is 423 kJ: far off,
  // and scaling it once more would fit. The rescue is for per-100 columns only; a per-serving label like this one is stopped.
  const perServing = { energy_kJ: 127, energy_kcal: null, fat_g: 1.5, satfat_g: 1.05, carb_g: 21.6, sugar_g: 4.5, fibre_g: 1.35, protein_g: 2.1, salt_g: 0.15, sodium_mg: null };
  const reading = { ...structuredClone(cereal), basis: "per_serving", serving_size: 30, values: perServing };
  for (const energy_basis of [undefined, "unsure", "per_serving"]) assert.equal(energyFromServing(toPer100(perServing, "per_serving", 30), { ...reading, energy_basis }), null);
  const { per100, checks } = prepareReading(reading);
  assert.ok(near(per100.energy_kJ, 127 * 100 / 30));
  assert.equal(reading.energy_converted_from_serving, undefined);
  assert.ok(checks.some(c => c.code === "energy_vs_macros" && c.severity === "block"));
});

test("an energy far from the other values that the serving size does not explain stops the read", () => {
  const wrong = { ...structuredClone(cereal), serving_size: 30, values: { ...cereal.values, energy_kJ: 250, energy_kcal: 60 } };   // 250 kJ against about 1500
  const { per100, checks } = prepareReading(wrong);
  assert.equal(per100.energy_kJ, 250);                                               // 250 * 100/30 = 833 does not fit either: left as read
  assert.ok(checks.some(c => c.code === "energy_vs_macros" && c.severity === "block"));
  assert.equal(route(wrong, checks, { attempt: 1 }).action, "second_pass");
  assert.equal(route(wrong, checks, { attempt: 2 }).action, "retake");
});

test("energy against macronutrients: honest labels pass, 30 to 40% warns, above 40% blocks", () => {
  const base = { fat_g: 10, carb_g: 50, protein_g: 10, fibre_g: 0 };                  // implies 1390 kJ
  const sev = kJ => (consistencyChecks({ ...base, energy_kJ: kJ }).find(c => c.code === "energy_vs_macros") || {}).severity;
  assert.equal(sev(1390), undefined); assert.equal(sev(1200), undefined);             // 14% off
  assert.equal(sev(900), "warn");                                                      // 35% off
  assert.equal(sev(700), "block");                                                     // 50% off
  // The two lines themselves: nothing up to 30%, a warning up to 40%, a stop above.
  assert.equal(sev(980), undefined); assert.equal(sev(965), "warn");                   // 29.5% and 30.6%
  assert.equal(sev(840), "warn"); assert.equal(sev(825), "block");                     // 39.6% and 40.6%
  // Fibre counted inside carbohydrate (US-style panel): bran with 60 g carbohydrate of which 40 g fibre. Not a misread,
  // and not "more than 100 g of nutrients in 100 g" either.
  const bran = { energy_kJ: 1100, fat_g: 5, carb_g: 60, protein_g: 15, fibre_g: 40 };
  assert.ok(energyGap(1100, bran) < 0.02);
  assert.deepEqual(consistencyChecks(bran), []);
  assert.ok(consistencyChecks({ energy_kJ: 2100, fat_g: 40, carb_g: 50, protein_g: 20, fibre_g: 5 }).some(c => c.code === "macros_over_100"));   // 110 g either way
  assert.ok(consistencyChecks({ energy_kJ: 1500, fat_g: 10, carb_g: 30, protein_g: 20, fibre_g: 50 }).some(c => c.code === "macros_over_100")); // fibre above carbohydrate cannot be inside it
  // Too little energy to compare, or a macronutrient missing: no judgement. The line is 150 kJ.
  assert.equal(energyGap(72, { fat_g: 0.9, carb_g: 4, protein_g: 0.9 }), null);
  assert.equal(energyGap(1400, { fat_g: 5, carb_g: null, protein_g: 7 }), null);
  assert.equal(energyGap(140, { fat_g: 0, carb_g: 8.8, protein_g: 0 }), null);         // implies 149.6 kJ, prints 140: both under the line
  assert.notEqual(energyGap(140, { fat_g: 0, carb_g: 8.9, protein_g: 0 }), null);      // implies 151.3 kJ
  assert.notEqual(energyGap(400, { fat_g: 0, carb_g: 8.8, protein_g: 0 }), null);      // a printed energy far above what a light drink's numbers imply is judged
  // A fibre figure read ten times too large (3.0 as 30) is not excused as "fibre inside carbohydrate": the label's own energy
  // does not fit that reading. Real label: 355 kcal, fat 2.6, carbohydrate 75, protein 8.
  assert.ok(consistencyChecks({ energy_kcal: 355, fat_g: 2.6, carb_g: 75, protein_g: 8, fibre_g: 30 }).some(c => c.code === "macros_over_100"));
  assert.deepEqual(consistencyChecks({ energy_kcal: 355, fat_g: 2.6, carb_g: 75, protein_g: 8, fibre_g: 3 }), []);
});

test("a small serving printed in whole numbers is not judged on energy: rounding alone can be 40%", () => {
  // US-style panel, 10 g serving: "10 calories, carbohydrate 4 g, protein 1 g". Per 100 g that is 418 kJ against 850 implied.
  const per100 = toPer100({ energy_kcal: 10, fat_g: 0, satfat_g: 0, carb_g: 4, sugar_g: 0, protein_g: 1, sodium_mg: 15 }, "per_serving", 10);
  assert.ok(consistencyChecks(per100).some(c => c.code === "energy_vs_macros" && c.severity === "block"));   // judged as if printed per 100 g
  assert.deepEqual(consistencyChecks(per100, { scale: 10 }).filter(c => c.code === "energy_vs_macros"), []);   // one serving implies 85 kJ: under the line
  // A normal serving is still judged: 30 g, 40 calories against fat 3 g, carbohydrate 20 g and protein 3 g, which imply 120.
  const big = toPer100({ energy_kcal: 40, fat_g: 3, satfat_g: 1, carb_g: 20, sugar_g: 5, protein_g: 3, sodium_mg: 100 }, "per_serving", 30);
  assert.ok(consistencyChecks(big, { scale: 100 / 30 }).some(c => c.code === "energy_vs_macros" && c.severity === "block"));
  // The exemption is for servings whose printed energy is small too. An oil per 15 ml with 124 calories and its fat read
  // as 1.4 g for 14 g implies little energy, but prints a lot: judged, and stopped.
  const oil = toPer100({ energy_kcal: 124, fat_g: 1.4, satfat_g: 2, carb_g: 0, sugar_g: 0, protein_g: 0, sodium_mg: 0 }, "per_serving", 15);
  assert.ok(consistencyChecks(oil, { scale: 100 / 15 }).some(c => c.code === "energy_vs_macros" && c.severity === "block"));
});

test("a sugar-free product is not refused: polyols carry 10 kJ per gram, not 17", () => {
  // A real sugar-free gum label, per 100 g: 614 kJ / 147 kcal, carbohydrate 61 g of which sugars 0 g and polyols 61 g.
  const gum = { energy_kJ: 614, energy_kcal: 147, fat_g: 0, satfat_g: 0, carb_g: 61, sugar_g: 0, polyols_g: 61, fibre_g: null, protein_g: 0, salt_g: 0, sodium_mg: null };
  assert.deepEqual(consistencyChecks(gum), []);
  // Erythritol carries no energy at all: a table-top sweetener with 0 kJ and 100 g carbohydrate, all of it polyols.
  assert.deepEqual(consistencyChecks({ ...gum, energy_kJ: 0, energy_kcal: 0, carb_g: 100, polyols_g: 100 }), []);
  // The polyols row excuses only what polyols explain: the same label with the energy of another column is still stopped.
  assert.ok(consistencyChecks({ ...gum, energy_kJ: 1800, energy_kcal: 430 }).some(c => c.code === "energy_vs_macros" && c.severity === "block"));
  // Without a polyols row the gap stays what it is.
  assert.ok(consistencyChecks({ ...gum, polyols_g: null }).some(c => c.code === "energy_vs_macros"));
});

test("whole-gram rounding is not a contradiction: carbohydrate 0 g with sugars 1 g is accepted", () => {
  // A real cheese label (15 Nov 2026): carbohydrate 0 g, sugars 1 g, per 100 g.
  const cheese = { energy_kcal: 302, fat_g: 22, satfat_g: 14, carb_g: 0, sugar_g: 1, fibre_g: 0, protein_g: 25, sodium_mg: 560 };
  assert.deepEqual(consistencyChecks(cheese).filter(c => c.severity === "block"), []);
  assert.ok(consistencyChecks({ ...cheese, sugar_g: 3 }).some(c => c.code === "sugar_over_carb"));        // two grams over is not rounding
  // Per-serving label, 28 g serving: "carbohydrate 0 g, sugars 1 g" becomes 0 against 3.6 per 100 g.
  const scale = 100 / 28;
  const per100 = toPer100({ ...cheese, carb_g: 0, sugar_g: 1 }, "per_serving", 28);
  assert.ok(consistencyChecks(per100).some(c => c.code === "sugar_over_carb"));                            // without the scale it would be refused
  assert.equal(consistencyChecks(per100, { scale }).some(c => c.code === "sugar_over_carb"), false);
  // The allowance is capped: a tiny serving does not excuse a real contradiction.
  assert.ok(consistencyChecks({ ...cheese, carb_g: 2, sugar_g: 9 }, { scale: 20 }).some(c => c.code === "sugar_over_carb"));
  // Saturates above total fat follow the same rule.
  assert.equal(consistencyChecks({ ...cheese, fat_g: 0, satfat_g: 1, energy_kcal: 100 }).some(c => c.code === "satfat_over_fat"), false);
  assert.ok(consistencyChecks({ ...cheese, fat_g: 5, satfat_g: 14 }).some(c => c.code === "satfat_over_fat"));
  assert.ok(consistencyChecks({ ...cheese, carb_g: 0, sugar_g: 2 }).some(c => c.code === "sugar_over_carb"));         // one gram is rounding, two are not
  // A label that prints decimals does not round to whole grams: milk with carbohydrate 4.7 g and sugars read as 5.7 g is a misread.
  const milk = { energy_kcal: 62, fat_g: 3.2, satfat_g: 2.1, carb_g: 4.7, sugar_g: 5.7, protein_g: 3.2, sodium_mg: 40 };
  assert.ok(consistencyChecks(milk).some(c => c.code === "sugar_over_carb"));
  assert.equal(consistencyChecks({ ...milk, sugar_g: 5.1 }).some(c => c.code === "sugar_over_carb"), false);           // within half a gram, as before
  // A serving above 100: one printed gram is less than a gram per 100. Per 250 ml, carbohydrate 12 g and sugars 14.5 g is a contradiction.
  const can = toPer100({ energy_kcal: 105, fat_g: 0, satfat_g: 0, carb_g: 12, sugar_g: 14.5, protein_g: 0, sodium_mg: 10 }, "per_serving", 250);
  assert.ok(consistencyChecks(can, { scale: 100 / 250 }).some(c => c.code === "sugar_over_carb"));
  const canOk = toPer100({ energy_kcal: 105, fat_g: 0, satfat_g: 0, carb_g: 26, sugar_g: 27, protein_g: 0, sodium_mg: 10 }, "per_serving", 250);
  assert.equal(consistencyChecks(canOk, { scale: 100 / 250 }).some(c => c.code === "sugar_over_carb"), false);       // 26 g and 27 g: one printed gram
  // The cap is five grams per 100: a scale of 5.5 allows no more than a scale of 5.
  assert.ok(consistencyChecks({ ...cheese, carb_g: 0, sugar_g: 5.2 }, { scale: 5.5 }).some(c => c.code === "sugar_over_carb"));
  assert.equal(consistencyChecks({ ...cheese, carb_g: 0, sugar_g: 5 }, { scale: 5.5 }).some(c => c.code === "sugar_over_carb"), false);
});

test("the per-serving rounding allowance travels with the reading: scan, then the visitor's answer", () => {
  // A cheese label per 28 g serving: carbohydrate 0 g, sugars 1 g.
  const cheese = { ...structuredClone(cereal), category: "unsure", basis: "per_serving", serving_size: 28,
    values: { energy_kJ: null, energy_kcal: 85, fat_g: 6, satfat_g: 4, carb_g: 0, sugar_g: 1, fibre_g: 0, protein_g: 7, salt_g: null, sodium_mg: 160 },
    confidence: { ...cereal.confidence, salt: 0, sodium: 1, category: 0.2 } };
  const { per100, checks } = prepareReading(cheese);
  assert.ok(near(cheese.rounding_scale, 100 / 28));
  assert.deepEqual(checks.filter(c => c.severity === "block"), []);
  assert.equal(route(cheese, checks, { attempt: 1 }).action, "ask_category");
  // The page sends the per-100 values back with the reading; the allowance must be the scan's, not a per-100 label's.
  assert.deepEqual(consistencyChecks(per100, { scale: cheese.rounding_scale }).filter(c => c.severity === "block"), []);
  assert.ok(consistencyChecks(per100, { scale: 1 }).some(c => c.code === "sugar_over_carb"));
});

test("every number read but the kind of product unknown: the visitor is asked, on the first read, with no second read", () => {
  // A close-up of a nutrition table: the reader cannot tell what the product is.
  const tableOnly = { ...structuredClone(cereal), category: "unsure", confidence: { ...cereal.confidence, category: 0.2 } };
  assert.deepEqual(route(tableOnly, [], { attempt: 1 }), { action: "ask_category", reasons: ["category_unclear"] });
  assert.equal(route(tableOnly, [], { attempt: 2 }).action, "ask_category");
  // A guess the reader is not sure of is not used either.
  const guess = { ...structuredClone(cereal), category: "cheese", confidence: { ...cereal.confidence, category: 0.5 } };
  assert.equal(route(guess, [], { attempt: 1 }).action, "ask_category");
  // A confident category is graded as before.
  assert.equal(route({ ...structuredClone(cereal), confidence: { ...cereal.confidence, category: 0.6 } }, [], { attempt: 1 }).action, "grade");
});

test("the visitor is asked only when the category is the single open question", () => {
  const shaky = { ...structuredClone(cereal), category: "unsure", confidence: { ...cereal.confidence, category: 0.2, sugar: 0.3 } };
  assert.equal(route(shaky, [], { attempt: 1 }).action, "second_pass");               // a blurred number still gets its second read
  assert.equal(route(shaky, [], { attempt: 2 }).action, "retake");
  const noSalt = { ...structuredClone(cereal), category: "unsure", values: { ...cereal.values, salt_g: null }, confidence: { ...cereal.confidence, category: 0.2 } };
  assert.notEqual(route(noSalt, [], { attempt: 1 }).action, "ask_category");          // a missing required value is not hidden behind the question
  const blocked = { ...structuredClone(cereal), category: "unsure", confidence: { ...cereal.confidence, category: 0.2 } };
  assert.notEqual(route(blocked, [{ code: "sugar_over_carb", severity: "block" }], { attempt: 1 }).action, "ask_category");
  const noBasis = { ...structuredClone(cereal), category: "unsure", basis: "unsure", confidence: { ...cereal.confidence, category: 0.2 } };
  assert.notEqual(route(noBasis, [], { attempt: 1 }).action, "ask_category");
  // No values at all and no category: still "not a food label", never a question.
  const nothing = { ...structuredClone(cereal), category: "unsure",
    values: Object.fromEntries(Object.keys(cereal.values).map(k => [k, null])), confidence: Object.fromEntries(Object.keys(cereal.confidence).map(k => [k, 0])) };
  assert.equal(route(nothing, [], { attempt: 1 }).action, "not_food");
});

test("a table-only reading grades correctly once the visitor names the category", () => {
  // Real label, 15 Nov 2026: feta cheese, table only. As cheese it is D (18); as a general food it would be E (24).
  const feta = { ...structuredClone(cereal), product_name: null, category: "unsure", basis: "per_100g", serving_size: null,
    values: { energy_kJ: null, energy_kcal: 184, fat_g: 11.6, satfat_g: 7.9, carb_g: 5.3, sugar_g: 5.3, fibre_g: null, protein_g: 14.5, salt_g: null, sodium_mg: 1200 },
    confidence: { ...cereal.confidence, salt: 0, sodium: 1, fibre: 0, category: 0.2 } };
  const { per100, checks } = prepareReading(feta);
  assert.equal(route(feta, checks, { attempt: 1 }).action, "ask_category");
  const as = category => computeGrade(rules, toEngineInput({ ...feta, category }, per100).input);
  assert.equal(as("cheese").grade, "D"); assert.equal(as("cheese").score, 18);
  assert.equal(as("general").grade, "E");
});

// ---- Fixes from the independent review of 15 Nov 2026 ----

test("the reader says the energy is per serving: it is scaled even where the numbers alone could not tell", () => {
  const gradeOf = reading => { const { per100, checks } = prepareReading(reading); return { per100, checks, reading, g: computeGrade(rules, toEngineInput(reading, per100).input) }; };
  // The jar again, with the carbohydrate row hidden by glare: the macronutrient comparison cannot run.
  const jarRead = energy_basis => ({ ...structuredClone(seedCrackers), energy_basis, values: { ...seedCrackers.values, carb_g: null }, confidence: { ...seedCrackers.confidence, carb: 0 } });
  const a = gradeOf(jarRead("per_serving"));
  assert.equal(a.per100.energy_kJ, 2224); assert.equal(a.reading.energy_converted_from_serving, true);
  assert.equal(a.g.grade, "D"); assert.equal(a.g.score, 15);
  // The same reading from a reader that could not tell what the energy is printed for: nobody knows, so nothing is graded.
  for (const energy_basis of ["unsure", undefined, "something else"]) {
    const silent = jarRead(energy_basis);
    const s = prepareReading(silent);
    assert.equal(s.per100.energy_kJ, 556); assert.equal(silent.energy_converted_from_serving, undefined);
    assert.ok(s.checks.some(c => c.code === "energy_basis_unclear" && c.severity === "block"));
    assert.equal(route(silent, s.checks, { attempt: 1 }).action, "second_pass");
    assert.equal(route(silent, s.checks, { attempt: 2 }).action, "retake");
  }
  // A low-energy drink: "per serving 250 ml: 363 kJ / 85 kcal" above per-100 ml columns.
  const tea = { ...structuredClone(cereal), category: "beverages", basis: "per_100ml", serving_size: 250, energy_basis: "per_serving", ingredients_visible: true,
    values: { energy_kJ: 363, energy_kcal: 85, fat_g: 0, satfat_g: 0, carb_g: 8.5, sugar_g: 8.5, fibre_g: 0, protein_g: 0, salt_g: 0.01, sodium_mg: null } };
  const b = gradeOf(tea);
  assert.ok(near(b.per100.energy_kJ, 145.2)); assert.ok(near(b.per100.energy_kcal, 34));
  assert.equal(b.g.grade, "D"); assert.equal(b.g.score, 9);                              // graded on 363 kJ it would be E, score 16
  // The same drink when the reader calls that energy "same as the table": 363 kJ is far above what 8.5 g of sugars imply, so the read stops.
  const teaWrong = { ...structuredClone(tea), energy_basis: "same_as_table" };
  const tw = prepareReading(teaWrong);
  assert.ok(tw.checks.some(c => c.code === "energy_vs_macros" && c.severity === "block"));
  // A serving near 100 g: the numbers alone cannot tell 1446 kJ per 65 g from per 100 g. The reader can.
  const pack65 = gradeOf({ ...structuredClone(seedCrackers), serving_size: 65, energy_basis: "per_serving", values: { ...seedCrackers.values, energy_kJ: 1446, energy_kcal: 346 } });
  assert.ok(near(pack65.per100.energy_kJ, 1446 * 100 / 65)); assert.equal(pack65.g.score, 15);
  // ... and a reader that is unsure about it is not graded: the scaled energy would fit too.
  const pack65unsure = { ...structuredClone(seedCrackers), serving_size: 65, energy_basis: "unsure", values: { ...seedCrackers.values, energy_kJ: 1446, energy_kcal: 346 } };
  assert.ok(prepareReading(pack65unsure).checks.some(c => c.code === "energy_basis_unclear"));
});

test("the reader's word on the energy is cross-checked, and never taken without a serving size", () => {
  // "Per serving" is claimed, but the energy fits the other values as printed and would not fit once scaled: left as printed.
  const wrongRemark = { ...structuredClone(cereal), serving_size: 30, energy_basis: "per_serving" };
  const a = prepareReading(wrongRemark);
  assert.equal(a.per100.energy_kJ, 1407); assert.equal(wrongRemark.energy_converted_from_serving, undefined);
  assert.equal(route(wrongRemark, a.checks, { attempt: 1 }).action, "grade");
  // "Per serving" with no serving size on the label: the energy cannot be put on a per-100 basis, so the read stops...
  const noSize = { ...structuredClone(seedCrackers), serving_size: null, energy_basis: "per_serving" };
  const b = prepareReading(noSize);
  assert.ok(b.checks.some(c => c.code === "energy_per_serving_without_serving_size" && c.severity === "block"));
  assert.equal(route(noSize, b.checks, { attempt: 1 }).action, "second_pass");
  assert.equal(route(noSize, b.checks, { attempt: 2 }).action, "retake");
  // ... unless the energy plainly fits its own columns: then the remark is simply wrong, and the label is graded.
  const fits = { ...structuredClone(cereal), serving_size: null, energy_basis: "per_serving" };
  const f = prepareReading(fits);
  assert.deepEqual(f.checks, []); assert.equal(route(fits, f.checks, { attempt: 1 }).action, "grade");
  // A serving of exactly 100 needs no scaling.
  assert.equal(energyFromServing(toPer100(cereal.values, "per_100g", null), { basis: "per_100g", serving_size: 100, energy_basis: "per_serving" }), null);
  // Scaled, the energy must still agree with the other values, or the read stops: 250 kJ said to be per 30 g gives 833 against about 1500.
  const neither = { ...structuredClone(cereal), serving_size: 30, energy_basis: "per_serving", values: { ...cereal.values, energy_kJ: 250, energy_kcal: 60 } };
  const c = prepareReading(neither);
  assert.ok(near(c.per100.energy_kJ, 250 * 100 / 30));
  assert.ok(c.checks.some(k => k.code === "energy_vs_macros" && k.severity === "block"));
});

test("the numbers alone never rescale the energy on one read; seen on two reads, they are believed", () => {
  // Baked beans, 200 g half-can serving printed, carbohydrate copied from the sugars row (4.6 for 16.4). The energy, 393 kJ, is right.
  // Halved it would fit the misread values: a coincidence of one misread row.
  const beans = { ...structuredClone(cereal), serving_size: 200,
    values: { energy_kJ: 393, energy_kcal: 93, fat_g: 0.25, satfat_g: 0.1, carb_g: 4.6, sugar_g: 4.6, fibre_g: 4, protein_g: 6.2, salt_g: 0.6, sodium_mg: null } };
  for (const energy_basis of ["same_as_table", "unsure", undefined]) {
    const first = { ...structuredClone(beans), energy_basis };
    const a = prepareReading(first, { attempt: 1 });
    assert.equal(a.per100.energy_kJ, 393); assert.equal(first.energy_converted_from_serving, undefined);
    assert.equal(a.energy_pattern, true);                                              // the picture is noted for the second read
    assert.ok(a.checks.some(c => c.code === "energy_vs_macros" && c.severity === "block"));
    assert.equal(route(first, a.checks, { attempt: 1 }).action, "second_pass");        // a stronger read looks again
    // A second read that shows the picture for the first time (the first one stopped for another reason) is not believed either.
    const lone = { ...structuredClone(beans), energy_basis };
    const l = prepareReading(lone, { attempt: 2, patternBefore: false });
    assert.equal(l.per100.energy_kJ, 393); assert.equal(route(lone, l.checks, { attempt: 2 }).action, "retake");
  }
  // The jar, whose reader calls the energy "same as the table" both times: the same picture on two reads is believed, and the serving explains it.
  const jar1 = { ...structuredClone(seedCrackers), energy_basis: "same_as_table" };
  const j1 = prepareReading(jar1, { attempt: 1 });
  assert.equal(j1.per100.energy_kJ, 556); assert.equal(j1.energy_pattern, true);
  assert.equal(route(jar1, j1.checks, { attempt: 1 }).action, "second_pass");
  const jar2 = { ...structuredClone(seedCrackers), energy_basis: "same_as_table" };
  const j2 = prepareReading(jar2, { attempt: 2, patternBefore: j1.energy_pattern });
  assert.equal(j2.per100.energy_kJ, 2224); assert.equal(jar2.energy_converted_from_serving, true);
  assert.equal(route(jar2, j2.checks, { attempt: 2 }).action, "grade");
  // The numbers must say it clearly: scaled energy within 15%, printed energy more than 40% off.
  const per100 = { energy_kJ: 800, fat_g: 10, carb_g: 50, protein_g: 10, fibre_g: 0 };  // implies 1390: 42% off
  const picture = serving_size => (energyFromServing(per100, { basis: "per_100g", serving_size, energy_basis: "same_as_table" }) || {}).pattern === true;
  assert.equal(picture(50), false);                                                    // scaled 1600: 15.1% off
  assert.equal(picture(51), true);                                                     // scaled 1569: 12.8% off
  assert.equal(energyFromServing({ ...per100, energy_kJ: 840 }, { basis: "per_100g", serving_size: 60, energy_basis: "same_as_table" }), null);   // 39.6% off: a warning, not this picture
  // In that in-between case a reader that is unsure cannot be graded: 840 kJ scaled from 60 g fits as well.
  assert.equal((energyFromServing({ ...per100, energy_kJ: 840 }, { basis: "per_100g", serving_size: 60, energy_basis: "unsure" }) || {}).problem, "energy_basis_unclear");
});

test("while the category is unknown, total fat does not decide the route", () => {
  const base = { ...structuredClone(cereal), values: { ...cereal.values, fat_g: null }, confidence: { ...cereal.confidence, fat: 0 } };
  // A reader that only guesses 'fats' cannot make the missing fat a reason to refuse: for four of five groups nothing is missing.
  assert.deepEqual(route({ ...base, category: "fats", confidence: { ...base.confidence, category: 0.4 } }, [], { attempt: 1 }), { action: "ask_category", reasons: ["category_unclear"] });
  assert.equal(route({ ...base, category: "unsure", confidence: { ...base.confidence, category: 0.2 } }, [], { attempt: 1 }).action, "ask_category");
  // A reader that is sure of 'fats' still needs the fat value, read clearly.
  assert.equal(route({ ...base, category: "fats" }, [], { attempt: 1 }).action, "second_pass");
  const blurred = { ...structuredClone(cereal), category: "fats", confidence: { ...cereal.confidence, fat: 0.3 } };
  assert.deepEqual(route(blurred, [], { attempt: 1 }), { action: "second_pass", reasons: ["low_confidence_fat"] });
});

test("a basis the reader only inferred is not a basis", () => {
  const inferred = { ...structuredClone(cereal), confidence: { ...cereal.confidence, basis: 0.45 } };
  assert.deepEqual(route(inferred, [], { attempt: 1 }), { action: "second_pass", reasons: ["basis_unclear"] });
  assert.equal(route(inferred, [], { attempt: 2 }).action, "retake");
  assert.equal(route({ ...inferred, category: "unsure" }, [], { attempt: 1 }).action, "second_pass");   // never hidden behind the category question
  assert.equal(route({ ...structuredClone(cereal), confidence: { ...cereal.confidence, basis: 0.6 } }, [], { attempt: 1 }).action, "grade");
});

test("a label that lacks a required value is incomplete even when the category is unknown", () => {
  const oil = { ...structuredClone(cereal), category: "unsure", nutrition_table_visible: true,
    values: { energy_kJ: null, energy_kcal: 124, fat_g: 14, satfat_g: 1.4, carb_g: 0, sugar_g: 0, fibre_g: null, protein_g: 0, salt_g: null, sodium_mg: null },
    confidence: { ...cereal.confidence, salt: 0, sodium: 0, category: 0.3 } };
  assert.equal(route(oil, [], { attempt: 1 }).action, "second_pass");
  const r = route(oil, [], { attempt: 2 });
  assert.equal(r.action, "incomplete_label"); assert.deepEqual(r.missing, ["salt"]);
});

test("a drink whose ingredients were not in the photo: the visitor is asked what could change the letter, and nothing else", () => {
  const drink = (values, over = {}) => ({ ...structuredClone(cereal), category: "beverages", basis: "per_100ml", ingredients_visible: false, sweeteners_present: false, fvl_pct_estimate: 0,
    values: { energy_kJ: null, energy_kcal: null, fat_g: 0, satfat_g: 0, carb_g: 0, sugar_g: 0, fibre_g: 0, protein_g: 0, salt_g: 0.02, sodium_mg: null, ...values }, ...over });
  const letter = r => computeGrade(rules, toEngineInput(r, r.values).input).grade;
  const ask = r => drinkOptions(r, r.values, x => letter({ ...x, values: r.values }));
  // A zero cola (1 kJ): B as it stands, C with sweeteners. It prints some energy, so it cannot be plain water.
  const zero = drink({ energy_kJ: 1, energy_kcal: 0.2 });
  assert.equal(drinkFactsUnknown(zero), true);
  assert.deepEqual(ask(zero), ["sweeteners", "none"]);
  assert.equal(letter({ ...zero, ...drinkAnswers(zero, zero.values).sweeteners }), "C");
  assert.equal(letter(zero), "B");
  // A table of zeros: plain water (A by definition), a zero drink with sweeteners (C), or another drink (B).
  const zeros = drink({ energy_kJ: 0, energy_kcal: 0 });
  assert.deepEqual(ask(zeros), ["water", "sweeteners", "none"]);
  assert.equal(letter({ ...zeros, ...drinkAnswers(zeros, zeros.values).water }), "A");
  assert.equal(drinkAnswers(zero, zero.values).water, undefined);                       // never offered, and never applied, to a drink with energy
  // Orange juice, table only (real label): E as it stands, C as 100% juice; sweeteners would leave it E, so they are not asked about.
  const juice = drink({ energy_kcal: 47, carb_g: 10.5, sugar_g: 10, fibre_g: 0.2, protein_g: 0.7, salt_g: 0 });
  assert.deepEqual(ask(juice), ["juice", "none"]);
  const asJuice = { ...juice, ...drinkAnswers(juice, juice.values).juice };
  assert.equal(letter(asJuice), "C"); assert.equal(computeGrade(rules, toEngineInput(asJuice, juice.values).input).score, 5);
  // Milk: C as it stands, D with sweeteners, B as juice: both are asked.
  const milk = drink({ energy_kcal: 62, fat_g: 3.2, satfat_g: 2.1, carb_g: 4.7, sugar_g: 4.7, protein_g: 3.2, salt_g: 0.1 });
  assert.deepEqual(ask(milk), ["juice", "sweeteners", "none"]);
  // A drink so sugary that nothing the visitor could say changes the letter: nothing is asked.
  const syrupy = drink({ energy_kJ: 400, carb_g: 22, sugar_g: 20 });
  assert.equal(ask(syrupy), null); assert.equal(letter(syrupy), "E");
  // Nothing is asked either when the facts are known: ingredients in the photo, a sweetener seen, the visitor's answer given,
  // plain water, not a drink, or a reading from before the field existed.
  for (const known of [{ ingredients_visible: true }, { sweeteners_present: true }, { drink_answered: true }, { plain_water: true }, { category: "general" }, { ingredients_visible: undefined }]) {
    assert.equal(drinkFactsUnknown({ ...zero, ...known }), false); assert.equal(ask({ ...zero, ...known }), null);
  }
  // A fruit share the reader took from the product name stands: the juice answer is not offered again.
  assert.equal(drinkAnswers({ ...juice, fvl_pct_estimate: 100 }, juice.values).juice, undefined);
  // route() itself asks nothing about drinks: the Worker does, after route says "grade".
  assert.equal(route(zero, [], { attempt: 1 }).action, "grade");
});

test("plain water with a panel of zeros is plain water", () => {
  // Bottle in the photo; the simplified panel prints calories 0, fat 0, sodium 0, carbohydrate 0, protein 0 and no sugars or saturates row.
  const water = { ...structuredClone(cereal), category: "beverages", basis: "per_serving", serving_size: 500, plain_water: true,
    values: { energy_kJ: null, energy_kcal: 0, fat_g: 0, satfat_g: null, carb_g: 0, sugar_g: null, fibre_g: null, protein_g: 0, salt_g: null, sodium_mg: 0 },
    confidence: { ...cereal.confidence, satfat: 0, sugar: 0, fibre: 0, salt: 0, sodium: 1 } };
  const { per100, checks } = prepareReading(water);
  assert.deepEqual(route(water, checks, { attempt: 1 }), { action: "grade", reasons: ["plain_water"] });
  assert.equal(computeGrade(rules, toEngineInput(water, per100).input).grade, "A");
  // A "water" that prints sugars or energy is not plain water: it is routed like any drink.
  const flavoured = { ...water, values: { ...water.values, energy_kcal: 20, sugar_g: 5, satfat_g: 0 }, confidence: cereal.confidence };
  assert.notDeepEqual(route(flavoured, prepareReading(flavoured).checks, { attempt: 1 }).reasons, ["plain_water"]);
});

test("fruit and vegetable content that could not be seen is counted as none, and the result says so", () => {
  const juice = { ...structuredClone(cereal), category: "beverages", basis: "per_100ml", ingredients_visible: false, drink_answered: true, fvl_pct_estimate: 0,
    values: { energy_kJ: null, energy_kcal: 47, fat_g: 0, satfat_g: 0, carb_g: 10.5, sugar_g: 10, fibre_g: 0.2, protein_g: 0.7, salt_g: 0, sodium_mg: null } };
  assert.ok(toEngineInput(juice, juice.values).flags.includes("ingredients_not_in_photo_fvl_counted_as_0"));
  assert.equal(toEngineInput({ ...juice, ingredients_visible: true }, juice.values).flags.includes("ingredients_not_in_photo_fvl_counted_as_0"), false);
  assert.equal(toEngineInput({ ...juice, fvl_pct_estimate: 100 }, juice.values).flags.includes("ingredients_not_in_photo_fvl_counted_as_0"), false);   // the pack front said 100% juice
  assert.equal(toEngineInput({ ...juice, plain_water: true }, juice.values).flags.includes("ingredients_not_in_photo_fvl_counted_as_0"), false);       // water has no fruit share to miss
  assert.equal(toEngineInput(cereal, cereal.values).flags.includes("ingredients_not_in_photo_fvl_counted_as_0"), false);                               // a reading without the field
});

// ---- Probes: one per number or rule that could be bent without any other test noticing ----

test("probes: the energy comparison", () => {
  // Fibre carries 8 kJ per gram and is counted beside carbohydrate on EU-style labels: wheat bran with 20 g carbohydrate and 45 g fibre.
  const euBran = { energy_kJ: 1140, fat_g: 5, carb_g: 20, protein_g: 15, fibre_g: 45 };
  assert.ok(energyGap(1140, euBran) < 0.001); assert.deepEqual(consistencyChecks(euBran), []);
  assert.equal(energyGap(400, { fat_g: 0, carb_g: 0, protein_g: 0, fibre_g: 50 }), 0);
  // A missing protein row is not a protein of zero: no judgement.
  assert.equal(energyGap(1400, { fat_g: 5, carb_g: 72, protein_g: null }), null);
  assert.deepEqual(consistencyChecks({ energy_kJ: 300, fat_g: 5, carb_g: 72, protein_g: null }).filter(c => c.code === "energy_vs_macros"), []);
  // The "too little energy" line is never under 150 kJ, also for a serving above 100.
  assert.equal(energyGap(100, { fat_g: 0, carb_g: 6, protein_g: 0 }, { scale: 0.4 }), null);
  // Polyols: the band runs from 0 kJ per gram (erythritol) to 10 kJ per gram, and polyols cannot exceed the carbohydrate they are part of.
  const sweets = { fat_g: 0, carb_g: 97, protein_g: 0, polyols_g: 97 };                 // 17 kJ/g would be 1649 kJ, 10 kJ/g is 970
  assert.equal(energyGap(970, sweets), 0); assert.equal(energyGap(300, sweets), 0);
  assert.ok(near(energyGap(1067, sweets), 0.1));                                        // 10% above the top of the band
  assert.equal(energyGap(970, { ...sweets, polyols_g: 150 }), 0);
});

test("probes: the reader's word on a per-serving energy", () => {
  const per100 = { fat_g: 10, carb_g: 50, protein_g: 10, fibre_g: 0 };                  // implies 1390 kJ
  const says = (energy_kJ, serving_size) => energyFromServing({ ...per100, energy_kJ }, { basis: "per_100g", serving_size, energy_basis: "per_serving" });
  // "Fits as printed" means within 15%: 1190 kJ (14.4% off) with a serving that explains nothing is left alone, 1180 kJ (15.1%) is not.
  assert.equal(says(1190, 30), null);
  assert.ok(near(says(1180, 30).per100.energy_kJ, 1180 * 100 / 30));
  // "Stops fitting once scaled" is the same 15%: from an 86 g serving 1390 becomes 1616 (16.3% off) and stays; from 88 g it becomes 1580 (13.6%) and is scaled.
  assert.equal(says(1390, 86), null);
  assert.ok(near(says(1390, 88).per100.energy_kJ, 1390 * 100 / 88));
});

test("probes: the rounding allowance", () => {
  const base = { energy_kcal: 302, fat_g: 22, satfat_g: 14, carb_g: 0, sugar_g: 1, fibre_g: 0, protein_g: 25, sodium_mg: 560 };
  const blocked = (v, scale) => consistencyChecks(v, scale === undefined ? undefined : { scale }).some(c => c.code === "sugar_over_carb" || c.code === "satfat_over_fat");
  // Per-serving label, 50 g serving: one printed gram over is rounding, two are not.
  assert.equal(blocked(toPer100({ ...base, carb_g: 0, sugar_g: 1 }, "per_serving", 50), 2), false);
  assert.equal(blocked(toPer100({ ...base, carb_g: 0, sugar_g: 2 }, "per_serving", 50), 2), true);
  // Saturates above fat follow the serving too: per 30 g, fat 0 g and saturates 1 g is rounding; 2 g is not; without the scale even 1 g is refused.
  const sat = g => toPer100({ energy_kcal: 30, fat_g: 0, satfat_g: g, carb_g: 5, sugar_g: 1, protein_g: 1, sodium_mg: 10 }, "per_serving", 30);
  assert.equal(blocked(sat(1), 100 / 30), false); assert.equal(blocked(sat(2), 100 / 30), true); assert.equal(blocked(sat(1)), true);
  // A serving above 100: the allowance is never under half a gram per 100. Per 250 ml, carbohydrate 12 g and sugars 13.3 g (0.52 g per 100 apart) pass.
  assert.equal(blocked(toPer100({ ...base, fat_g: 0, satfat_g: 0, carb_g: 12, sugar_g: 13.3, energy_kcal: 100, protein_g: 12.5 }, "per_serving", 250), 100 / 250), false);
  // A value the visitor typed back from the card (rounded) is not refused for its rounding: 3.6 for 3.571 at a 28 g serving.
  assert.equal(blocked({ ...base, carb_g: 0, sugar_g: 3.6 }, 100 / 28), false);
  // Per-100 label: the whole-gram allowance needs both figures whole, and a label with decimals gets half a gram, no more.
  assert.equal(blocked({ ...base, carb_g: 4.2, sugar_g: 5 }), true);                    // one whole, one not: 0.8 apart
  assert.equal(blocked({ ...base, carb_g: 4.7, sugar_g: 5.3 }), true);                  // 0.6 apart
  assert.equal(blocked({ ...base, carb_g: 4.7, sugar_g: 5.2 }), false);                 // 0.5 apart
  // A per-100 label that also prints a serving size is still a per-100 label: no per-serving allowance.
  const r = { ...structuredClone(cereal), serving_size: 30 };
  prepareReading(r); assert.equal(r.rounding_scale, 1);
});

test("probes: the basis confidence line is 0.6", () => {
  for (const [basis, action] of [[0.5, "second_pass"], [0.59, "second_pass"], [0.6, "grade"]])
    assert.equal(route({ ...structuredClone(cereal), confidence: { ...cereal.confidence, basis } }, [], { attempt: 1 }).action, action, `basis confidence ${basis}`);
});
