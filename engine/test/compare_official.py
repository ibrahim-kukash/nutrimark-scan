"""
Compare the engine against QCC's official calculation tool, category by category.

Method (same as the independent audits): copy the official workbook, write test products into the
input columns of each category sheet, recalculate the workbook with LibreOffice Calc headless,
read the tool's score and grade back, and compare with the engine's output for the same products.

Every product is classed as one of:
  match              both produce a number and the score AND grade agree
  both-refuse        the tool says 'missing data' / an error, and the engine refuses (ok:false)
  documented-defect  the tool's answer is one of the defects listed in rules.json (listed, not counted)
  MISMATCH           anything else

Usage:  python compare_official.py  [products_per_category]
Writes: engine/test/REPORT.md  and  engine/test/products.json
"""
import json, random, shutil, subprocess, sys, warnings
from collections import Counter
from pathlib import Path
warnings.filterwarnings("ignore")
import openpyxl

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OFFICIAL = ROOT / "research" / "QCC_Nutri-Mark_calculation_tool_Apr2026.xlsx"
SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"
NODE = r"C:\Program Files\nodejs\node.exe"
K = int(sys.argv[1]) if len(sys.argv) > 1 else 80
random.seed(20260914)

# Input column maps. 'kcal' and 'sodium' columns feed the tool's own conversion formulas; kJ/salt
# columns overwrite those formulas with direct values. The kcal path is used only where the tool's
# conversion is not defective (general, fats, beverages); the sodium path is sound on every sheet.
LAYOUT = {
    "general":   {"sheet": "General foods",              "kcal": "G", "energy_kJ": "H", "sugar_g": "I", "satfat_g": "J", "sodium": "K", "salt_g": "L", "fvl_pct": "M", "fibre_g": "N", "protein_g": "O", "score": "Y", "grade": "Z"},
    "cheese":    {"sheet": "Cheese",                     "energy_kJ": "H", "sugar_g": "I", "satfat_g": "J", "sodium": "K", "salt_g": "L", "fvl_pct": "M", "fibre_g": "N", "protein_g": "O", "score": "Y", "grade": "Z"},
    "red_meat":  {"sheet": "Red meat",                   "energy_kJ": "H", "sugar_g": "I", "satfat_g": "J", "sodium": "K", "salt_g": "L", "fvl_pct": "M", "fibre_g": "N", "protein_g": "O", "score": "Y", "grade": "Z"},
    "fats":      {"sheet": "Fats, oils, nuts and seeds", "kcal": "G", "fat_g": "I", "satfat_g": "J", "sugar_g": "M", "sodium": "N", "salt_g": "O", "fvl_pct": "P", "fibre_g": "Q", "protein_g": "R", "score": "AB", "grade": "AC"},
    "beverages": {"sheet": "Beverages",                  "water": "G", "kcal": "H", "energy_kJ": "I", "sugar_g": "J", "satfat_g": "K", "sodium": "L", "salt_g": "M", "sweeteners": "N", "fvl_pct": "O", "fibre_g": "P", "protein_g": "Q", "score": "AA", "grade": "AB"},
}
GENERAL_LIKE = ("general", "cheese", "red_meat")

def rnd(a, b, dp=1): return round(random.uniform(a, b), dp)
def pdp(): return random.choice([1, 1, 2, 3])          # protein decimals: sometimes 2 or 3

