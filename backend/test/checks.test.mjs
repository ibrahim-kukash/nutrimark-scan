// Unit tests for the checks and the reader-to-engine bridge. No network, no keys.
//   node --test backend/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toPer100, consistencyChecks, route, toEngineInput } from "../src/checks.js";
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

test("per-serving values scale to per 100 g", () => {
  const per100 = toPer100({ energy_kJ: 422, fat_g: 1.5, satfat_g: 1.05, carb_g: 21.6, sugar_g: 4.5, fibre_g: 1.35, protein_g: 2.1, salt_g: 0.15, sodium_mg: null, energy_kcal: null }, "per_serving", 30);
  assert.equal(per100.energy_kJ, 1406.7); assert.equal(per100.sugar_g, 15); assert.equal(per100.salt_g, 0.5);
});

test("per-serving without a serving size cannot be graded", () => {
  assert.equal(toPer100(cereal.values, "per_serving", null), null);
});

test("kJ/kcal mismatch and sugar above carbohydrate are blocking", () => {
  const checks = consistencyChecks({ ...cereal.values, energy_kJ: 1407, energy_kcal: 200, sugar_g: 80, carb_g: 72 });
  const codes = checks.filter(c => c.severity === "block").map(c => c.code);
  assert.ok(codes.includes("kJ_kcal_mismatch")); assert.ok(codes.includes("sugar_over_carb"));
});

test("low confidence on a required field goes to a second pass, then to retake", () => {
  const shaky = { ...cereal, confidence: { ...cereal.confidence, sugar: 0.3 } };
  assert.equal(route(shaky, [], { attempt: 1 }).action, "second_pass");
  assert.equal(route(shaky, [], { attempt: 2 }).action, "retake");
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

test("beverage with sweetener and plain water take the beverage paths", () => {
  const cola = { ...cereal, category: "beverages", basis: "per_100ml", values: { energy_kJ: 180, energy_kcal: 43, fat_g: 0, satfat_g: 0, carb_g: 10.6, sugar_g: 10.6, fibre_g: 0, protein_g: 0, salt_g: 0.01, sodium_mg: null }, sweeteners_present: true };
  const g1 = computeGrade(rules, toEngineInput(cola, cola.values).input);
  assert.equal(g1.category, "beverages"); assert.equal(g1.points.sweeteners, 4); assert.equal(g1.grade, "E");
  const water = { ...cola, plain_water: true, sweeteners_present: false, values: { ...cola.values, energy_kJ: 0, sugar_g: 0 } };
  assert.equal(computeGrade(rules, toEngineInput(water, water.values).input).grade, "A");
});
