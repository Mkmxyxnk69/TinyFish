import { defineConfig, devices } from "@playwright/test";
const recordingDemo = process.env.RECORD_DEMO === "1";
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: recordingDemo ? "artifacts/demo-capture" : "test-results",
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: recordingDemo
      ? { mode: "on", size: { width: 1440, height: 1100 } }
      : "off",
    launchOptions: recordingDemo ? { slowMo: 120 } : {},
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(recordingDemo ? { viewport: { width: 1440, height: 1100 } } : {}),
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