def gen(cat, i):
    """Products spread across profiles so every grade appears; every 4th sits on exact thresholds."""
    edge = (i % 4 == 0)
    profile = ["low", "mid", "high", "veg"][i % 4] if not edge else "edge"
    if cat in GENERAL_LIKE:
        if profile == "edge":
            p = {"energy_kJ": random.choice([335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350, 3351]),
                 "sugar_g": random.choice([3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51, 52]),
                 "satfat_g": random.choice([1, 2, 5, 10, 11]), "salt_g": random.choice([0.2, 0.8, 1.2, 2.8, 3.0, 4.0, 4.1]),
                 "fibre_g": random.choice([3.0, 4.1, 5.2, 6.3, 7.4, 7.5]),
                 "protein_g": random.choice([2.4, 2.405, 2.41, 4.8, 4.801, 7.2, 9.6, 12, 14, 17, 17.1]),
                 "fvl_pct": random.choice([40, 60, 80, 81])}
        elif profile == "low":     # aims at A/B
            p = {"energy_kJ": round(random.uniform(100, 700)), "sugar_g": rnd(0, 5), "satfat_g": rnd(0, 1.5), "salt_g": rnd(0, 0.4),
                 "fibre_g": rnd(2, 9), "protein_g": rnd(2, 12, pdp()), "fvl_pct": random.choice([0, 45, 65, 90])}
        elif profile == "veg":     # high fruit/veg, tests the FVL credit and the protein switch
            p = {"energy_kJ": round(random.uniform(200, 1500)), "sugar_g": rnd(0, 20), "satfat_g": rnd(0, 4), "salt_g": rnd(0, 1.2),
                 "fibre_g": rnd(1, 8), "protein_g": rnd(1, 8, pdp()), "fvl_pct": random.choice([50, 70, 85, 100])}
        elif profile == "mid":
            p = {"energy_kJ": round(random.uniform(600, 1900)), "sugar_g": rnd(0, 25), "satfat_g": rnd(0, 8), "salt_g": rnd(0, 1.5),
                 "fibre_g": rnd(0, 6), "protein_g": rnd(0, 20, pdp()), "fvl_pct": random.choice([0, 0, 20, 45])}
        else:                      # high: D/E
            p = {"energy_kJ": round(random.uniform(1500, 2800)), "sugar_g": rnd(10, 60), "satfat_g": rnd(3, 20), "salt_g": rnd(0.5, 3),
                 "fibre_g": rnd(0, 4), "protein_g": rnd(0, 30, pdp()), "fvl_pct": random.choice([0, 0, 0, 30])}
    elif cat == "fats":
        if profile == "edge":
            p = {"fat_g": 100.0, "satfat_g": random.choice([10, 16, 22, 28, 34, 40, 46, 52, 58, 64]),
                 "sugar_g": random.choice([3.4, 6.8, 10]), "salt_g": random.choice([0.2, 0.8, 2.0]),
                 "fibre_g": random.choice([3.0, 4.1, 7.4]), "protein_g": random.choice([2.4, 2.405, 4.8, 4.801, 7.2, 7.201, 17]),
                 "fvl_pct": random.choice([40, 60, 80, 81])}
        elif profile == "low":     # olive/rapeseed-like oils: A/B
            fat = rnd(60, 100); p = {"fat_g": fat, "satfat_g": round(fat * random.uniform(0.05, 0.14), 1), "sugar_g": 0.0, "salt_g": 0.0,
                 "fibre_g": 0.0, "protein_g": rnd(0, 1, pdp()), "fvl_pct": random.choice([0, 85, 100])}
        elif profile == "veg":     # nut butters, seeds
            fat = rnd(30, 60); p = {"fat_g": fat, "satfat_g": round(fat * random.uniform(0.08, 0.25), 1), "sugar_g": rnd(0, 12), "salt_g": rnd(0, 1.5),
                 "fibre_g": rnd(3, 12), "protein_g": rnd(10, 28, pdp()), "fvl_pct": random.choice([0, 50, 90, 100])}
        elif profile == "mid":
            fat = rnd(20, 100); p = {"fat_g": fat, "satfat_g": round(fat * random.uniform(0.15, 0.45), 1), "sugar_g": rnd(0, 15), "salt_g": rnd(0, 2),
                 "fibre_g": rnd(0, 6), "protein_g": rnd(0, 15, pdp()), "fvl_pct": random.choice([0, 0, 30, 65])}
        else:                      # butter, ghee, coconut: D/E
            fat = rnd(60, 100); p = {"fat_g": fat, "satfat_g": round(fat * random.uniform(0.5, 0.92), 1), "sugar_g": rnd(0, 8), "salt_g": rnd(0, 2.5),
                 "fibre_g": 0.0, "protein_g": rnd(0, 3, pdp()), "fvl_pct": 0}
    else:  # beverages
        if profile == "edge":
            p = {"energy_kJ": random.choice([0, 30, 90, 150, 210, 240, 270, 300, 330, 360, 390, 391]),
                 "sugar_g": random.choice([0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11, 11.1]), "satfat_g": random.choice([0, 1, 2]),
                 "salt_g": random.choice([0.2, 0.4, 0.6, 3.0, 3.4]), "fibre_g": random.choice([3.0, 4.1, 5.2]),
                 "protein_g": random.choice([1.2, 1.5, 1.8, 2.1, 2.4, 2.405, 2.7, 3.0]), "fvl_pct": random.choice([40, 60, 80, 81]),
                 "sweeteners": random.random() < 0.5}
        elif profile == "low":     # unsweetened teas, light drinks: B
            p = {"energy_kJ": round(random.uniform(0, 40)), "sugar_g": rnd(0, 1), "satfat_g": 0.0, "salt_g": rnd(0, 0.1),
                 "fibre_g": 0.0, "protein_g": rnd(0, 0.5, pdp()), "fvl_pct": 0, "sweeteners": False}
        elif profile == "veg":     # juices and milk drinks
            p = {"energy_kJ": round(random.uniform(150, 320)), "sugar_g": rnd(6, 12), "satfat_g": rnd(0, 2.5), "salt_g": rnd(0, 0.3),
                 "fibre_g": rnd(0, 2), "protein_g": rnd(0.5, 4, pdp()), "fvl_pct": random.choice([50, 70, 90, 100]), "sweeteners": False}
        elif profile == "mid":
            p = {"energy_kJ": round(random.uniform(40, 250)), "sugar_g": rnd(1, 8), "satfat_g": rnd(0, 1), "salt_g": rnd(0, 0.5),
                 "fibre_g": rnd(0, 3), "protein_g": rnd(0, 3, pdp()), "fvl_pct": random.choice([0, 0, 25, 50]), "sweeteners": random.random() < 0.4}
        else:                      # sodas, energy drinks: D/E
            p = {"energy_kJ": round(random.uniform(150, 450)), "sugar_g": rnd(8, 14), "satfat_g": rnd(0, 1), "salt_g": rnd(0, 1.5),
                 "fibre_g": 0.0, "protein_g": rnd(0, 1, pdp()), "fvl_pct": 0, "sweeteners": random.random() < 0.5}
        p["water"] = False
        if p["salt_g"] == 3.2: p["salt_g"] = 3.1          # documented tool defect at exactly 3.2
    p["id"] = f"{cat}-{i:03d}"; p["category"] = cat
    return p

