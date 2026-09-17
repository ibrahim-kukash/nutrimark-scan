// Turns a reader output into an engine input and tests it for the misreads a camera produces.
// Pure functions, no I/O, unit-tested without any key.

const isNum = v => typeof v === "number" && Number.isFinite(v);
const r1 = x => Math.round(x * 10) / 10;

/** Scale per-serving values to per 100 g/ml. Returns null when the serving size is unknown. */
export function toPer100(values, basis, servingSize) {
  if (basis === "per_100g" || basis === "per_100ml") return { ...values };
  if (basis === "per_serving" && isNum(servingSize) && servingSize > 0) {
    const f = 100 / servingSize, out = {};
    for (const [k, v] of Object.entries(values)) out[k] = isNum(v) ? (k === "sodium_mg" ? Math.round(v * f) : r1(v * f)) : v;
    return out;
  }
  return null;
}

/** Consistency checks. Each returns {code, severity:'block'|'warn', message}. */
export function consistencyChecks(v) {
  const out = [];
  const add = (code, severity, message) => out.push({ code, severity, message });
  const range = (k, lo, hi) => { if (isNum(v[k]) && (v[k] < lo || v[k] > hi)) add(`range_${k}`, "block", `${k} = ${v[k]} is outside ${lo}-${hi}`); };
  range("energy_kJ", 0, 4000); range("energy_kcal", 0, 950);
  for (const k of ["fat_g", "satfat_g", "carb_g", "sugar_g", "fibre_g", "protein_g"]) range(k, 0, 100);
  range("salt_g", 0, 100); range("sodium_mg", 0, 40000);
  if (isNum(v.energy_kJ) && isNum(v.energy_kcal) && v.energy_kcal > 0) {
    const ratio = v.energy_kJ / v.energy_kcal;
    if (ratio < 3.8 || ratio > 4.6) add("kJ_kcal_mismatch", "block", `kJ/kcal ratio ${ratio.toFixed(2)} (expected about 4.2)`);
  }
  if (isNum(v.sugar_g) && isNum(v.carb_g) && v.sugar_g > v.carb_g + 0.5) add("sugar_over_carb", "block", `sugars ${v.sugar_g} g exceed carbohydrate ${v.carb_g} g`);
  if (isNum(v.satfat_g) && isNum(v.fat_g) && v.satfat_g > v.fat_g + 0.5) add("satfat_over_fat", "block", `saturates ${v.satfat_g} g exceed fat ${v.fat_g} g`);
  const kJ = isNum(v.energy_kJ) ? v.energy_kJ : (isNum(v.energy_kcal) ? v.energy_kcal * 4.184 : null);
  if (isNum(kJ) && isNum(v.fat_g) && isNum(v.carb_g) && isNum(v.protein_g)) {
    const est = 37 * v.fat_g + 17 * v.carb_g + 17 * v.protein_g + (isNum(v.fibre_g) ? 8 * v.fibre_g : 0);
    if (est > 150 && Math.abs(kJ - est) / est > 0.30) add("energy_vs_macros", "warn", `energy ${Math.round(kJ)} kJ vs ${Math.round(est)} kJ from the macronutrients`);
  }
  const macroSum = ["fat_g", "carb_g", "protein_g", "fibre_g"].filter(k => isNum(v[k])).reduce((s, k) => s + v[k], 0);
  if (macroSum > 105) add("macros_over_100", "block", `fat + carbohydrate + protein + fibre = ${r1(macroSum)} g per 100 g`);
  return out;
}

/** Fields the grade needs, per category. */
export function requiredFor(category) {
  const base = ["satfat_g", "sugar_g"];
  return category === "fats" ? [...base, "fat_g"] : base;
}

