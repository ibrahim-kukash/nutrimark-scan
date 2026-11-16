// Stand-in for src/reader.js in the Worker tests. It returns the next canned reading from globalThis.__READS (a queue)
// and counts the calls in globalThis.__CALLS. A queue item { __error: "message" } makes that read fail;
// __delay: milliseconds makes it take that long.
export const SYSTEM_PROMPT = "(stand-in)";
export async function readWithClaude({ model, hint = "", timeoutMs }) {
  const queue = globalThis.__READS || [];
  globalThis.__CALLS = (globalThis.__CALLS || 0) + 1;
  globalThis.__HINTS = [...(globalThis.__HINTS || []), hint];
  globalThis.__TIMEOUTS = [...(globalThis.__TIMEOUTS || []), timeoutMs];   // how long each read was allowed
  if (!queue.length) throw new Error(`${model}: no canned reading left`);
  const next = queue.shift();
  if (next && next.__delay) await new Promise(done => setTimeout(done, next.__delay));
  if (next && next.__error) throw new Error(`${model}: ${next.__error}`);
  const { __delay, ...reading } = structuredClone(next);
  return { reading, provider: "anthropic", model, usage: { input: 1, output: 1, cached: 0 } };
}
export async function readWithGemini({ model }) { throw new Error(`${model}: not configured in the stand-in`); }
