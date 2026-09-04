// The tool is a browser application, so the tests drive a real browser rather
// than a DOM emulation: ImageDecoder and WebCodecs have no shim worth trusting,
// and they are exactly what needs testing.
//
// Only degrade.spec.js runs on all three engines. Everything else asserts exact
// decoder output and stays on Chromium, which is where ImageDecoder and
// WebCodecs are complete enough to be an oracle. Firefox and WebKit are asked a
// different and weaker question -- does the format list shrink honestly -- which
// is issue #19.
//
// Playwright's webkit is a WebKit build, not shipping Safari; they differ most
// on codecs Safari gets from system frameworks. Evidence about WebKit, a strong
// hint about Safari.

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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testMatch: /(degrade|gif-worker|settings)\.spec\.js/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: /(degrade|gif-worker|settings)\.spec\.js/ },
  ],
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
