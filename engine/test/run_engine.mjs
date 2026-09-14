// Reads a JSON array of products on stdin, prints a JSON array of engine results.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeGrade } from "../nutrimark.js";

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, "..", "rules.json"), "utf8"));
const products = JSON.parse(readFileSync(0, "utf8"));
const out = products.map(p => {
  const r = computeGrade(rules, p);
  return { id: p.id, ok: r.ok, grade: r.ok ? r.grade : (r.error || "error"), score: r.ok ? r.score : null, N: r.N ?? null, P: r.P ?? null };
});
process.stdout.write(JSON.stringify(out));
