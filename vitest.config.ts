import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["logic/**/*.test.ts"],
    environment: "node"
  }
});
