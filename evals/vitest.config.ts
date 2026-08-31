import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { shouldPrepareSuite, suiteWorkerCount } from "./runner/stack-suite.ts";

const common = {
  environment: "node",
  testTimeout: 120_000,
};
const appSource = fileURLToPath(new URL("../apps/app/src/", import.meta.url));
const appResolve = {
  alias: [{ find: /^@\//, replacement: appSource }],
};

const prepareSuite = shouldPrepareSuite(process.argv);
const attachedDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const managedStack = prepareSuite && !attachedDen;
const e2eWorkers = managedStack ? suiteWorkerCount(process.argv, process.env) : 1;
const namedLiveSpec = process.argv.some((argument) => argument.endsWith(".live.test.ts"));

export default defineConfig({
  test: {
    ...common,
    fileParallelism: managedStack,
    maxWorkers: e2eWorkers,
    projects: [
      {
        test: {
          ...common,
          name: "pr",
          // Live specs are attached-system incident signals: exclude them unless explicitly named.
          include: ["specs/**/*.test.ts"],
          exclude: ["**/*.e2e.test.ts", ...(namedLiveSpec ? [] : ["**/*.live.test.ts"])],
        },
      },
      {
        resolve: appResolve,
        test: {
          ...common,
          name: "e2e",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          globalSetup: ["./runner/prepare-stack.ts"],
          setupFiles: ["./runner/stack-env.ts"],
          include: ["specs/**/*.e2e.test.ts"],
        },
      },
    ],
  },
});
