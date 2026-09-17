// Nutri-Mark grade engine. Pure, dependency-free ES module.
// Works in a Cloudflare Worker, in the browser, and under node.
// Every number comes from rules.json; nothing nutritional is hard-coded here.

const REQUIRED = {
  general:   ["energy_kJ", "satfat_g", "sugar_g", "salt_g", "fibre_g", "protein_g", "fvl_pct"],
  cheese:    ["energy_kJ", "satfat_g", "sugar_g", "salt_g", "fibre_g", "protein_g", "fvl_pct"],
  red_meat:  ["energy_kJ", "satfat_g", "sugar_g", "salt_g", "fibre_g", "protein_g", "fvl_pct"],
  fats:      ["fat_g", "satfat_g", "sugar_g", "salt_g", "fibre_g", "protein_g", "fvl_pct"],
  beverages: ["energy_kJ", "satfat_g", "sugar_g", "salt_g", "fibre_g", "protein_g", "fvl_pct", "sweeteners"],
};

const isNum = v => typeof v === "number" && Number.isFinite(v);
const round0 = x => Math.round(x + Number.EPSILON);
const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;

/** Fill derived fields the way the official tool does (kcal -> kJ, sodium -> salt). No silent defaults:
 *  fvl_pct and sweeteners must be supplied by the caller, who decides them explicitly. */
export function normalise(input) {
  const p = { ...input };
  if (!isNum(p.energy_kJ) && isNum(p.energy_kcal)) p.energy_kJ = round0(p.energy_kcal * 4.2);
  if (!isNum(p.salt_g) && isNum(p.sodium_mg)) p.salt_g = p.sodium_mg / 1000 * 2.5;
  return p;
}

/** Plain water: flagged as water AND no sugar, no energy and no sweeteners declared (the three
 *  things that make a flavoured water, per the Q&A). Other fields are not consulted. */
function isPlainWater(p) {
  const zeroOrAbsent = v => !isNum(v) || v === 0;
  return p.water === true && zeroOrAbsent(p.sugar_g) && zeroOrAbsent(p.energy_kJ) && p.sweeteners !== true;
}

// Spreadsheets compare with ~15 significant digits, so 1120 mg sodium -> 2.8000000000000003 g salt still
// counts as 2.8. A 1e-12 tolerance absorbs such artefacts (largest seen ~1e-14) without touching any real value.
const EPS = 1e-12;
function stepPoints(spec, value) {
  if (spec.flag_points !== undefined) return value ? spec.flag_points : 0;
  const cmp = spec.op === "ge" ? (v, t) => v >= t - EPS : (v, t) => v > t + EPS;
  let count = 0;
  for (const t of spec.steps) if (cmp(value, t)) count++;
  return spec.map ? spec.map[count] : count;
}

function specFor(rules, cat, field) {
  return (cat.overrides && cat.overrides[field]) || rules.shared[field];
}

function gradeFor(cat, score) {
  for (const g of cat.grades) if (g.max === undefined || score <= g.max) return g.grade;
  return "E";
}

/**
 * computeGrade(rules, input)
 * input: { category: 'general'|'cheese'|'red_meat'|'fats'|'beverages',
 *          energy_kJ | energy_kcal, fat_g, satfat_g, sugar_g, salt_g | sodium_mg,
 *          fibre_g, protein_g, fvl_pct, sweeteners?, water? }
 * returns { ok, category, grade, colour, score, N, P, points:{...}, missing:[...], notes:[...] }
 */
export function computeGrade(rules, input) {
  const cat = rules.categories[input.category];
  if (!cat) return { ok: false, error: `unknown category '${input.category}'` };
  const p = normalise(input);
  const notes = [];

  // Beverages: plain water (mineral, spring, table) is A by definition (Q&A), no declaration needed.
  // A water flag on a drink with sugar, energy or sweeteners declared is not plain water: grade it.
  if (input.category === "beverages" && p.water === true) {
    if (isPlainWater(p)) {
      return { ok: true, category: "beverages", grade: "A", colour: rules.colours.A, score: null, N: 0, P: 0,
               points: {}, missing: [], notes: ["plain water: default grade A"] };
    }
    notes.push("water flag ignored: sugar, energy or sweeteners declared");
  }

  const missing = REQUIRED[input.category].filter(f => f === "sweeteners" ? typeof p[f] !== "boolean" : !isNum(p[f]));
  if (missing.length) return { ok: false, category: input.category, missing, error: "missing data" };

  // Derived fields for fats
  const values = { ...p };
  if (input.category === "fats") {
    values.energy_from_satfat_kJ = p.satfat_g * 37;
    if (p.fat_g <= 0) return { ok: false, category: "fats", missing: ["fat_g"], error: "total fat must be above zero" };
    // multiply before dividing and trim float noise, so 58/100 reads as exactly 58%, as the spreadsheet does
    values.satfat_ratio_pct = Math.round((p.satfat_g * 100 / p.fat_g) * 1e9) / 1e9;
  }
  if (cat.protein_round === 2) values.protein_g = round2(p.protein_g);   // general foods only, as the official sheet

  const points = {};
  let N = 0, P = 0;
  for (const f of cat.negative) { points[f] = stepPoints(specFor(rules, cat, f), values[f]); N += points[f]; }
  for (const f of cat.positive) { points[f] = stepPoints(specFor(rules, cat, f), values[f]); P += points[f]; }

  let score;
  const rule = cat.score_rule;
  if (rule.type === "full_P_always") {
    score = N - P;
  } else if (rule.type === "protein_excluded_when_N_at_least") {
    if (N >= rule.N) { score = N - points.fibre_g - points.fvl_pct; notes.push(`protein excluded: N ${N} >= ${rule.N}`); }
    else score = N - P;
  } else {
    return { ok: false, error: `unknown score rule ${rule.type}` };
  }

  const grade = gradeFor(cat, score);
  return { ok: true, category: input.category, grade, colour: rules.colours[grade], score, N, P, points, missing: [], notes };
}

/** Which nutrients cost the most points, for the "three reasons" line. */
export function reasons(result, max = 3) {
  if (!result.ok) return [];
  const neg = Object.entries(result.points)
    .filter(([k]) => !["fibre_g", "protein_g", "fvl_pct"].includes(k))
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v >= 2)
    .slice(0, max);
  return neg.map(([k]) => k);
}