products = [gen(cat, i) for cat in LAYOUT for i in range(K)]

# Input-path variants: the same product given as kcal instead of kJ, or sodium instead of salt.
variants = []
for p in products[:]:
    if p["category"] in ("general", "beverages") and int(p["id"][-3:]) % 7 == 1 and "energy_kJ" in p:
        q = dict(p); q["id"] = p["id"] + "-kcal"; q["energy_kcal"] = round(p["energy_kJ"] / 4.2, 1); del q["energy_kJ"]; variants.append(q)
    if int(p["id"][-3:]) % 9 == 2 and "salt_g" in p:
        q = dict(p); q["id"] = p["id"] + "-sodium"; q["sodium_mg"] = round(p["salt_g"] / 2.5 * 1000, 1); del q["salt_g"]; variants.append(q)
products += variants

# Special rows: both sides should refuse, or the tool's answer is a documented defect.
special = [
    {"id": "ref-sample", "category": "general", "energy_kJ": 1407, "sugar_g": 15, "satfat_g": 3.5, "salt_g": 0.5, "fibre_g": 4.5, "protein_g": 7.0, "fvl_pct": 0},
    {"id": "ref-moiat-example", "category": "general", "energy_kJ": 1850, "sugar_g": 18.0, "satfat_g": 6.0, "salt_g": 0.80, "fibre_g": 5.2, "protein_g": 7.0, "fvl_pct": 0},
    {"id": "missing-sugar", "category": "general", "energy_kJ": 900, "satfat_g": 2, "salt_g": 0.5, "fibre_g": 2, "protein_g": 5, "fvl_pct": 0, "expect": "both-refuse"},
    {"id": "missing-fibre-cheese", "category": "cheese", "energy_kJ": 1500, "sugar_g": 1, "satfat_g": 15, "salt_g": 1.5, "protein_g": 22, "fvl_pct": 0, "expect": "both-refuse"},
    {"id": "missing-protein-fats", "category": "fats", "fat_g": 80, "satfat_g": 20, "sugar_g": 0, "salt_g": 0, "fibre_g": 0, "fvl_pct": 0, "expect": "both-refuse"},
    {"id": "fat-zero", "category": "fats", "fat_g": 0, "satfat_g": 0, "sugar_g": 5, "salt_g": 0.1, "fibre_g": 1, "protein_g": 1, "fvl_pct": 0, "expect": "both-refuse"},
    {"id": "water-plain", "category": "beverages", "water": True, "sweeteners": False, "expect": "documented-defect", "engine_expect": ("A", None), "note": "tool returns ERROR for plain water (unreachable A route); engine A per Q&A"},
    {"id": "water-flavoured", "category": "beverages", "water": True, "energy_kJ": 180, "sugar_g": 11, "satfat_g": 0, "salt_g": 0.1, "fibre_g": 0, "protein_g": 0, "fvl_pct": 0, "sweeteners": False, "expect": "documented-defect", "engine_expect": ("E", 12), "note": "tool returns ERROR when water=YES with nutrients; engine ignores the flag and grades: energy 3 + sugar 9 = 12"},
    {"id": "bev-salt-3.2", "category": "beverages", "water": False, "energy_kJ": 100, "sugar_g": 3, "satfat_g": 0, "salt_g": 3.2, "fibre_g": 0, "protein_g": 0, "fvl_pct": 0, "sweeteners": False, "expect": "documented-defect", "engine_expect": ("E", 19), "note": "tool '<3.2' step gives 16 salt points (score 20); engine 15 (energy 2 + sugar 2 + salt 15 = 19)"},
]
products += special
(HERE / "products.json").write_text(json.dumps(products, indent=1), encoding="utf-8")

