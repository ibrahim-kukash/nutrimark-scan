// Turns a reader output into an engine input and tests it for the misreads a camera produces.
// Pure functions, no I/O, unit-tested without any key.

const isNum = v => typeof v === "number" && Number.isFinite(v);
const r1 = x => Math.round(x * 10) / 10;
const zeroOrAbsent = x => !isNum(x) || x === 0;

/** Scale per-serving values to per 100 g/ml. Returns null when the serving size is unknown.
 *  The converted values are kept at full precision: rounding belongs to the page that shows them. A value rounded
 *  here can fall off a threshold it sits on (fat 14 g and saturates 1.4 g per 15 ml are exactly 10%; 93.3 and 9.3 are not). */
export function toPer100(values, basis, servingSize) {
  if (basis === "per_100g" || basis === "per_100ml") return { ...values };
  if (basis === "per_serving" && isNum(servingSize) && servingSize > 0) {
    const out = {};
    for (const [k, v] of Object.entries(values)) out[k] = isNum(v) ? v * 100 / servingSize : v;
    return out;
  }
  return null;
}

const kJof = v => isNum(v.energy_kJ) ? v.energy_kJ : (isNum(v.energy_kcal) ? v.energy_kcal * 4.184 : null);

/** The energy fat, carbohydrate, protein and fibre imply, counted the two ways labels count fibre: beside carbohydrate
 *  (EU-style) and inside it (US-style). Null when a macronutrient is missing. */
function impliedEnergy(v) {
  if (!(isNum(v.fat_g) && isNum(v.carb_g) && isNum(v.protein_g))) return null;
  const fibre = isNum(v.fibre_g) ? v.fibre_g : 0;
  return { fibre,
    beside: 37 * v.fat_g + 17 * v.carb_g + 17 * v.protein_g + 8 * fibre,
    inside: 37 * v.fat_g + 17 * Math.max(0, v.carb_g - fibre) + 17 * v.protein_g + 8 * fibre };
}

/** How far a printed energy sits from the energy the macronutrients imply, as a fraction (0.25 = 25% off).
 *  Both ways of counting fibre are tried and the closer one counts. Polyols (sugar alcohols) are part of carbohydrate
 *  but carry 10 kJ per gram, erythritol none, against 17 for other carbohydrate: when the label prints a polyols row,
 *  any energy between those two readings of it fits.
 *  Returns null when it cannot be judged: a macronutrient is missing, or the food carries too little energy for the
 *  comparison to mean anything (printed and implied energy both under 150 kJ). scale is 100 / serving size on a
 *  per-serving label: there the figures were rounded per serving, so that line is one serving's worth, not 100 g's. */
export function energyGap(kJ, v, { scale = 1 } = {}) {
  const e = isNum(kJ) ? impliedEnergy(v) : null;
  if (!e) return null;
  if (Math.max(e.beside, kJ) <= 150 * Math.max(1, isNum(scale) ? scale : 1)) return null;
  const gap = est => est > 0 ? Math.abs(kJ - est) / est : Infinity;
  let best = Math.min(gap(e.beside), gap(e.inside));
  const polyols = isNum(v.polyols_g) ? Math.min(v.polyols_g, v.carb_g) : 0;
  if (polyols > 0) {
    const lowest = Math.max(0, e.inside - 17 * polyols), highest = e.beside - 7 * polyols;
    if (kJ >= lowest && kJ <= highest) return 0;
    best = Math.min(best, gap(lowest), gap(highest));
  }
  return best;
}

/** Some labels print the energy for one serving above columns that are per 100 g ("Calories per serving 133").
 *  The reader then reports per-100 values with a per-serving energy, and the grade comes out too good.
 *  What settles it, in this order:
 *   - The reader saw the words on the label (reading.energy_basis = "per_serving"): the energy is scaled, unless it fits
 *     the other values as printed and stops fitting once scaled (then the remark is wrong and the energy stays).
 *   - The numbers alone (printed energy more than 40% from what the macronutrients imply, and within 15% once scaled
 *     from the serving): never on a single read, because one misread row can produce the same picture. The checks stop
 *     the read; if the second, stronger read shows the same picture, it has been seen twice and is believed.
 *   - The reader could not tell which amount the figure is for ("unsure") and the numbers do not settle it either:
 *     the read stops. A grade is not given on an energy nobody could place.
 *  Returns null (nothing to do), or an object with any of: per100 (energy scaled, nothing else touched),
 *  pattern (the numbers alone say "per serving"), problem (a code that stops the read). */
