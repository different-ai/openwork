import { defineConfig } from "vitest/config";

const common = {
  environment: "node",
  testTimeout: 120_000,
};

export default defineConfig({
  test: {
    ...common,
    projects: [
      {
        test: {
          ...common,
          name: "pr",
          include: ["specs/**/*.test.ts"],
          exclude: ["**/*.slow.test.ts"],
        },
      },
      {
        test: {
          ...common,
          name: "nightly",
          include: ["specs/**/*.test.ts"],
        },
      },
    ],
  },
});
