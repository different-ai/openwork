import { defineConfig } from "vitest/config";

const common = {
  environment: "node",
  testTimeout: 120_000,
};

export default defineConfig({
  test: {
    ...common,
    fileParallelism: false,
    projects: [
      {
        test: {
          ...common,
          name: "pr",
          // Naming convention: *.slow.test.ts drives Electron/Den (the stack lane, run on demand); every other spec must be app-less.
          include: ["specs/**/*.test.ts"],
          exclude: ["**/*.slow.test.ts"],
        },
      },
      {
        test: {
          ...common,
          name: "stack",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          include: ["specs/**/*.test.ts"],
        },
      },
    ],
  },
});
