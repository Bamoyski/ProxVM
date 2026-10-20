import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Web workspace tests cover pure logic only (no jsdom in this repo): the
 * status→tone mapping, provisioning payload parity with the legacy wizard,
 * API error/denial rendering, permission fallbacks, and formatters.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@proxvm/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
