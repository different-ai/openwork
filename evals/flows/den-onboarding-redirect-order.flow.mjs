import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-onboarding-redirect-order";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
let run;

function result() {
  run ??= spawnSync("bun", ["test", "apps/app/scripts/den-onboarding-redirect-order.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
}

function proveTest(ctx, name) {
  const output = result();
  ctx.assert(run.status === 0, `Redirect-order tests failed:\n${output}`);
  ctx.assert(output.includes(name), `Missing regression: ${name}`);
}

export default {
  id: FLOW_ID,
  title: "Only the current Den sign-in may redirect to onboarding",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Successful sign-in begins a bounded organization wait",
      run: async (ctx) => ctx.prove("The redirect waits for the asynchronously selected organization", {
        voiceover: vo[0],
        assert: async () => proveTest(ctx, "only the latest successful sign-in can navigate once"),
      }),
    },
    {
      name: "Later session events cancel older timers",
      run: async (ctx) => ctx.prove("Sign-out and unmount remove pending redirect work", {
        voiceover: vo[1],
        assert: async () => proveTest(ctx, "cancels pending navigation on sign-out or unmount"),
      }),
    },
    {
      name: "Only the latest matching token navigates once",
      run: async (ctx) => ctx.prove("An older sign-in token cannot redirect after a newer session becomes current", {
        voiceover: vo[2],
        assert: async () => {
          proveTest(ctx, "only the latest successful sign-in can navigate once");
          proveTest(ctx, "does not navigate for a different current token");
        },
      }),
    },
    {
      name: "The wait expires without late navigation",
      run: async (ctx) => ctx.prove("The existing five-second polling budget ends quietly", {
        voiceover: vo[3],
        assert: async () => {
          proveTest(ctx, "stops quietly when the bounded wait expires");
          ctx.output("den-onboarding-redirect-order-tests.txt", result());
        },
      }),
    },
  ],
};
