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

test("a non-food photo is routed as not_food", () => {
  assert.equal(route({ ...cereal, category: "other" }, []).action, "not_food");
});

test("beverage with sweetener and plain water take the beverage paths", () => {
  const cola = { ...cereal, category: "beverages", basis: "per_100ml", values: { energy_kJ: 180, energy_kcal: 43, fat_g: 0, satfat_g: 0, carb_g: 10.6, sugar_g: 10.6, fibre_g: 0, protein_g: 0, salt_g: 0.01, sodium_mg: null }, sweeteners_present: true };
  const g1 = computeGrade(rules, toEngineInput(cola, cola.values).input);
  assert.equal(g1.category, "beverages"); assert.equal(g1.points.sweeteners, 4); assert.equal(g1.grade, "E");
  const water = { ...cola, plain_water: true, sweeteners_present: false, values: { ...cola.values, energy_kJ: 0, sugar_g: 0 } };
  assert.equal(computeGrade(rules, toEngineInput(water, water.values).input).grade, "A");
});
