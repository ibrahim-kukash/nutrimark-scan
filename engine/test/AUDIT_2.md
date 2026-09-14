# AUDIT_2 — adversarial audit of the Nutri-Mark engine (cheese, red meat, fats, beverages) and its test harness

Auditor: independent, adversarial. No project file was modified except this report.
Authority: `research/QCC_Nutri-Mark_calculation_tool_Apr2026.xlsx`, read with openpyxl `data_only=False`.
Out of scope by instruction: the general-foods tables and rule (already covered by `research/CALC_REVIEW.md`).

Method: Section 1 was derived from the workbook formulas and written to disk **before** `engine/rules.json`
or `engine/nutrimark.js` was opened. 684 adversarial products were then written into a private copy of the
official workbook, recalculated with LibreOffice headless, and compared against `run_engine.mjs`; a second
run added 45 targeted probes. Every claim below is backed by a formula quote or a measured run.

---

## 1. Official algorithm for the four categories, from the formulas

### 1.0 The hidden `Scenario` sheet

Each table occupies three columns. Row 3 is `(0 pts, "≤", t0)`, row 4 is `(1 pt, ">", t0)`, row 5 is
`(2 pts, ">", t1)`, and so on. **Row 4 is redundant and every category formula skips it** — the chains read
`$X$3` then `$X$5, $X$6, $X$7 …`. The effective ladder is therefore a list of inclusive upper bounds.

| Table | Cells | Thresholds | Max |
|---|---|---|---|
| Fibre scenario II | C3, C5–C8 | 3, 4.1, 5.2, 6.3, 7.4 | 5 |
| Protein scenario II | G3, G5–G10 | 2.4, 4.8, 7.2, 9.6, 12, 14, 17 | 7 |
| Protein scenario V | K3, K5–K11 | 3, 6, 9, 12, 15, 18, 21, 24 | 8 (**unused** by these four) |
| Salt scenario I | O3, O5–O23 | 0.2 … 4.0 in 0.2 steps | 20 |
| Sugar scenario I | S3, S5–S13 | 3.4 … 34 | 10 (**unused**) |
| Sugar scenario Ia | W3, W5–W13 | 3.4 … 40 | 10 (**unused**) |
| Sugar scenario Ib | AA3, AA5–AA18 | 3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51 | 15 |
| Energy from SFA | AI3, AI5–AI13 | 120 … 1200 in 120 steps | 10 |

`Scenario!G11` carries the note `'Max. 2 pts for red meat'`.

### 1.1 Cheese

Columns: G kcal, H kJ, I sugar, J saturates, K sodium mg, L salt, M FVL %, N fibre, O protein.

```
H7  =IF(G7="","",ROUND(G6*4.2,0))          <-- reads G6, the PREVIOUS row
L7  =IF(K7="", "", K7/1000*2.5)
P7  energy, on H : <=335,670,1005,1340,1675,2010,2345,2680,3015,3350 -> 0..9 else 10
Q7  SFA,    on J : <=1..<=10 -> 0..9 else 10
R7  FVL,    on M : <=40->0, <=60->1, <=80->2, else 5
S7  fibre,  on N : Scenario C            -> 0..4 else 5
T7  protein,on O : Scenario G            -> 0..6 else 7     (no ROUND)
U7  salt,   on L : Scenario O            -> 0..19 else 20
V7  sugar,  on I : Scenario AA (Ib)      -> 0..14 else 15
W7  =V7+U7+P7+Q7          X7  =T7+R7+S7
Y7  =W7-X7                                 <-- UNCONDITIONAL; protein always counts
Z7  Y<1 A | Y<3 B | Y<11 C | Y<19 D | else E
```

### 1.2 Red meat

Identical to cheese except:

```
H7  =IF(G7="","",ROUND(G8*4.2,0))          <-- reads G8, the NEXT row
T7  =IF(ISBLANK(O7)," ",IF(O7<=Scenario!$G$3,0,IF(O7<=Scenario!$G$5,1,2)))   <-- capped at 2
Y7  =IF(W7<11,W7-X7,W7-S7-R7)              <-- protein dropped once negatives reach 11
```
There is no "FVL ≥ 80 %" escape clause; the test is purely `W7<11`.

### 1.3 Fats, oils, nuts and seeds

Columns: G kcal, H kJ, I total fat, J saturates, K ratio %, L energy-from-SFA, M sugar, N sodium,
O salt, P FVL, Q fibre, R protein.

```
H7  =IF(G7="","",ROUND(G7*4.2,0))          correct on every row -- but H and G are NEVER used
K7  =J7/I7*100                             no zero guard
L7  =J7*37
S7  ratio pts, on K, STRICT < :  <10->0, <16->1, <22->2, <28->3, <34->4,
                                 <40->5, <46->6, <52->7, <58->8, <64->9, else 10
T7  fibre  Scenario C   U7 protein Scenario G   V7 salt Scenario O   W7 sugar Scenario AA (Ib)
X7  energy pts on L (= SFA x 37, NOT on H), Scenario AI -> 0..9 else 10
Y7  FVL on P : <=40->0, <=60->1, <=80->2, else 5
Z7  =W7+V7+X7+S7          AA7 =U7+Y7+T7
AB7 =IF(Z7<7,Z7-AA7,Z7-Y7-T7)              <-- threshold is 7, not 11
AC7 AB<-5 A | AB<3 B | AB<11 C | AB<19 D | else E      (A means score <= -6)
```
`AE7`/`AF7` are dead `#REF!` columns.

### 1.4 Beverages

Columns: G water YES/NO, H kcal, I kJ, J sugar, K saturates, L sodium, M salt, N sweetener YES/NO,
O FVL %, P fibre, Q protein. **G and N are pre-filled `"NO"` on rows 2–1986.**

