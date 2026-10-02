import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { parallelSuite, suiteWorkerCount } from "./runner/stack-suite.ts";

// `const` keeps every tag name a literal, so the TestTags augmentation below turns a typo into a type error.
function defineTags<const T extends { name: string; description: string }[]>(tags: T): T {
  return tags;
}

const common = {
  environment: "node",
  testTimeout: 120_000,
  // Tags are explicit opt-ins that CI reads; strictTags rejects unknown ones. These descriptions are the
  // documentation (`pnpm --dir evals exec vitest --list-tags`). scripts/journey-catalog.mjs still plans CI;
  // journey-ci.test.mjs keeps every spec's journey tags in agreement with its catalog definition.
  tags: defineTags([
    { name: "checkpoints", description: "Save the world's end state (and marked steps) as reopenable checkpoints when run with --checkpoints on a world that can capture." },
    { name: "user-flow", description: "A person goes through the real UI; every step is a click or typed input that ends with a screenshot of what they see." },
    { name: "agent-flow", description: "The actor is an agent, an MCP client or a server; the proof is the requests and responses." },
    { name: "critical", description: "Journey (@module-tag): a critical user journey; required on every PR and every dev merge, whatever the change touched." },
    { name: "local-only", description: "Journey (@module-tag): needs the local lane (loopback fixtures, the testkit database, fault proxies or host binaries); never scheduled on Daytona." },
    { name: "live-model", description: "Journey (@module-tag): calls real paid models instead of the mock provider." },
    { name: "live-openai", description: "Journey (@module-tag): streams from the real OpenAI API; needs OPENAI_API_KEY and OPENWORK_EVAL_LIVE_OPENAI=1, so lanes without them skip it." },
    { name: "packaged", description: "Journey (@module-tag): boots a packaged desktop build; needs OPENWORK_EVAL_ELECTRON_BINARY, so lanes without one skip it." },
    { name: "raw-desktop", description: "Journey (@module-tag): drives a raw desktop host (`desktop` from @openwork/hosts) that no CI lane provides; run it by hand, it is never scheduled." },
    { name: "macos", description: "Journey (@module-tag): needs a macOS host (native AppKit or Computer Use); other lanes skip it." },
    { name: "engine-v1", description: "Registered case: a test titled with its case ID (e.g. HOME-01) that runs on engine v1; run it with `pnpm evals:e2e <spec> --case <ID> --engine v1`." },
    { name: "engine-v2", description: "Registered case: a test titled with its case ID (e.g. HOME-01) that runs on engine v2; run it with `pnpm evals:e2e <spec> --case <ID> --engine v2`." },
  ]),
};

declare module "vitest" {
  interface TestTags {
    tags: (typeof common.tags)[number]["name"];
  }
}
const appSource = fileURLToPath(new URL("../apps/app/src/", import.meta.url));
const appResolve = {
  alias: [{ find: /^@\//, replacement: appSource }],
};

const attachedDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const managedStack = parallelSuite(process.argv) && !attachedDen;
const e2eWorkers = managedStack ? suiteWorkerCount(process.argv, process.env) : 1;
const namedLiveSpec = process.argv.some((argument) => argument.endsWith(".live.test.ts") || argument.endsWith("/live.test.ts"));

export default defineConfig({
  test: {
    ...common,
    projects: [
      {
        resolve: appResolve,
        test: {
          ...common,
          name: "pr",
          // Live specs are attached-system incident signals: exclude them unless explicitly named.
          include: ["specs/**/*.test.ts", "../scenarios/**/*.test.ts"],
          exclude: ["**/*.e2e.test.ts", "**/e2e.test.ts", ...(namedLiveSpec ? [] : ["**/*.live.test.ts", "**/live.test.ts"])],
        },
      },
      {
        resolve: appResolve,
        test: {
          ...common,
          name: "e2e",
          fileParallelism: managedStack,
          maxWorkers: e2eWorkers,
          testTimeout: 600_000,
          hookTimeout: 600_000,
          globalSetup: ["./runner/prepare-stack.ts"],
          include: ["specs/**/*.e2e.test.ts", "../scenarios/**/e2e.test.ts"],
        },
      },
    ],
  },
});
