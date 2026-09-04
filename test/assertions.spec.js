// Two shapes of test that cannot fail, linted for (#87).
//
// Both have shipped here, more than once:
//
//   * `for (const r of recorders) expect(r.label).toContain("real time")`,
//     where `recorders` was empty on every engine. The loop body never ran, so
//     the test passed by asserting nothing (#59, and again in #84 in a second
//     file).
//   * `if (recorders.length) { ...expect... }` with no else, where the
//     condition was never true. Same outcome (#59, #84), and the same shape as
//     `if (r.ok) expect(...)` in malformed.spec.js.
//
// The fix for each is small and local: assert the collection is non-empty
// before looping over it, or give the `if` an `else` that asserts the other
// branch. degrade.spec.js's ImageDecoder test is the model -- both branches
// assert, so whichever way the capability goes, something real is checked.
//
// Literal collections are exempt: `for (const id of ["gif", "apng"])` cannot be
// empty by accident.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const SPECS = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith(".spec.js") && f !== "assertions.spec.js").sort();

const read = (f) =>
  fs.readFileSync(path.join(__dirname, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");

/** The lines of the braced block that starts on `open`, or the rest of that line. */
function blockAfter(lines, open) {
  if (!lines[open].trimEnd().endsWith("{")) return [lines[open]];
  let depth = 0, out = [];
  for (let i = open; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    out.push(lines[i]);
    if (depth <= 0 && i > open) break;
  }
  return out;
}

test("every assertion loop is over something proved non-empty", () => {
  const offences = [];
  for (const f of SPECS) {
    const lines = read(f).split("\n");
    lines.forEach((l, i) => {
      const m = l.match(/for \((?:const|let) \w+ of ([^)]+)\)/);
      if (!m) return;
      const coll = m[1].trim();
      if (coll.startsWith("[") || coll.startsWith("Object.")) return;   // literal
      const body = blockAfter(lines, i).join("\n");
      if (!/expect\(/.test(body)) return;
      // A length assertion anywhere in the six lines above counts.
      const before = lines.slice(Math.max(0, i - 6), i).join("\n");
      const base = coll.replace(/\W/g, "\\$&");
      const proved = new RegExp(`expect\\(\\(?${base}`).test(before) ||
                     new RegExp(`expect\\([^)]*${base}[^)]*\\.length`).test(before) ||
                     /toHaveLength|toBeGreaterThan|\.length\)?,?\s*["'`]/.test(before);
      if (!proved) offences.push(`${f}:${i + 1} loops over ${coll} and asserts inside it`);
    });
  }
  expect(offences).toEqual([]);
});

test("every conditional assertion has an else that also asserts", () => {
  const offences = [];
  for (const f of SPECS) {
    const lines = read(f).split("\n");
    lines.forEach((l, i) => {
      if (!/^\s*if \(/.test(l)) return;
      const body = blockAfter(lines, i);
      if (!/expect\(/.test(body.join("\n"))) return;
      // `} else {` is brace-neutral, so the block runs on through it to the
      // final close -- the else is *inside* the body, not after it.
      const hasElse = body.some((b) => /^\s*\}\s*else\b/.test(b)) ||
                      /\belse\b/.test(lines[i + body.length] || "");
      if (!hasElse)
        offences.push(`${f}:${i + 1} asserts only when the condition holds`);
    });
  }
  expect(offences).toEqual([]);
});
