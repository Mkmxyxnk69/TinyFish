import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    fileParallelism: false,
    env: { DATA_DIR: "./data/unit-tests", APP_MODE: "demo" },
    testTimeout: 30000,
  },
});
