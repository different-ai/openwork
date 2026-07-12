import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-sync-coalesce";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
let run;

function output() {
  run ??= spawnSync("bun", ["test", "apps/app/scripts/cloud-provider-auto-sync.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
}

function assertTest(ctx, name) {
  const result = output();
  ctx.assert(run.status === 0, `Auto-sync tests failed:\n${result}`);
  ctx.assert(result.includes(name), `Missing regression: ${name}`);
}

export default {
  id: FLOW_ID,
  title: "Den settings changes coalesce during provider sync",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "A settings change can arrive during reconciliation",
      run: async (ctx) => ctx.prove("The regression holds the first request open while settings change", {
        voiceover: vo[0],
        assert: async () => assertTest(ctx, "coalesces settings changes into one follow-up without overlap"),
      }),
    },
    {
      name: "The newest settings state remains pending",
      run: async (ctx) => ctx.prove("The latest reason replaces earlier pending signals", {
        voiceover: vo[1],
        assert: async () => assertTest(ctx, "coalesces settings changes into one follow-up without overlap"),
      }),
    },
    {
      name: "Exactly one non-overlapping follow-up runs",
      run: async (ctx) => ctx.prove("Bursts coalesce and the maximum concurrent request count remains one", {
        voiceover: vo[2],
        assert: async () => assertTest(ctx, "coalesces settings changes into one follow-up without overlap"),
      }),
    },
    {
      name: "Cancellation and failure release pending state safely",
      run: async (ctx) => ctx.prove("Unmount cancels pending work while failures still permit the latest reconciliation", {
        voiceover: vo[3],
        assert: async () => {
          assertTest(ctx, "cancels a pending follow-up");
          assertTest(ctx, "runs the latest pending state after a failure");
          ctx.output("cloud-provider-auto-sync-tests.txt", output());
        },
      }),
    },
  ],
};