# ---- official workbook: write inputs, recalc with LibreOffice ----
work = HERE / "_official_work"; work.mkdir(exist_ok=True)
src = work / "in.xlsx"; shutil.copy(OFFICIAL, src)
wb = openpyxl.load_workbook(src)
rows = {}
for cat, L in LAYOUT.items():
    ws = wb[L["sheet"]]; r = 2
    for p in [q for q in products if q["category"] == cat]:
        for field, col in L.items():
            if field in ("sheet", "score", "grade"): continue
            key = {"kcal": "energy_kcal", "sodium": "sodium_mg"}.get(field, field)
            if key not in p: continue
            v = p[key]
            if field in ("water", "sweeteners"): v = "YES" if v else "NO"
            ws[f"{col}{r}"] = v
        if cat == "beverages" and "sweeteners" not in p: ws[f"{L['sweeteners']}{r}"] = "NO"
        rows[p["id"]] = (L["sheet"], r, L["score"], L["grade"]); r += 1
wb.save(src)
out = work / "out"; out.mkdir(exist_ok=True)
res = subprocess.run([SOFFICE, "--headless", "--calc", "--convert-to", "xlsx", "--outdir", str(out), str(src)], capture_output=True, text=True, timeout=900)
recalc = out / "in.xlsx"
if not recalc.exists(): print("LibreOffice conversion failed:", res.stdout, res.stderr); sys.exit(1)
wbv = openpyxl.load_workbook(recalc, data_only=True)
official = {}
for pid, (sheet, r, sc, gc) in rows.items():
    ws = wbv[sheet]; g = ws[f"{gc}{r}"].value; s = ws[f"{sc}{r}"].value
    g = str(g).replace("Nutrimark_", "") if g is not None else ""
    official[pid] = {"score": s if isinstance(s, (int, float)) else None, "grade": g,
                     "refused": g in ("missing data", "ERROR", "") or g.startswith("#") or not isinstance(s, (int, float))}

