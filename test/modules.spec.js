// Structural invariants of the module graph (#78, #85).
//
// These read js/ as text rather than running it, because each rule below is
// invisible until one particular path executes, and two of them have already
// shipped broken:
//
//   * assigning an imported binding is a TypeError, but only on the line that
//     does it. #78 moved six render flags behind named transitions for this
//     reason; splitting section 11 immediately reintroduced it with
//     queuedReplan, and the only symptom was two unrelated tests failing.
//   * a cycle resolves fine when everything in it is a hoisted function and
//     throws when it is not. #78 had two, both of them a lower layer reaching
//     up into the UI wiring.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "js");
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith(".js")).sort();

// Two different strippings, and conflating them is a trap I fell into writing
// this: blanking string literals also blanks the "./x.js" in every import, so
// the graph comes out empty and the first two tests below pass by having
// nothing to check. Import specifiers need the strings; assignment detection
// needs them gone, or a name inside a message counts as a write.
const noComments = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const codeOnly = (t) =>
  noComments(t)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' "" ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, " '' ");

const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const SPECS = Object.fromEntries(FILES.map((f) => [f, noComments(read(f))]));
const SOURCE = Object.fromEntries(FILES.map((f) => [f, codeOnly(read(f))]));

const importsOf = (src) => {
  const out = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)"/g;
  let m;
  while ((m = re.exec(src)))
    out.push({ from: m[2], names: m[1].split(",").map((s) => s.trim()).filter(Boolean) });
  return out;
};

test("no module assigns a binding it imported", () => {
  const offences = [];
  for (const f of FILES) {
    const src = SOURCE[f];
    const imported = new Set(importsOf(SPECS[f]).flatMap((i) => i.names));
    // Anything the file declares itself shadows the import and is not the same
    // binding -- a local `const last` is not the exported `last`.
    const local = new Set([...src.matchAll(/(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
      .map((m) => m[1]));
    for (const name of imported) {
      if (local.has(name)) continue;
      const re = new RegExp(`(?<![.\\w$])${name}\\s*(?:=(?!=)|\\+\\+|--|\\+=|-=)`);
      const line = src.split("\n").findIndex((l) => re.test(l));
      if (line >= 0) offences.push(`${f}:${line + 1} assigns imported '${name}'`);
    }
  }
  // The fix is never to export a setter for the sake of it: move the binding to
  // the module that changes it, or give the change a name of its own.
  expect(offences).toEqual([]);
});

test("the import graph has no cycles", () => {
  const edges = Object.fromEntries(
    FILES.map((f) => [f, importsOf(SPECS[f]).map((i) => i.from)]));
  const colour = {}, trail = [];
  let found = null;
  const walk = (n) => {
    if (found) return;
    colour[n] = 1; trail.push(n);
    for (const m of edges[n] || []) {
      if (colour[m] === 1) { found = [...trail.slice(trail.indexOf(m)), m].join(" -> "); return; }
      if (!colour[m]) walk(m);
    }
    trail.pop(); colour[n] = 2;
  };
  for (const f of FILES) if (!colour[f]) walk(f);
  expect(found, `cycle: ${found}`).toBeNull();
});

test("every module is reachable from the entry", () => {
  const edges = Object.fromEntries(
    FILES.map((f) => [f, importsOf(SPECS[f]).map((i) => i.from)]));
  // main.js reaches the rest through `export * from`, not `import`.
  const reexports = [...SPECS["main.js"].matchAll(/export\s*\*\s*from\s*"\.\/([^"]+)"/g)]
    .map((m) => m[1]);
  const seen = new Set(["main.js"]);
  const stack = [...reexports];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(edges[n] || []));
  }
  // A file nobody imports and the entry does not re-export is dead weight that
  // still ships, and no test would notice it had stopped being loaded.
  expect(FILES.filter((f) => !seen.has(f))).toEqual([]);
});