/** Decide what happens next from a reading and its checks. */
export function route(reading, checks, { minConfidence = 0.6, attempt = 1 } = {}) {
  const blocks = checks.filter(c => c.severity === "block");
  const c = reading.confidence || {};
  const req = requiredFor(reading.category);
  const need = ["energy", "salt", ...req.map(k => k.replace("_g", "").replace("satfat", "satfat"))];
  const low = Object.entries(c).filter(([k, val]) => need.includes(k) && val < minConfidence).map(([k]) => k);
  const v = reading.values || {};
  const missing = [];
  if (!isNum(v.energy_kJ) && !isNum(v.energy_kcal)) missing.push("energy");
  if (!isNum(v.salt_g) && !isNum(v.sodium_mg)) missing.push("salt");
  for (const k of req) if (!isNum(v[k])) missing.push(k);
  const basisProblem = reading.basis === "unsure" || (reading.basis === "per_serving" && !isNum(reading.serving_size));
  const categoryProblem = reading.category === "unsure" || (c.category ?? 0) < minConfidence;
  const reasons = [
    ...blocks.map(b => b.code), ...low.map(k => `low_confidence_${k}`), ...missing.map(k => `missing_${k}`),
    ...(basisProblem ? ["basis_unclear"] : []), ...(categoryProblem ? ["category_unclear"] : []),
  ];
  if (reading.category === "other") return { action: "not_food", reasons: ["not_a_food_label"] };
  // Plain water carries no nutrition table and is grade A by definition (QCC Q&A). Grade it without values.
  if (reading.category === "beverages" && reading.plain_water === true && !isNum(v.sugar_g) && !isNum(v.energy_kJ) && !isNum(v.energy_kcal)) {
    return { action: "grade", reasons: ["plain_water"] };
  }
  // The reader could not even name a category and found no nutrition value at all: a face, a shoe, a wall.
  const noValuesAtAll = ["energy_kJ","energy_kcal","fat_g","satfat_g","carb_g","sugar_g","fibre_g","protein_g","salt_g","sodium_mg"].every(k => !isNum(v[k]));
  if (reading.category === "unsure" && noValuesAtAll) return { action: "not_food", reasons: ["not_a_food_label", "no_values_found"] };
  if (reasons.length === 0) return { action: "grade", reasons: [] };
  // The table was read with confidence, but the label itself does not print what the grade needs: a fact about the label, not the photo.
  const readSomething = ["energy_kJ", "energy_kcal", "fat_g", "carb_g", "protein_g"].some(k => isNum(v[k]));
  const requiredMissing = missing.filter(k => k !== "energy");
  const onlyMissing = reasons.every(r => r.startsWith("missing_") || low.some(k => r === `low_confidence_${k}` && !isNum(v[k === "salt" ? "salt_g" : k === "energy" ? "energy_kJ" : k + "_g"])));
  if (attempt >= 2 && readSomething && requiredMissing.length && onlyMissing && blocks.length === 0 && !basisProblem) {
    return { action: "incomplete_label", reasons, missing: requiredMissing };
  }
  return { action: attempt === 1 ? "second_pass" : "retake", reasons };
}

/** Build the engine input from a per-100 reading. Missing fibre or protein count as 0, and say so. */
export function toEngineInput(reading, per100) {
  const flags = [];
  const v = per100;
  const input = {
    category: reading.category,
    energy_kJ: isNum(v.energy_kJ) ? v.energy_kJ : undefined,
    energy_kcal: isNum(v.energy_kcal) ? v.energy_kcal : undefined,
    fat_g: isNum(v.fat_g) ? v.fat_g : undefined,
    satfat_g: isNum(v.satfat_g) ? v.satfat_g : undefined,
    sugar_g: isNum(v.sugar_g) ? v.sugar_g : undefined,
    salt_g: isNum(v.salt_g) ? v.salt_g : undefined,
    sodium_mg: isNum(v.sodium_mg) ? v.sodium_mg : undefined,
    fibre_g: isNum(v.fibre_g) ? v.fibre_g : 0,
    protein_g: isNum(v.protein_g) ? v.protein_g : 0,
    fvl_pct: isNum(reading.fvl_pct_estimate) ? reading.fvl_pct_estimate : 0,
    sweeteners: !!reading.sweeteners_present,
    water: !!reading.plain_water,
  };
  if (!isNum(v.fibre_g)) flags.push("fibre_not_declared_counted_as_0");
  if (!isNum(v.protein_g)) flags.push("protein_not_declared_counted_as_0");
  if (reading.category === "beverages" && reading.basis === "per_100g") flags.push("beverage_declared_per_100g_taken_as_per_100ml");
  if (reading.category === "red_meat" && reading.red_meat_20_plus === false) { input.category = "general"; flags.push("red_meat_below_20pct_graded_as_general"); }
  return { input, flags };
}