```
I7  =IF(H7="","",ROUND(H7*4.2,0))          correct on every row
R7  SFA    <=1..<=10 -> 0..9 else 10
S7  FVL    <=40->0, <=60->2, <=80->4, else 6        <-- 0/2/4/6, not 0/1/2/5
T7  fibre  <=3,4.1,5.2,6.3,7.4 -> 0..4 else 5       (hardcoded, same numbers as Scenario C)
U7  protein <=1.2,1.5,1.8,2.1,2.4,2.7,3.0 -> 0..6 else 7   <-- beverage-specific
V7  energy <=30,90,150,210,240,270,300,330,360,390 -> 0..9 else 10
W7  salt   <=0.2 … <=3 -> 0..14, then  M7<3.2 -> 15  (STRICT), <=3.4->16 … <=4->19, else 20
X7  sugar  <=0.5,2,3.5,5,6,7,8,9,10,11 -> 0..9 else 10
Y7  =IF(N7="NO",X7+W7+V7+R7, 4+X7+W7+V7+R7)         <-- +4 unless N is exactly "NO"
Z7  =U7+S7+T7             AA7 =Y7-Z7                <-- unconditional
AB7 grade, in order:
      G="NO"  and any of I,J,K,M,O,P,Q,N blank            -> "missing data"
      G="YES" and all of I,J,K,M,O,P,Q,N blank            -> "Nutrimark_A"
      G="YES" and any of them non-empty                   -> "ERROR"
      AA<=2 B | AA<=6 C | AA<=9 D | else E
```
`AB2` alone omits `ISBLANK(N2)` from the second test; `AB3:AB1986` include it. That inconsistency turns
out to be inert — see §2.5.

**There is no A branch for a scored beverage.** The best attainable grade is B at any score ≤ 2,
however negative. Cut-offs here use `<=`; cheese, red meat and fats use `<`.

### 1.5 What differs between categories

| | cheese | red meat | fats | beverages |
|---|---|---|---|---|
| energy basis | H kJ | H kJ | L = SFA×37 | I kJ |
| sugar table | Ib (15) | Ib (15) | Ib (15) | own (10) |
| protein table | G (7) | G capped 2 | G (7) | own (7) |
| FVL map | 0/1/2/5 | 0/1/2/5 | 0/1/2/5 | 0/2/4/6 |
| extra negative | — | — | ratio pts | +4 sweetener |
| protein dropped when | never | N ≥ 11 | N ≥ 7 | never |
| grades | <1,<3,<11,<19 | same | <-5,<3,<11,<19 | ≤2,≤6,≤9, B–E only |
| kcal→kJ | `ROUND(G[-1]*4.2,0)` broken | `ROUND(G[+1]*4.2,0)` broken | correct | correct |
| `ROUND(protein,2)` | **no** | **no** | **no** | **no** |

Only `General foods!T7` wraps protein in `ROUND(O7,2)`. Remember that for §2.

---

## 2. `rules.json` and `nutrimark.js` against Section 1

### 2.1 What is correct — verified, not assumed

The `"gt"` convention (`count of value > t`) reproduces an official `<=` chain exactly, and `"ge"`
(`count of value >= t`) reproduces the fats strict-`<` chain exactly. 642 of 684 adversarial products
agreed outright. Every one of these matched on both score and grade across the full threshold sweep:

| checked | result |
|---|---|
| energy, satfat, sugar, salt, fibre, protein, FVL ladders — cheese, red meat, fats, beverages, each threshold and threshold+0.01 | all agree (≈ 500 probes) |
| fats energy-from-SFA ladder (120 … 1200) | 20/20 |
| fats strict-`<` ratio ladder incl. exact 10, 16 … 64 | agree |
| red-meat protein cap at 2 (0, 2.39, 2.4, 2.41, 4.79, 4.8, 4.81, 10, 100) | 9/9 |
| protein-drop straddles: fats `Z<7`, red meat `W<11` | 13/13 |
| fats grade A at score ≤ −6 (the `<-5` boundary) | 5/5 |
| beverages B/C/D cut-offs and the absence of any A path | agree |
| beverages FVL map 0/2/4/6, sweetener flag = 4 | agree |
| negative scores, all-zero and all-1000 extremes | agree |

`rules.json` line 58 `{"max": -6, "grade": "A"}` for fats is **correct**, not a transcription slip: all
point components are integers, so `score <= -6` and `score < -5` are the same predicate. Same for the
`{"max": 0 / 2 / 10 / 18}` cut-offs against `<1 / <3 / <11 / <19`.

**The fats ratio float handling is correct and load-bearing.** `nutrimark.js:73` computes
`Math.round((satfat_g * 100 / fat_g) * 1e9) / 1e9`, reordering the sheet's `J7/I7*100` and quantising.
That looks like a liberty; it is not. In raw IEEE-754, `58/100*100` is `57.99999999999999`, and under the
strict-`<` ladder that scores 8 points instead of 9. Excel and LibreOffice hide this with ~15-significant-digit
comparison rounding — I confirmed it by evaluating `=IF(58/100*100<58,"LT58","GE58")` in the recalculated
workbook, which returns `GE58`. Without the `1e-9` quantisation the engine would disagree with the tool on
10 of 26 ratio probes. 18 float-probe products agreed 18/18.

### 2.2 Finding R1 — protein is rounded to 2 dp in every category. **MUST-FIX**

`nutrimark.js:75`
```js
values.protein_g = round2(p.protein_g);
```
is unconditional. `rules.json:9` documents it as
```
"protein_round": "protein rounded to 2 decimals before lookup, as the official tool"
```

That sentence is false for four of the five categories. Only `General foods!T7` contains
`ROUND(O7,2)`; `Cheese!T7`, `Red meat!T7`, `Fats…!U7` and `Beverages!U7` compare the raw value.

