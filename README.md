# Nutri-Mark Scan

An interactive prototype of a label-scanning flow for the Nutri-Mark front-of-pack nutrition grade (A to E).

The visitor photographs the nutrition table on a packaged food, the values are read, and the product's grade is computed and shown with the reasons behind it and a "what if the maker cut the sugar" slider.

**This is a design prototype.** The camera, the label and the product are simulated. There is no image reading and no backend. Its purpose is to show the screens and the motion.

## Open it

The live page: see the repository's GitHub Pages link.

Locally, open `docs/index.html` in any browser. It works at phone width and on a desktop, in Arabic and in English, and offers three visual treatments switchable from the bar above the phone frame.

## Calculation

The grade logic in the page follows the Abu Dhabi Quality and Conformity Council (QCC) Nutri-Mark algorithm for general foods, as published in the QCC calculation tool (April 2026) and the Abu Dhabi Guideline for the Use of the Nutrition Mark (ADG-044-2024). It was checked against the official tool on a set of test products, including boundary values.

`research/nutrimark_rules.json` holds every threshold table for all product categories (general foods, cheese, red meat, fats and oils, beverages), transcribed from the official documents with page references, for use by a future rule engine.

## Sources

- QCC Nutri-Mark official documents and tools: https://qcc.gov.ae/Nutri-Mark/Official-Documents-and-Tools
- QCC, how the score is calculated: https://qcc.gov.ae/Nutri-Mark/Score
- MoIAT draft UAE technical regulation on the Nutri-Mark (WTO TBT notification ARE/679, November 2025)

The Nutri-Mark name and mark belong to the Abu Dhabi Quality and Conformity Council. Any use of the mark in an application is subject to QCC's Conditions for Use.

## Status

Prototype. Grades shown are estimates computed from label values and are not an official certification.
