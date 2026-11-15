// Loader hooks that let the real Worker module (src/index.js) run under plain node, with no network and no key:
//   - "./reader.js" (the AI reader) is swapped for a stand-in that returns canned readings
//   - engine/rules.json is served as a module (the Worker bundler does this; node needs an import attribute)
// Nothing else is changed: every other line that runs is the Worker's own.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STAND_IN = new URL("./reader_stand_in.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./reader.js" && /\/backend\/src\/index\.js$/.test(context.parentURL || "")) return { url: STAND_IN, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (/\/engine\/rules\.json$/.test(url)) {
    return { format: "module", source: "export default " + readFileSync(fileURLToPath(url), "utf8") + ";", shortCircuit: true };
  }
  return nextLoad(url, context);
}