Measured. Any protein value with three or more decimals sitting just above a step diverges by one point,
and near a cut-off the letter changes:

| category | protein | official score / grade | engine score / grade |
|---|---|---|---|
| cheese | 7.204 | 10 → **C** | 11 → **D** |
| cheese | 2.404 | 12 → D | 13 → D |
| cheese | 4.804 | 11 → D | 12 → D |
| red meat | 4.804 (salt 0.2) | 2 → **B** | 3 → **C** |
| red meat | 2.404 | 6 → C | 7 → C |
| beverages | 1.204 (sugar 2) | 2 → **B** | 3 → **C** |
| beverages | 1.504 (sugar 3) | 2 → **B** | 3 → **C** |
| beverages | 1.804 (sugar 5) | 2 → **B** | 3 → **C** |
| fats | 14.004 (Z = 0) | −6 → **A** | −5 → **B** |
| fats | 2.404 (Z = 0) | −1 → B | 0 → B |

Across two runs: 53 score mismatches, **7 confirmed grade-letter flips**, in all four categories.
Fix: move `protein_round` out of the shared conventions and apply it only when
`input.category === "general"`. Then correct the `rules.json` sentence.

### 2.3 Finding R2 — `water: true` returns A with no validation. **MUST-FIX**

`nutrimark.js:59–62` returns grade A for any beverage with `water === true`, before the required-field
check, ignoring every nutrient supplied.

The intent is sourced correctly. `QCC_Nutri-mark_QandA_rev2.txt`, the "Which products are categorized as
beverages?" answer, reads:

> "The Nutri-Mark category of Beverages applies to the following products if they include a nutritional
> declaration, except bottled waters for which a default Nutri-Mark rating of 'A' / dark green can be
> displayed without mandatory nutritional declaration: • Mineral water, table water and spring water
> (default Nutri-mark 'A') • **Flavoured water (with and without added sugars). This category is different
> from mineral water and spring water and cannot receive a Nutri-Mark 'A'** …"

The same passage that grants A to bottled water denies it to flavoured water. The engine has no notion of
the distinction, so a product flagged `water: true` carrying 11 g of sugar returns A. Measured:

| product | official | engine |
|---|---|---|
| water=YES, full nutrients (40 kcal, 3 g sugar, 40 mg sodium, 1 g protein) | ERROR | **A** |
| water=YES, sugar 11 g | ERROR | **A** |

Gate the water branch on the absence of any declared nutrient, and return an error otherwise.

### 2.4 Finding R3 — `normalise()` defaults make two `REQUIRED` checks dead. **MUST-FIX**

`nutrimark.js:22–23`
```js
if (!isNum(p.fvl_pct)) p.fvl_pct = 0;
if (p.sweeteners === undefined) p.sweeteners = false;
```
`normalise()` runs at line 55, the `REQUIRED` filter at line 64. So `fvl_pct` and `sweeteners` can never be
reported missing, and their entries in `REQUIRED` (lines 6–10) are unreachable code. The official tool
refuses to grade in both cases.

| case | official | engine |
|---|---|---|
| cheese, FVL cell blank | missing data | **C, score 6** |
| beverages, sweetener cell blank | missing data (and the score column shows 8, i.e. the +4 applies) | missing data, score null |

The FVL default is a defensible product decision — labels rarely declare it — but it is undeclared. It is
not in `known_official_tool_defects`, and the `REQUIRED` table asserts the opposite. Either drop the
defaults and let the check fire, or document the substitution and delete the dead entries.

### 2.5 Everything else in §2 checked and clean

`known_official_tool_defects` line 79 says the beverage water route "tests ISBLANK on formula cells and
never fires; bottled water returns ERROR". **I set out to disprove this and could not.** My first attempt
appeared to show grade A, but that run had written Python `None` into columns I and M, which deletes the
cells and destroys the kJ and salt formulas. Re-run with the formulas intact, on the rows a user would
actually fill:

| case (I and M formulas untouched) | AB |
|---|---|
| row 2, water=YES, inputs empty, N at template "NO" | ERROR |
| row 3, same | ERROR |
| row 4, water=YES, N cleared | `#VALUE!` |
| row 5, water=YES, N="NO" explicit | ERROR |
| row 7, water=YES, full nutrients | ERROR |
| row 8, water=NO, inputs empty (control) | missing data |
| row 9, water=NO, full nutrients (control) | Nutrimark_C |

Confirmed with a direct probe: `=ISBLANK(x)` where x holds `=IF(1=1,"","x")` returns **FALSE** in
LibreOffice, matching Excel. The note is accurate.

Line 78 (cheese/red-meat kcal off-by-one) and line 80 (beverage salt 3.2) are also accurate; both are
reproduced under §3.4 and §4.

---

## 3. Attack on the harness

### 3.1 Does LibreOffice actually recalculate? **Yes — proven, not inferred**

| evidence | result |
|---|---|
| `_official_work/in.xlsx` (what the harness wrote) read with `data_only=True` | every score/grade cell `None` — openpyxl's save strips all cached values |
| `_official_work/out/in.xlsx` (what LibreOffice returned) | 80/80 rows carry score **and** grade in all four sheets |
| formulas after the round trip | preserved, e.g. `Cheese!Y2 = '=W2-X2'` |
| row 82, never written | score `#VALUE!`, grade `missing data` — a live evaluation, not a stale cache |
| `Fats!K2`, `L2` cached | 22 and 814 for fat 100 / satfat 22, i.e. `22/100*100` and `22*37` computed fresh |

There is no stale-value or blank-cell hole. The 0-mismatch headline is real for the products it ran.

### 3.2 Does writing kJ and salt into formula cells bypass anything that matters? **Yes, two whole code paths**

