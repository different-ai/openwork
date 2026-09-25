/**
 * Internal proof: execute the embedded-server lifecycle regression test in the
 * pinned Bun environment and bind its HTTP observations to Fraimz claims.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "embedded-runtime-config-listener-lifecycle";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCKER_BIN = "docker";
const BUN_IMAGE = "oven/bun:1.3.6";
const CLEANUP_LABEL = "com.ora.cleanup.scope=fraimz";
const CONTAINER_ROOT = "/workspace";
const SERVER_WORKDIR = `${CONTAINER_ROOT}/apps/server`;
const TEST_PATH = "src/embedded-runtime-config-lifecycle.test.ts";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PASS_MARKER = "1 pass";
const FAILURE_MARKER = "0 fail";
const PATCH_MARKER = "PATCH /runtime-config/providers 200";
const execFileAsync = promisify(execFile);
const vo = await loadVoiceoverParagraphs(FLOW_ID);
let testOutput = "";

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, actual ? `${assertion} (actual: ${actual})` : assertion);
}

async function runLifecycleTest() {
  const { stdout, stderr } = await execFileAsync(DOCKER_BIN, [
    "run", "--rm", "--label", CLEANUP_LABEL,
    "-v", `${ROOT}:${CONTAINER_ROOT}`,
    "-w", SERVER_WORKDIR,
    BUN_IMAGE,
    "bun", "test", TEST_PATH,
  ], { maxBuffer: MAX_OUTPUT_BYTES });
  return `${stdout}\n${stderr}`.trim();
}

export default {
  id: FLOW_ID,
  title: "Stopped embedded servers release runtime config listeners",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Stopping an embedded server releases its listener",
      run: async (ctx) => {
        await ctx.prove("A real embedded server is stopped before another starts against the shared runtime database", {
          voiceover: vo[0],
          assert: async () => {
            testOutput = await runLifecycleTest();
            witness(ctx, testOutput.includes(PASS_MARKER), "The lifecycle regression test passes", testOutput);
            witness(ctx, testOutput.includes(FAILURE_MARKER), "The lifecycle regression test has no failures", testOutput);
            ctx.output("pinned Bun lifecycle test", testOutput);
          },
        });
      },
    },
    {
      name: "An identical provider update skips reload",
      run: async (ctx) => {
        await ctx.prove("The active HTTP endpoint accepts both provider PATCH requests and the identical request skips reload", {
          voiceover: vo[1],
          assert: async () => {
            const patchCount = testOutput.split(PATCH_MARKER).length - 1;
            witness(ctx, patchCount === 2, "Both provider PATCH requests returned HTTP 200", String(patchCount));
            witness(ctx, testOutput.includes(PASS_MARKER), "The skipped-reload assertion passed", testOutput);
            ctx.output("provider PATCH observations", testOutput);
          },
        });
      },
    },
  ],
};