# ---- engine ----
eng = subprocess.run([NODE, str(HERE / "run_engine.mjs")], input=json.dumps(products), capture_output=True, text=True)
if eng.returncode != 0: print("engine failed:", eng.stderr); sys.exit(1)
engine = {r["id"]: r for r in json.loads(eng.stdout)}

# ---- classify ----
classes, lines_mm, lines_doc, lines_ref = Counter(), [], [], []
coverage = {c: Counter() for c in LAYOUT}
for p in products:
    o, e = official[p["id"]], engine[p["id"]]
    if o["grade"] in "ABCDE" and o["grade"]: coverage[p["category"]][o["grade"]] += 1
    exp = p.get("expect")
    if exp == "documented-defect":
        want = tuple(p.get("engine_expect", (None, None)))
        got = (e["grade"], e["score"])
        if want != got:
            classes["MISMATCH"] += 1; lines_mm.append(f"- MISMATCH {p['id']} (engine expectation): expected {want}, engine gave {got}"); continue
        classes["documented-defect"] += 1; lines_doc.append(f"- {p['id']}: tool {o['grade']} {o['score']} | engine {e['grade']} {e['score']} (as expected) | {p.get('note','')}"); continue
    if o["refused"] and not e["ok"]:
        classes["both-refuse"] += 1; lines_ref.append(f"- {p['id']}: tool '{o['grade']}' | engine '{e['grade']}'"); continue
    if (not o["refused"]) and e["ok"] and o["grade"] == e["grade"] and o["score"] == e["score"]:
        classes["match"] += 1; continue
    classes["MISMATCH"] += 1
    lines_mm.append(f"- MISMATCH {p['id']}: tool {o['grade']} {o['score']} | engine {e['grade']} {e['score']} | {json.dumps({k:v for k,v in p.items() if k not in ('id','category','expect','note')})}")

lines = ["# Engine vs official QCC calculator", "",
         f"Products: {len(products)} ({K} per category across low/mid/high/veg/edge profiles, plus kcal and sodium input variants, plus {len(special)} special rows). "
         "Official values: the QCC April 2026 workbook recalculated by LibreOffice Calc headless. Engine: engine/nutrimark.js with engine/rules.json.", "",
         "| class | count |", "|---|---|"] + [f"| {k} | {v} |" for k, v in classes.items()] + ["",
         "## Grade coverage (official grades, per category)", "", "| category | A | B | C | D | E | under 5 |", "|---|---|---|---|---|---|---|"]
for c, cnt in coverage.items():
    under = [g for g in "ABCDE" if cnt[g] < 5]
    lines.append(f"| {c} | {cnt['A']} | {cnt['B']} | {cnt['C']} | {cnt['D']} | {cnt['E']} | {', '.join(under) or 'none'} |")
lines += ["", "## Mismatches", ""] + (lines_mm or ["none"]) + ["", "## Documented tool defects (listed, not counted)", ""] + lines_doc + ["", "## Both refused", ""] + lines_ref
lines += ["", f"**Total mismatches: {classes['MISMATCH']} of {len(products)}.**",
          f"- ref-sample: tool {official['ref-sample']['grade']} {official['ref-sample']['score']} | engine {engine['ref-sample']['grade']} {engine['ref-sample']['score']}",
          f"- ref-moiat-example: tool {official['ref-moiat-example']['grade']} {official['ref-moiat-example']['score']} | engine {engine['ref-moiat-example']['grade']} {engine['ref-moiat-example']['score']}"]
(HERE / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines[:6+len(classes)] + lines[6+len(classes):6+len(classes)+10]))
print("...")
print("\n".join(lines[-3:]))
print("report:", HERE / "REPORT.md")
