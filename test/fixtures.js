// The app is ES modules, so its top-level names are module-scoped and a
// page.evaluate() cannot see them. The suite reaches the code through those
// names -- 43 of them, across 610 call sites, many inside eval()'d helper
// strings that cannot use an import binding.
//
// So the test harness, and only the test harness, pulls the module namespace
// onto globalThis after each navigation. The app ships as plain modules and is
// not shaped by this; nothing in js/ knows it happens.
//
// Live getters rather than Object.assign: a module namespace has live bindings,
// so `busy` and `cancelling` still read true while a render is running. Copying
// them once would freeze them at their initial values and quietly break every
// test that waits on one.

const base = require("@playwright/test");

const EXPOSE = () => import("/js/main.js").then((ns) => {
  const refused = [];
  for (const k of Object.keys(ns)) {
    // Defined even when the name is already taken. `undo`, `redo` and `render`
    // are <button id="..."> elements, which HTML puts on window by name -- and
    // a top-level function declaration used to shadow them, which is the
    // behaviour being reproduced. A few window properties cannot be redefined;
    // those are reported rather than swallowed.
    try {
      Object.defineProperty(globalThis, k, {
        get: () => ns[k], configurable: true, enumerable: true,
      });
    } catch { refused.push(k); }
  }
  if (refused.length) throw new Error("could not expose: " + refused.join(", "));
});

const test = base.test.extend({
  page: async ({ page }, use) => {
    for (const method of ["goto", "reload"]) {
      const real = page[method].bind(page);
      page[method] = async (...args) => {
        const r = await real(...args);
        await page.evaluate(EXPOSE);
        return r;
      };
    }
    await use(page);
  },
});

module.exports = { test, expect: base.expect };