`compare_official.py:27–31` writes `energy_kJ` into H (I for beverages) and `salt_g` into L / O / M. All
five are formula cells in the template. Overwriting them means:

- `ROUND(kcal*4.2, 0)` is **never compared against the tool**, so the cheese and red-meat off-by-one
  defects are stepped over rather than measured, and `normalise()`'s conversion is untested.
- `sodium_mg/1000*2.5` is **never compared**. Confirmed from `products.json`: `energy_kcal` supplied in
  0 of 402 products, `sodium_mg` in 0 of 402.

Both conversions are asserted in `rules.json` lines 7–8 to be "as the official tool" and neither is
exercised. I tested them directly in §4; the conversions themselves are right, but the tool's own kcal
column is not, which matters for the demo (§5).

### 3.3 Are the generated products diverse enough? **No**

Grade distribution, taken from the recalculated workbook the harness itself produced:

| category | A | B | C | D | E | score range |
|---|---|---|---|---|---|---|
| general | 1 | 2 | 7 | 21 | 51 | −1 … 37 |
| cheese | 6 | **1** | 10 | 28 | 35 | −4 … 40 |
| red_meat | **2** | **0** | 11 | 20 | 47 | −3 … 46 |
| fats | **2** | **2** | 18 | 29 | 29 | −11 … 33 |
| beverages | **0** | 7 | 14 | 8 | 51 | −4 … 29 |

Eight grade cells hold fewer than 5 products; two hold none. **Red-meat grade B was never produced, and
red-meat grade B is exactly where finding R1 flips a letter** (protein 4.804, salt 0.2: official B, engine C).
Beverage A was never produced because `gen()` hard-codes `"water": False` at line 47, so the engine's entire
water branch and `rules.json`'s `water_is_A` are untested.

Further structural blind spots in the generator:

| blind spot | evidence |
|---|---|
| protein never carries more than 1 decimal | decimal-place histogram over 402 products: `{0: 71, 1: 331}`, `>2 dp: 0` — R1 is invisible by construction |
| `fat_g` never ≤ 0 | min 20.1, max 100; `satfat_g` min 4.2 — the `#DIV/0!` and `fat_g <= 0` paths untested |
| ratio never 0 or > 100 % | 6.68 % … 87.16 % |
| protein-included branch barely reached | red meat N ≥ 11 in **77 of 80**; fats N ≥ 7 in **78 of 80** |
| no blank inputs at all | 0 of 402 products omit a required field, so no missing-data semantics are compared |
| `energy_kcal` / `sodium_mg` | 0 of 402 |
| beverage salt 3.2 | deliberately excluded, line 43 |

### 3.4 Are the known-defect exclusions hiding a real disagreement? **Partly**

The beverage salt 3.2 exclusion is honestly labelled and the divergence is exactly one point, confirmed:
official 20, engine 19, both grade E. But the exclusion is written as a literal value, and the defect is
also reachable through the sodium column, which the harness never uses: **sodium 1280 mg → salt exactly
3.2 g → official 20, engine 19.** I confirmed `=1280/1000*2.5` evaluates to exactly `3.2` and
`=IF(1280/1000*2.5<3.2,"LT","GE")` returns `GE`. 1280 mg per 100 ml is not a plausible beverage, so the
practical risk is low, but the exclusion is narrower than it reads.

The water-row exclusion is not labelled at all — `gen()` simply never sets `water: True`.

### 3.5 Does the comparison logic have a hole? **Two, one benign and one that inflates the pass rate**

`compare_official.py:115`
```python
same = (o["grade"] == e["grade"]) and (o["score"] == e["score"] or (o["score"] is None and e["score"] is None))
```

- `"Nutrimark_"` stripping (line 100) is safe: `"missing data"` and `"ERROR"` survive unstripped and will
  never equal a letter, so a tool refusal against an engine grade is caught.
- The `None == None` clause is the hole in principle: a category where the engine returns
  `{ok: false, error: "missing data"}` and the tool returns `"missing data"` compares equal on grade and
  equal-by-None on score, so the pair is scored as agreement **without either side having produced a
  number**. In this corpus it never fires, because no product has a blank field. It would fire the moment
  blank-input tests were added, and it would hide the §3.6 defects.
- Conversely, a tool `#VALUE!` string against an engine `None` is flagged as a mismatch even where the
  verdicts agree, which will produce noise rather than misses.

### 3.6 Bonus: the harness's oracle is itself broken on blank inputs

This is a property of the official tool, not the harness, but it decides what "agreeing with the tool" is
worth. The cheese grade guard is
`IF(OR(ISBLANK(H7),ISBLANK(I7),ISBLANK(J7),ISBLANK(L7),ISBLANK(M7),ISBLANK(N7),ISBLANK(O7)),"missing data",…)`.
H and L are **formula** cells, so `ISBLANK` on them is always FALSE and those two guards never fire. The
formula then returns `""`, and in Excel ordering text is greater than any number, so the points chain falls
through to its maximum. Confirmed by probe: `=IF(""<=0.2,"LE","GT")` returns `GT`. Measured:

| case | official | engine |
|---|---|---|
| cheese, sodium blank (salt formula intact) | **E, score 22** — 20 salt points awarded | missing data |
| cheese, kcal blank (kJ formula intact) | **D, score 12** — 10 energy points awarded | missing data |
| beverages, kcal blank | **E, score 12** | missing data |
| beverages, sodium blank | **E, score 24** | missing data |
| fats, sodium blank | **E, score 25** | missing data |

A user who leaves sodium empty is silently given the worst possible salt score and a plausible-looking
grade. The engine is right here and the tool is wrong. Any future harness must not treat tool agreement as
the goal in these cases.

---

## 4. Adversarial test results

