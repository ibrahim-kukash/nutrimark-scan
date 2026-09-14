# Engine vs official QCC calculator

Products: 478 (80 per category across low/mid/high/veg/edge profiles, plus kcal and sodium input variants, plus 9 special rows). Official values: the QCC April 2026 workbook recalculated by LibreOffice Calc headless. Engine: engine/nutrimark.js with engine/rules.json.

| class | count |
|---|---|
| match | 471 |
| both-refuse | 4 |
| documented-defect | 3 |

## Grade coverage (official grades, per category)

| category | A | B | C | D | E | under 5 |
|---|---|---|---|---|---|---|
| general | 11 | 8 | 12 | 28 | 44 | none |
| cheese | 10 | 5 | 28 | 9 | 37 | none |
| red_meat | 12 | 7 | 14 | 16 | 40 | none |
| fats | 8 | 12 | 15 | 16 | 38 | none |
| beverages | 0 | 21 | 25 | 17 | 39 | A |

## Mismatches

none

## Documented tool defects (listed, not counted)

- water-plain: tool ERROR None | engine A None (as expected) | tool returns ERROR for plain water (unreachable A route); engine A per Q&A
- water-flavoured: tool ERROR 12 | engine E 12 (as expected) | tool returns ERROR when water=YES with nutrients; engine ignores the flag and grades: energy 3 + sugar 9 = 12
- bev-salt-3.2: tool E 20 | engine E 19 (as expected) | tool '<3.2' step gives 16 salt points (score 20); engine 15 (energy 2 + sugar 2 + salt 15 = 19)

## Both refused

- missing-sugar: tool 'missing data' | engine 'missing data'
- missing-fibre-cheese: tool 'missing data' | engine 'missing data'
- missing-protein-fats: tool 'missing data' | engine 'missing data'
- fat-zero: tool '#DIV/0!' | engine 'total fat must be above zero'

**Total mismatches: 0 of 478.**
- ref-sample: tool D 11 | engine D 11
- ref-moiat-example: tool D 16 | engine D 16