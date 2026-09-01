import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: this is a CLI with no DOM surface.
    environment: "node",
    include: ["test/v2/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Pure entry/wiring with no branching worth asserting in isolation.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
    },
  },
});
