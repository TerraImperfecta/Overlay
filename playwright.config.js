// The tool is a browser application, so the tests drive a real browser rather
// than a DOM emulation: ImageDecoder and WebCodecs have no shim worth trusting,
// and they are exactly what needs testing.
//
// Chromium only, for now. PLAN.md section 5 item 3 wants Firefox and Safari
// checked too, but that is about capability *degradation* -- a different shape
// of test than these, which assert exact decoder output. See issue #19.

const { defineConfig, devices } = require("@playwright/test");

// Deliberately obscure: 8080 and 3000 are somebody else's by default.
const PORT = Number(process.env.PORT || 8931);

module.exports = defineConfig({
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node test/serve.js ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    // Never reuse: a stranger already listening on this port silently becomes
    // the system under test. That happened -- the suite cheerfully asserted
    // against a local nginx welcome page. A port clash should be a loud
    // failure, not a quiet substitution.
    reuseExistingServer: false,
    stdout: "ignore",
  },
});