export function energyFromServing(per100, reading, { attempt = 1, patternBefore = false } = {}) {
  const { basis, serving_size: size } = reading;
  const said = reading.energy_basis === "per_serving" || reading.energy_basis === "same_as_table" ? reading.energy_basis : "unsure";
  if (!per100 || !(basis === "per_100g" || basis === "per_100ml")) return null;
  const kJ = kJof(per100);
  if (!isNum(kJ)) return null;
  const sizeKnown = isNum(size) && size > 0;
  const gap = energyGap(kJ, per100);
  const fitsAsPrinted = gap !== null && gap <= 0.15;
  if (!sizeKnown || size === 100) {
    // Nothing to scale by. "Per serving" without a serving size stops the read, unless the energy plainly fits as printed.
    if (said === "per_serving" && !sizeKnown && !fitsAsPrinted) return { problem: "energy_per_serving_without_serving_size" };
    return null;
  }
  const scaled = x => x * 100 / size;
  const scaledGap = energyGap(scaled(kJ), per100);
  const fitsScaled = scaledGap !== null && scaledGap <= 0.15;
  const converted = () => {
    const out = { ...per100 };
    if (isNum(out.energy_kJ)) out.energy_kJ = scaled(out.energy_kJ);
    if (isNum(out.energy_kcal)) out.energy_kcal = scaled(out.energy_kcal);
    return out;
  };
  if (said === "per_serving") return fitsAsPrinted && !fitsScaled ? null : { per100: converted() };
  const numbersSaySo = gap !== null && gap > 0.40 && fitsScaled;
  if (numbersSaySo) return attempt >= 2 && patternBefore ? { per100: converted(), pattern: true } : { pattern: true };
  // "Unsure" is left alone only when the numbers settle it: they can judge, and the energy would not fit if it were
  // scaled. When they cannot judge (a low-energy drink, a missing row) or the scaled energy fits as well, nobody knows.
  if (said === "unsure" && (gap === null || fitsScaled)) return { problem: "energy_basis_unclear" };
  return null;
}

/** The allowance for "sugars above carbohydrate" and "saturates above fat", in grams per 100.
 *  Labels round to whole grams, so "carbohydrate 0 g, sugars 1 g" is rounding, not a misread.
 *  Per-100 label: one gram when both figures are whole numbers; a label that prints decimals does not round to whole
 *  grams, and half a gram is all it gets. Per-serving label: that one printed gram is multiplied by the scale
 *  (100 / serving size), never under half a gram and never over five. */
function roundingAllowance(scale, a, b) {
  const s = isNum(scale) && scale > 0 ? scale : 1;
  if (s === 1) return Number.isInteger(a) && Number.isInteger(b) ? 1.05 : 0.5;
  return Math.min(5, Math.max(0.5, s)) + 0.05;   // + 0.05: a value typed back by the visitor is rounded
}

/** Consistency checks. Each returns {code, severity:'block'|'warn', message}.
 *  scale: 100 / serving size for a per-serving label, 1 otherwise. */