684 products in run 1 (my own generator, not the harness's), plus 45 targeted probes in run 2, plus an
8-case water matrix. Same LibreOffice method as the harness; engine answers via `run_engine.mjs`.

**Run 1: 642 agree, 42 mismatch, 16 of them grade-letter differences.**

| category | group | agree / total | what it probes |
|---|---|---|---|
| cheese | A-energy / satfat / sugar / salt / fibre / protein / FVL | 148 / 148 | every threshold and threshold+0.01 |
| red_meat | A-* incl. protein cap | 142 / 142 | ditto |
| fats | A-* incl. enSFA, ratio | 126 / 126 | ditto |
| beverages | A-* | 137 / 138 | ditto; the one failure is salt 3.2 |
| fats | B-ratiofloat | 18 / 18 | awkward denominators at the strict-`<` steps |
| fats | B-ratio0 | 3 / 3 | ratio 0, 100, 120 % |
| fats | F-fatsA, G-drop | 12 / 12 | A boundary at −6; `Z<7` straddle |
| red_meat | G-drop | 6 / 6 | `W<11` straddle |
| all | F-extreme, F-neg | 11 / 12 | zeros, 1000s, negative scores; the one failure is fats all-zeros, i.e. `fat_g = 0` |
| all | I-sodium | 19 / 20 | sodium → salt through the sheet formula |
| **cheese / red_meat** | **I-kcal** | **2 / 10** | official off-by-one, §4.1 |
| **all four** | **C-round2** | **7 / 20** | finding R1 |
| **cheese / bev / fats** | **H-blank** | **0 / 9** | §3.6 |
| **beverages** | **E-water** | **0 / 5** | finding R2 |
| **fats** | **B-fat0** | **1 / 3** | `#DIV/0!` vs engine error |

### 4.1 The cheese and red-meat kcal off-by-one, measured

Writing kcal into column G on rows 2–6 and leaving H as the template formula:

| row | kcal in G | cheese official | cheese engine | red meat official | red meat engine |
|---|---|---|---|---|---|
| 2 | 400 | C 7 | C 7 ✓ | C 8 | C 8 ✓ |
| 3 | 100 | C 7 | C 3 | C 5 | C 4 |
| 4 | 200 | C 3 | C 4 | C 6 | C 5 |
| 5 | 300 | C 4 | C 5 | **D 11** | **C 6** |
| 6 | 500 | C 5 | C 8 | **C 3** | **D 11** |

Row 2 agrees in both sheets — it is the only row whose formula is right. Every row below it is wrong.
Cheese row 3 returns score 7, identical to row 2, because `H3 = ROUND(G2*4.2,0)` re-reads the 400 kcal
entered on row 2 and ignores its own 100 kcal. Red meat row 6 reads `G7`, which is empty, so the product is
scored at 0 kJ and lands two grades away from the truth. The engine is correct; the workbook is not.

### 4.2 Grade-letter differences, run 1

| category | case | official | engine | cause |
|---|---|---|---|---|
| cheese | protein 7.204 | C | D | R1 |
| beverages | protein 1.504 | B | C | R1 |
| beverages | water=YES + nutrients | ERROR | A | R2 |
| beverages | water=YES + sugar 11 | ERROR | A | R2 |
| beverages | water=YES, sweetener "NO" | ERROR | A | R2 |
| cheese | FVL blank | missing data | C | R3 |
| cheese | sodium blank | E | missing data | tool defect §3.6 |
| cheese | kcal blank | D | missing data | tool defect §3.6 |
| beverages | kcal blank | E | missing data | tool defect §3.6 |
| beverages | sodium blank | E | missing data | tool defect §3.6 |
| fats | sodium blank | E | missing data | tool defect §3.6 |
| fats | fat 0 (×3) | `#DIV/0!` | "total fat must be above zero" | both refuse; representation differs |
| red meat | kcal row 5, row 6 | D / C | C / D | tool defect §4.1 |

**Run 2, targeted at finding R1: 40 mismatches of 45, 7 grade flips** — cheese C→D and B→C, beverages
B→C three times, red meat B→C, fats A→B. The fats flip (`protein 14.004`, negatives 0: official −6 grade A,
engine −5 grade B) shows R1 reaches fats too; run 1 missed it only because my fats baseline had
negatives ≥ 7, which drops protein from the score.

**Controls that passed:** protein at exactly 2.4, 2.41, 4.8, 4.81 agree — R1 needs a third decimal.

---

## 5. Gaps

**G1. The audited engine is not the code the prototype runs. BLOCKER.**
`index.html`, `docs/index.html` and `qa.html` contain no `import`, no `type="module"`, no reference to
`nutrimark.js`, and no call to `computeGrade`. Each carries its own inline calculator
(`index.html:442–461`) with a single set of tables and this comment at line 457:

```js
const countProtein = N<11;   // draft 5.3.2(b): protein excluded whenever N >= 11 (cheese excepted; not modelled here)
```

The shipped page implements general foods only, and says so. The only `rules.json` string in the page is a
prose comment at line 440 pointing at `research/nutrimark_rules.json`, a different file. So
`engine/test/REPORT.md`'s "0 mismatches across five categories" is a statement about a library with no
caller. Nobody should read it as evidence about the demo.

**G2. The official tool models things the engine does not.**

| behaviour | tool | engine |
|---|---|---|
| blank sodium / blank kcal | grades the product at maximum salt / energy penalty (§3.6) | refuses — **engine is better** |
| blank FVL | "missing data" | substitutes 0 % and grades (R3) |
| blank sweetener | "missing data", and the score carries the +4 | refuses, no +4 |
| sweetener cell holding anything other than `"NO"` | +4 | only a JS `true` adds 4 |
| water=YES with data present | ERROR | A (R2) |
| `fat_g = 0` | `#DIV/0!` propagated to the grade | typed error — **engine is better** |
| cheese / red-meat kcal entry | off by one row | correct — **engine is better** |

**G3. The engine models things the tool does not.**
Grade A for water (sourced from the Q&A, correct in principle, ungated in practice — R2); a typed
`fat_g <= 0` error; and a clean `missing data` refusal where the tool silently maxes out a component.
These are improvements, but three of them mean engine-vs-tool agreement can never reach 100 %, so the
harness needs an expected-divergence list rather than a raw mismatch count.

**G4. Not covered by anyone.** No test writes kcal or sodium and compares the conversion. No test supplies
a blank field. No test sets `water: true`. No test uses a protein value with three decimals. Each of those
four gaps concealed a finding above.

---

## 6. Verdict

| # | finding | severity |
|---|---|---|
| G1 | The prototype pages do not import `nutrimark.js` or `rules.json`; they run an inline general-foods-only calculator that explicitly excludes cheese. `REPORT.md`'s five-category clean run describes uncalled code. | **blocker** |
| R1 | `nutrimark.js:75` rounds protein to 2 dp for every category. The official tool does that only on `General foods`. 53 score mismatches and 7 grade-letter flips across cheese, red meat, fats and beverages. `rules.json:9` asserts the opposite of the workbook. | **must-fix** |
| R2 | `nutrimark.js:59–62` returns A for `water: true` regardless of declared nutrients, before the required-field check. The Q&A passage that grants A to bottled water denies it to flavoured water with added sugars. | **must-fix** |
| R3 | `normalise()` defaults `fvl_pct` to 0 and `sweeteners` to false before the `REQUIRED` filter, so both entries in `REQUIRED` are dead code and the engine grades products the tool refuses. Undocumented. | **must-fix** |
| H1 | Harness coverage is skewed: red-meat B has 0 products, beverage A has 0, six more grade cells below 5; protein never exceeds 1 decimal; `water: true`, blank fields, `energy_kcal`, `sodium_mg` and `fat_g ≤ 0` are never generated. The 0-of-402 result is a property of the generator, not of the engine. | **must-fix** |
| H2 | `compare_official.py:115` scores `None == None` as agreement, so a mutual refusal counts as a pass without either side producing a number. Dormant today, would fire the moment blank-input tests are added. | note |
| H3 | Writing kJ and salt directly into H / L / I / M / O leaves `ROUND(kcal*4.2,0)` and `sodium/1000*2.5` uncompared against the tool. Both are asserted in `rules.json:7–8` to match it. | note |
| H4 | The beverage salt 3.2 exclusion is labelled, but the same defect is reachable via sodium 1280 mg, which the harness never writes. | note |
| D1 | Official tool: `Cheese!H3:H1099` reads the previous row's kcal; `Red meat!H3:H1100` reads the next row's. Only row 2 is correct. Confirmed on rows 3–6. The engine is right; `rules.json:78` documents it. | note (tool defect) |
| D2 | Official tool: the cheese, red-meat, fats and beverage missing-data guards test `ISBLANK` on formula cells, so blank sodium or blank kcal produces a maximum-penalty grade instead of "missing data". Undocumented in `rules.json`. | note (tool defect, worth adding) |
| D3 | Official tool: `Beverages!W` uses `M<3.2` among `<=` steps; salt exactly 3.2 scores 16 not 15. Documented at `rules.json:80`. | note (tool defect) |
| D4 | Official tool: `Beverages!AB2` omits `ISBLANK(N2)` from the water→A test while rows 3+ include it. Behaviourally inert — `ISBLANK` on the I and M formula cells is FALSE on every row, so the branch never fires anywhere. Verified, not assumed. | note (tool defect) |
| D5 | Official tool: `Fats!K = J/I*100` has no zero guard; `#DIV/0!` propagates to the grade. `Fats!AE`/`AF` are dead `#REF!` columns. | note (tool defect) |

**No finding against the threshold tables, operators, maps, score rules or grade cut-offs in
`rules.json` for any of the four categories in scope.** Roughly 600 boundary probes agreed. The
`"gt"`/`"ge"` convention, the fats A boundary at −6, the beverage B–E-only ladder, the red-meat protein
cap, both protein-drop thresholds, and the fats ratio float handling are all correct and, in the last
case, correct for a non-obvious reason I verified rather than took on trust.

The engine's arithmetic is sound. What is not sound is the claim built on top of it: a harness whose
generator avoids every input where the engine and the tool differ, reporting zero mismatches, for code
that the demo does not call.

---

## 7. Re-verification after the step-2 fixes

Re-run against the current `engine/nutrimark.js`, `engine/rules.json` and `engine/test/compare_official.py`.
My 684-product adversarial suite and 45-probe follow-up were re-run **unchanged**, and three new probe sets
were added for the EPS tolerance, the water gate and the required-field enforcement. No project file was
modified.

| finding | status |
|---|---|
| 1 â€” pages do not use the engine | **open by design** (scheduled for step 3) |
| 2 â€” protein rounded in every category | **fixed** |
| 3 â€” `water: true` returns A unvalidated | **fixed**, one narrow residual |
| 4 â€” silent `fvl_pct` / `sweeteners` defaults | **fixed** |
| 5 â€” harness coverage | **fixed**, one residual blind spot |
| 7 â€” `None == None` counted as a match | **fixed**, one new escape hatch |
| new â€” `EPS = 1e-9` in `stepPoints()` | **safe for real inputs**, characterised below |

Headline: my suite went from 42 mismatches to **29 of 684**, and every one of the 13 removed was a
finding-2 case. The 29 that remain are the same official-tool defects and documented divergences reported
in Â§6 (kcal off-by-one Ã—8, blank-cell maxing Ã—9, salt 3.2 Ã—3, `fat_g = 0` Ã—3, water-route ERROR Ã—5, blank
sweetener Ã—1). **No fix introduced a regression**: all ~600 threshold probes still agree.

### 7.1 Finding 2 â€” fixed

`rules.json:28` carries `"protein_round": 2` on `general` only; it is `undefined` on cheese, red_meat, fats
and beverages. `nutrimark.js:86` applies it conditionally:

```js
if (cat.protein_round === 2) values.protein_g = round2(p.protein_g);   // general foods only
```

The 45 targeted three-decimal probes that previously produced **40 mismatches and 7 grade-letter flips now
produce 0 and 0**. The 13 `C-round2` mismatches in the main suite are gone. The `rules.json:9` sentence now
states the rule correctly, naming the four categories that use the raw value.

### 7.2 Finding 3 â€” fixed, with one narrow residual

`isPlainWater()` gates the A route on `water === true` **and** sugar absent-or-zero **and** energy
absent-or-zero **and** `sweeteners !== true`. Measured directly against the engine:

| input | grade | note emitted |
|---|---|---|
| water, nothing declared | A | plain water: default grade A |
| water, sugar 0, energy 0, sweeteners false | A | plain water |
| water, sugar 11 | **E, score 11** | water flag ignored |
| water, sugar 0, energy 180 | **C, score 3** | water flag ignored |
| water, sugar 0, energy 0, sweeteners true | **C, score 4** | water flag ignored |
| water, sugar 0.1 trace | **B, score 0** | water flag ignored |
| water, energy given as 45 kcal | **C, score 3** | water flag ignored |

The kcal path is covered because `normalise()` runs before the gate. Against the official tool, the two
water-with-nutrients rows that previously read `engine A` now read `engine C 4` and `engine E 11` â€” **the
engine's score now equals the tool's exactly** (4 and 11); only the tool's `ERROR` grade differs, which is
the documented unreachable-A-route defect.

**Residual (note).** The gate tests sugar, energy and sweeteners only. A product flagged as water with
`satfat_g: 2`, `protein_g: 3.5` or `fvl_pct: 100` declared, and energy and sugar both zero, still returns A:

```
water, sugar0 energy0, protein 3.5 declared   -> A
water, sugar0 energy0, satfat 2 declared      -> A
water, sugar0 energy0, fvl 100 declared       -> A
```

Every one of those is self-contradictory input â€” 3.5 g of protein cannot coexist with 0 kJ â€” so no real
label reaches it. But the code comment at `nutrimark.js:26` promises "nothing that makes it a flavoured
drink is declared", which is wider than what the function checks. Either widen the gate to every negative
component or narrow the comment.

### 7.3 Finding 4 â€” fixed

`normalise()` no longer injects `fvl_pct`, `sweeteners` or `water`; it returns only the two conversions:

```
normalise({category:"cheese", energy_kcal:100, sodium_mg:400})
  -> {"category":"cheese","energy_kcal":100,"sodium_mg":400,"energy_kJ":420,"salt_g":1}
```

`REQUIRED` is now live in every case I could construct:

| input | result |
|---|---|
| cheese, `fvl_pct` omitted | refuses, `missing: ["fvl_pct"]` |
| fats, `fvl_pct` omitted | refuses, `missing: ["fvl_pct"]` |
| beverages, `fvl_pct` omitted | refuses, `missing: ["fvl_pct"]` |
| beverages, `sweeteners` omitted | refuses, `missing: ["sweeteners"]` |
| beverages, `sweeteners: null` | refuses |
| beverages, `sweeteners: "NO"` (string) | refuses â€” boolean is enforced |

Against the tool, the cheese blank-FVL row that previously read `engine C 6` against `official missing
data` now reads `engine missing data`, i.e. both sides refuse.

One consequence worth stating: the plain-water branch returns before the `REQUIRED` check, so
`{category:"beverages", water:true}` with `sweeteners` omitted returns A rather than refusing. That is
correct â€” the Q&A grants bottled water an A "without mandatory nutritional declaration" â€” but it means the
`sweeteners` requirement is bypassed on that one path by design.

### 7.4 Finding 5 â€” fixed, with a measured blind spot in fats

The generator now produces low/mid/high/veg/edge profiles, protein at up to 3 decimals, kcal and sodium
input variants, missing-field rows, `fat_g = 0`, and plain and flavoured water. Reported coverage: every
category has at least 5 products in every grade except beverage A.

**Beverage A is correctly unreachable.** I verified in Â§2.5 that the tool's waterâ†’A branch cannot fire on
any row, because `ISBLANK` on the kJ and salt formula cells is FALSE. So no product can make the tool emit
A for a beverage; the gap is a property of the authority, not of the generator. The engine's beverage-A path
is instead covered by the `water-plain` special row, checked against the Q&A rather than against the tool.
That is the right arrangement and should stay documented as such.

**Residual blind spot (must-fix, small).** I measured whether the current corpus could actually detect a
regression of finding 2, by recomputing each product's protein points with and without `round2`:

| category | products whose protein points would change | discriminating value |
|---|---|---|
| general | 3 of 104 | 4.801 |
| cheese | 1 of 90 | 4.801 |
| red_meat | 4 of 89 | 4.801 |
| **fats** | **0 of 90** | **none â€” a regression here is invisible** |
| beverages | 1 of 103 | 1.502 |

The fats edge profile draws protein from `[2.4, 2.405, 4.8, 7.2, 17]` (`compare_official.py:74`). None of
those discriminates: `round2(2.405)` is 2.41, which sits in the same band as 2.405. Adding `4.801` to that
list, as the other categories have, closes it. Note also that cheese and beverages rest on a single
discriminating product each, so the guard is thin there too.

### 7.5 Finding 7 â€” fixed, with a new escape hatch

The classification is sound. `match` now requires both sides to have produced a value:

```python
if (not o["refused"]) and e["ok"] and o["grade"] == e["grade"] and o["score"] == e["score"]:
```

`refused` (line 166) is set when the grade is `missing data` / `ERROR` / empty, **or** starts with `#`,
**or** the score is not numeric â€” so `#VALUE!` is caught. Mutual refusals are counted and listed under
`both-refuse`, never as matches, and a one-sided refusal falls through to `MISMATCH`. The original hole is
closed.

**New issue (note).** `compare_official.py:180-181` exempts a product from all checking on the strength of a
label in its own input data:

```python
if exp == "documented-defect":
    classes["documented-defect"] += 1; lines_doc.append(...); continue
```

There is no assertion before the `continue`. Those three products are printed but never compared, so if the
engine's answer for `water-flavoured` drifted from `E 12` to anything else, the harness would report the
same "documented-defect" line and still print 0 mismatches. Assert the expected shape â€” for example that the
tool grade is `ERROR` and that the two scores agree where both are numeric â€” rather than trusting the tag.

Minor: `expect: "both-refuse"` is declared on four special rows but never read; those rows are classified by
the generic test, which happens to be the right one. And `o["grade"] in "ABCDE"` (line 178) is a substring
test rather than a membership test; it is correct only because grades are single characters and the
`and o["grade"]` guard excludes the empty string.

### 7.6 New: the `EPS = 1e-9` tolerance â€” safe, and wider than it needs to be

`nutrimark.js:37`

```js
const cmp = spec.op === "ge" ? (v, t) => v >= t - EPS : (v, t) => v > t + EPS;
```

**The justification checks out.** I measured the sheet, not the claim: `=1120/1000*2.5` returns `2.8` and
`=IF(1120/1000*2.5<=2.8,"LE2.8","GT2.8")` returns **`LE2.8`**. In JavaScript the same expression is
`2.8000000000000002665`, which is `> 2.8`. So before this fix the engine awarded one extra salt point for
1120 mg sodium and disagreed with the tool. **My step-1 suite missed it** â€” I tested sodium 0, 80, 400,
1280 and 1600, never 1120. The fix is real and it closes a real bug.

**It is exercised, not merely asserted.** Two products in the current corpus depend on it:
`red_meat-056-sodium` (1120 mg â†’ salt 2.8000000000000003, 13 points with EPS, 14 without) and
`beverages-056-sodium` (1360 mg â†’ 3.4000000000000004, 16 vs 17). Both pass against the tool.

**Where it diverges, measured.** I swept 270 products at tâˆ’1e-3, âˆ’1e-6, âˆ’1e-8, âˆ’1e-9, exact, +1e-9, +1e-8,
+1e-6, +1e-3 across the salt, sugar, protein, fibre, FVL, beverage-sugar, beverage-protein,
energy-from-SFA and fats-ratio ladders:

| offset from a threshold | disagreements |
|---|---|
| Â±1e-3, Â±1e-6, Â±1e-8, exact | **0** |
| **+1e-9 on a `gt` ladder** | 23 of 23 |
| **âˆ’1e-9 on the `ge` ratio ladder** | 4 of 4 |

242 of 270 agree. The divergence is confined to exactly the one-sided window EPS defines â€” `(t, t+1e-9]` for
`gt`, `[tâˆ’1e-9, t)` for `ge` â€” and nothing coarser than 1e-8 is affected. Two of those synthetic cases even
flip a letter (`fvl 80+1e-9`: tool B 1, engine C 4, because the FVL map jumps 2â†’5; `ratio 58âˆ’1e-9`: tool D
18, engine E 19), which shows the window is real rather than harmless by construction.

**Can it change a legitimate boundary? No.** The finest granularity any declaration carries is 3 decimals,
six orders of magnitude coarser than the window. The two derived quantities are safe for specific reasons:
`salt = sodium/400` can only deviate sub-1e-9 through float artifacts, which is the point of the fix;
`satfat_ratio_pct` is already quantised to 1e-9 at line 84, and the nearest rational with realistic
denominators lies at least 1e-5 from any threshold.

**One caveat on the wording.** The comment at `nutrimark.js:32-33` says the tolerance reproduces what
spreadsheets do. It over-corrects: the sheet's tolerance is roughly 15 significant digits, i.e. ~1e-15
*relative*, while EPS is 1e-9 *absolute*. I confirmed the difference â€” the sheet returns `GT` for both
`=IF(2.8000000001<=2.8,â€¦)` and `=IF(2.800000001<=2.8,â€¦)`, so it does **not** swallow deviations at 1e-9 or
1e-10; it only swallows the ~4e-16 artifact. A tolerance of 1e-12 would absorb every float artifact that can
arise here while shrinking the divergence window by three orders of magnitude. Not a defect, and no real
input reaches the difference â€” but the comment claims a match that is not exact.

### 7.7 Still open

| # | item | severity |
|---|---|---|
| 1 | Pages do not import the engine (open by design, step 3) | blocker, scheduled |
| 5a | A protein-rounding regression in **fats** is invisible to the harness: 0 of 90 products discriminate. Add `4.801` to the fats edge protein list. | must-fix, small |
| 7a | `expect: "documented-defect"` skips all comparison; 3 products are unchecked. Assert the expected shape. | note |
| 3a | The water gate checks sugar, energy and sweeteners only; the code comment promises more. Reachable only with self-contradictory input. | note |
| EPS | 1e-9 absolute is ~6 orders wider than the sheet's ~1e-15 relative tolerance; 1e-12 would do the same job. The comment overstates the match. | note |

**One of my six original findings remains open, and it is open by design.** Findings 2, 3, 4, 5 and 7 are
fixed and independently re-verified; no fix introduced a regression in ~600 threshold probes.

