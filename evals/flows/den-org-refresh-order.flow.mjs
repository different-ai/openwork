import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-org-refresh-order";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
let run;

function result() {
  run ??= spawnSync("bun", ["test", "apps/app/scripts/den-org-refresh-order.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
}

function proveTest(ctx, name) {
  const output = result();
  ctx.assert(run.status === 0, `Organization refresh tests failed:\n${output}`);
  ctx.assert(output.includes(name), `Missing regression: ${name}`);
}

export default {
  id: FLOW_ID,
  title: "The latest Den session owns organization refresh state",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "An organization request can outlive its session identity",
      run: async (ctx) => ctx.prove("Session identity changes invalidate in-flight organization refreshes", {
        voiceover: vo[0],
        assert: async () => proveTest(ctx, "a session identity change invalidates an in-flight refresh"),
      }),
    },
    {
      name: "A newer refresh becomes the sole state owner",
      run: async (ctx) => ctx.prove("Only the newest request generation remains current", {
        voiceover: vo[1],
        assert: async () => proveTest(ctx, "only the newest organization refresh remains current"),
      }),
    },
    {
      name: "The older success cannot overwrite organization state",
      run: async (ctx) => ctx.prove("Stale success mutations are rejected by the same request gate", {
        voiceover: vo[2],
        assert: async () => proveTest(ctx, "stale success, error, and completion mutations are all rejected"),
      }),
    },
    {
      name: "Stale errors and completion cannot cover current state",
      run: async (ctx) => ctx.prove("Error and busy completion mutations are latest-request-only", {
        voiceover: vo[3],
        assert: async () => {
          proveTest(ctx, "stale success, error, and completion mutations are all rejected");
          ctx.output("den-org-refresh-order-tests.txt", result());
        },
      }),
    },
  ],
};