export function consistencyChecks(v, { scale: rawScale = 1 } = {}) {
  const scale = isNum(rawScale) && rawScale > 0 ? Math.min(rawScale, 20) : 1;   // 20 = a 5 g serving, the smallest a label prints
  const out = [];
  const add = (code, severity, message) => out.push({ code, severity, message });
  const range = (k, lo, hi) => { if (isNum(v[k]) && (v[k] < lo || v[k] > hi)) add(`range_${k}`, "block", `${k} = ${r1(v[k])} is outside ${lo}-${hi}`); };
  range("energy_kJ", 0, 4000); range("energy_kcal", 0, 950);
  for (const k of ["fat_g", "satfat_g", "carb_g", "sugar_g", "fibre_g", "protein_g"]) range(k, 0, 100);
  range("salt_g", 0, 100); range("sodium_mg", 0, 40000);
  if (isNum(v.energy_kJ) && isNum(v.energy_kcal) && v.energy_kcal > 0) {
    const ratio = v.energy_kJ / v.energy_kcal;
    // Tiny energies are printed rounded ("1 kJ / 0.2 kcal", "5 kJ / 1 kcal"), which throws the ratio off on a correct read.
    // A gap of a few kJ is rounding, not a misread; it can only arise below about 55 kJ, so no large error passes through it.
    const gap = Math.abs(v.energy_kJ - v.energy_kcal * 4.184);
    if ((ratio < 3.8 || ratio > 4.6) && gap > 5) add("kJ_kcal_mismatch", "block", `kJ/kcal ratio ${ratio.toFixed(2)} (expected about 4.2)`);
  }
  if (isNum(v.sugar_g) && isNum(v.carb_g) && v.sugar_g > v.carb_g + roundingAllowance(scale, v.sugar_g, v.carb_g)) add("sugar_over_carb", "block", `sugars ${r1(v.sugar_g)} g exceed carbohydrate ${r1(v.carb_g)} g`);
  if (isNum(v.satfat_g) && isNum(v.fat_g) && v.satfat_g > v.fat_g + roundingAllowance(scale, v.satfat_g, v.fat_g)) add("satfat_over_fat", "block", `saturates ${r1(v.satfat_g)} g exceed fat ${r1(v.fat_g)} g`);
  // An energy far from what fat, carbohydrate and protein imply means a number was read from the wrong row or the wrong
  // column. On 43 real UAE labels read by hand (Nov 2026) the largest honest gap was 8%, so 40% is a misread, never rounding.
  const kJ = kJof(v);
  const gap = energyGap(kJ, v, { scale });
  if (gap !== null && gap > 0.30) add("energy_vs_macros", gap > 0.40 ? "block" : "warn", `energy ${Math.round(kJ)} kJ is ${Math.round(gap * 100)}% away from the energy the macronutrients imply`);
  // Fat, carbohydrate, protein and fibre cannot add up to more than the food itself. On US-style labels fibre is part of
  // carbohydrate and must not be added twice; the label's own energy says which kind it is: fibre is left out of the sum
  // only when the energy fits the "fibre inside carbohydrate" reading (within 15%) and fits it better than the other.
  const sum3 = ["fat_g", "carb_g", "protein_g"].filter(k => isNum(v[k])).reduce((s, k) => s + v[k], 0);
  const e = isNum(kJ) ? impliedEnergy(v) : null;
  const fibre = isNum(v.fibre_g) ? v.fibre_g : 0;
  const fibreInside = !!e && fibre > 0 && fibre <= v.carb_g && e.inside > 0
    && Math.abs(kJ - e.inside) / e.inside <= 0.15 && Math.abs(kJ - e.inside) < Math.abs(kJ - e.beside);
  const macroSum = fibreInside ? sum3 : sum3 + fibre;
  if (macroSum > 105) add("macros_over_100", "block", `fat + carbohydrate + protein${fibreInside ? "" : " + fibre"} = ${r1(macroSum)} g per 100 g`);
  return out;
}

/** Put a reading on a per-100 basis and test it: the one entry point a scan uses, for the first read and the second.
 *  Two facts about the label are written onto the reading itself, so they survive the round trip through the page when
 *  the visitor corrects a value or answers a question:
 *    energy_converted_from_serving  the label printed calories per serving above per-100 columns, and the energy was scaled
 *    rounding_scale                 100 / serving size on a per-serving label (how far whole-gram rounding is magnified)
 *  energy_pattern in the result: the numbers alone say "this energy is per serving" (see energyFromServing); the Worker
 *  passes it to the second read as patternBefore. */
