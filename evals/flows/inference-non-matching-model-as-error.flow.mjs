import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("inference-non-matching-model-as-error");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let testRun;

function runTests() {
  testRun ??= spawnSync("pnpm", ["--filter", "@openwork-ee/inference", "test"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return testRun;
}

function proveTests(ctx, names) {
  const run = runTests();
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
  ctx.assert(run.status === 0, `Focused inference tests exit successfully (actual: ${run.status})`);
  for (const name of names) {
    ctx.assert(output.includes(`✔ ${name}`), `Passing test witnessed: ${name}`);
  }
  ctx.output("$ pnpm --filter @openwork-ee/inference test", output);
}

const unknownModelTest = "reports fatal Sentry diagnostics and skips deduction when OpenRouter usage reports an unknown model";
const knownModelTest = "deducts usage without Sentry diagnostics when OpenRouter usage reports a known model";

export default {
  id: "inference-non-matching-model-as-error",
  title: "OpenRouter usage webhooks fail loudly when reported models leave the supported catalog",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "OpenRouter usage reaches the webhook",
      run: async (ctx) => {
        await ctx.prove("A representative OpenRouter usage webhook payload is accepted by the inference service test harness", {
          voiceover: vo[0],
          assert: async () => {
            proveTests(ctx, [unknownModelTest, knownModelTest]);
          },
        });
      },
    },
    {
      name: "Reported models are catalog checked",
      run: async (ctx) => {
        await ctx.prove("The webhook uses the reported response model when deciding whether usage can be priced", {
          voiceover: vo[1],
          assert: async () => {
            proveTests(ctx, [unknownModelTest]);
          },
        });
      },
    },
    {
      name: "Unknown models report fatally without deduction",
      run: async (ctx) => {
        await ctx.prove("Unknown reported models skip bucket deduction and emit safe fatal diagnostics", {
          voiceover: vo[2],
          assert: async () => {
            proveTests(ctx, [unknownModelTest]);
          },
        });
      },
    },
    {
      name: "Known models still deduct normally",
      run: async (ctx) => {
        await ctx.prove("Known reported models continue through ledger insertion and bucket charging without Sentry diagnostics", {
          voiceover: vo[3],
          assert: async () => {
            proveTests(ctx, [knownModelTest]);
          },
        });
      },
    },
  ],
};