export function prepareReading(reading, { attempt = 1, patternBefore = false } = {}) {
  let per100 = toPer100(reading.values, reading.basis, reading.serving_size);
  if (!per100) return { per100: null, checks: [{ code: "basis_unclear", severity: "block", message: "could not put the values on a per-100 basis" }], energy_pattern: false };
  const fixed = energyFromServing(per100, reading, { attempt, patternBefore }) || {};
  if (fixed.per100) { per100 = fixed.per100; reading.energy_converted_from_serving = true; }
  reading.rounding_scale = reading.basis === "per_serving" ? 100 / reading.serving_size : 1;
  const checks = consistencyChecks(per100, { scale: reading.rounding_scale });
  if (fixed.problem) checks.push({ code: fixed.problem, severity: "block", message: "the label does not make clear, or the reader could not tell, which amount the energy figure is printed for" });
  return { per100, checks, energy_pattern: fixed.pattern === true };
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
  const v = reading.values || {};
  // A label prints salt or sodium, rarely both, and the reader marks the absent one 0. On a sodium-only label the salt
  // confidence is the sodium figure's. A reader may file that figure under either name, so the higher counts; both low is low.
  const conf = k => (k === "salt" && !isNum(v.salt_g) && isNum(v.sodium_mg)) ? Math.max(c.sodium ?? 0, c.salt ?? 0) : (c[k] ?? 0);
  const categoryProblem = reading.category === "unsure" || (c.category ?? 0) < minConfidence;
  // While the category itself is in doubt, only the values every category grades on are judged here. Total fat matters
  // to one group alone; it is asked for when the visitor names that group (the /correct step), not guessed from a guess.
  const req = requiredFor(categoryProblem ? "general" : reading.category);
  const need = ["energy", "salt", ...req.map(k => k.replace("_g", ""))];
  const low = need.filter(k => conf(k) < minConfidence);   // a confidence the reader did not give counts as low, never as high
  const missing = [];
  if (!isNum(v.energy_kJ) && !isNum(v.energy_kcal)) missing.push("energy");
  if (!isNum(v.salt_g) && !isNum(v.sodium_mg)) missing.push("salt");
  for (const k of req) if (!isNum(v[k])) missing.push(k);
  // A basis the reader only inferred (the column heading is cut off) is not a basis: per-serving numbers graded as per-100 are a wrong grade.
  const basisProblem = reading.basis === "unsure" || (reading.basis === "per_serving" && !(isNum(reading.serving_size) && reading.serving_size > 0)) || (c.basis ?? 0) < minConfidence;
  const reasons = [
    ...blocks.map(b => b.code), ...low.map(k => `low_confidence_${k}`), ...missing.map(k => `missing_${k}`),
    ...(basisProblem ? ["basis_unclear"] : []), ...(categoryProblem ? ["category_unclear"] : []),
  ];
  if (reading.category === "other") return { action: "not_food", reasons: ["not_a_food_label"] };
  // Plain water is grade A by definition and needs no nutrition table (official Q&A). The engine's own test decides:
  // the reader says plain water, and sugars and energy are zero or not printed. A panel of zeros changes nothing.
  if (reading.category === "beverages" && reading.plain_water === true && zeroOrAbsent(v.sugar_g) && zeroOrAbsent(v.energy_kJ) && zeroOrAbsent(v.energy_kcal)) {
    return { action: "grade", reasons: ["plain_water"] };
  }
  // The reader could not even name a category and found no nutrition value at all: a face, a shoe, a wall.
  const noValuesAtAll = ["energy_kJ","energy_kcal","fat_g","satfat_g","carb_g","sugar_g","fibre_g","protein_g","salt_g","sodium_mg"].every(k => !isNum(v[k]));
  if (reading.category === "unsure" && noValuesAtAll) return { action: "not_food", reasons: ["not_a_food_label", "no_values_found"] };
  // Nothing numeric at all: the table is not in the photo. A second read of the same photo cannot find one, so say so at once.
  if (noValuesAtAll) return { action: "retake", reasons: ["no_table_in_photo", ...reasons] };
  if (reasons.length === 0) return { action: "grade", reasons: [] };
  // Every number was read and nothing contradicts; only the kind of product is unknown, because a close-up of the table
  // does not show it. A second read of the same photo cannot see it either, and the visitor is holding the pack: ask.
  if (reasons.every(r => r === "category_unclear")) return { action: "ask_category", reasons };
  // "The label is incomplete" is a claim about a manufacturer's packaging, so it needs evidence that a real table was read:
  // the reader says a table is visible, or at least three values were read with high confidence. A front-of-pack calorie badge gives neither.
  const confident = k => conf(k) >= 0.9;
  const confidentValues = [["energy", isNum(v.energy_kJ) || isNum(v.energy_kcal)], ["fat", isNum(v.fat_g)], ["carb", isNum(v.carb_g)], ["protein", isNum(v.protein_g)], ["sugar", isNum(v.sugar_g)], ["satfat", isNum(v.satfat_g)], ["salt", isNum(v.salt_g) || isNum(v.sodium_mg)]]
    .filter(([k, present]) => present && confident(k)).length;
  // The reader's own flag is corroboration, never the whole claim: it needs at least two confident values beside it.
  const tableSeen = confidentValues >= 3 || (reading.nutrition_table_visible === true && confidentValues >= 2);
  const requiredMissing = missing.filter(k => k !== "energy");
  // A value every category needs is missing whatever the product turns out to be, so an unknown category does not hide it.
  const onlyMissing = reasons.every(r => r === "category_unclear" || r.startsWith("missing_") || low.some(k => r === `low_confidence_${k}` && !isNum(v[k === "salt" ? "salt_g" : k === "energy" ? "energy_kJ" : k + "_g"])));
  if (attempt >= 2 && tableSeen && requiredMissing.length && onlyMissing && blocks.length === 0 && !basisProblem) {
    return { action: "incomplete_label", reasons, missing: requiredMissing };
  }
  return { action: attempt === 1 ? "second_pass" : "retake", reasons };
}

/** True for a drink whose ingredients list was not in the photo and about which the visitor has not been asked yet.
 *  Three things that change a drink's grade are printed nowhere in the nutrition table: whether it is plain water
 *  (grade A by definition), how much of it is fruit or vegetable juice, and whether it contains sweeteners. */
export function drinkFactsUnknown(reading) {
  return reading.category === "beverages" && reading.plain_water !== true && reading.ingredients_visible === false
    && reading.sweeteners_present !== true && reading.drink_answered !== true;
}

/** The answers the visitor may give about such a drink, each with what it changes on the reading. "water" is offered only
 *  for a table of zeros, "juice" only when the reader found no fruit share itself. */
export function drinkAnswers(reading, per100) {
  const v = per100 || {};
  const answers = { none: {}, sweeteners: { sweeteners_present: true } };
  if (zeroOrAbsent(v.sugar_g) && zeroOrAbsent(v.energy_kJ) && zeroOrAbsent(v.energy_kcal)) answers.water = { plain_water: true };
  else if (!(isNum(reading.fvl_pct_estimate) && reading.fvl_pct_estimate > 0)) answers.juice = { fvl_pct_estimate: 100, fvl_basis: "the visitor's answer: 100% juice" };
  return answers;
}

/** Which question, if any, must be put to the visitor before this drink is graded: the answers that would change the
 *  letter, in the order the page shows them, followed by "none". Null when the drink's facts are known, or when no
 *  answer could change the letter (a sugared soft drink is E with or without sweeteners): then nothing is asked.
 *  letterOf(reading) -> the grade letter for that reading on these values. */
export function drinkOptions(reading, per100, letterOf) {
  if (!drinkFactsUnknown(reading)) return null;
  const answers = drinkAnswers(reading, per100);
  const base = letterOf({ ...reading });
  const changing = ["water", "juice", "sweeteners"].filter(k => answers[k] && letterOf({ ...reading, ...answers[k] }) !== base);
  return changing.length ? [...changing, "none"] : null;
}

/** Build the engine input from a per-100 reading. Missing fibre or protein count as 0, and say so. */
export function toEngineInput(reading, per100) {
  const flags = [];
  const v = per100;
  const fvl = isNum(reading.fvl_pct_estimate) ? reading.fvl_pct_estimate : 0;
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
    fvl_pct: fvl,
    sweeteners: !!reading.sweeteners_present,
    water: !!reading.plain_water,
  };
  if (!isNum(v.fibre_g)) flags.push("fibre_not_declared_counted_as_0");
  if (!isNum(v.protein_g)) flags.push("protein_not_declared_counted_as_0");
  if (reading.energy_converted_from_serving === true) flags.push("energy_printed_per_serving_converted");
  // The share of fruit, vegetables and legumes comes from the ingredients list. Not in the photo: counted as none, and said so.
  if (reading.ingredients_visible === false && !(fvl > 0) && reading.plain_water !== true) flags.push("ingredients_not_in_photo_fvl_counted_as_0");
  if (reading.category === "beverages" && reading.basis === "per_100g") flags.push("beverage_declared_per_100g_taken_as_per_100ml");
  if (reading.category === "red_meat" && reading.red_meat_20_plus === false) { input.category = "general"; flags.push("red_meat_below_20pct_graded_as_general"); }
  return { input, flags };
}
