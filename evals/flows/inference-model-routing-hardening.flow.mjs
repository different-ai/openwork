import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Narration is loaded from the approved script (evals/voiceovers/inference-model-routing-hardening.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("inference-model-routing-hardening");
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

function provePassingTests(ctx, names) {
  const run = runTests();
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
  ctx.assert(run.status === 0, `Inference regression tests exit 0 (actual: ${run.status})`);
  for (const name of names) {
    ctx.assert(output.includes(`✔ ${name}`), `Passing test witnessed: ${name}`);
  }
  ctx.output("$ pnpm --filter @openwork-ee/inference test", output);
}

export default {
  id: "inference-model-routing-hardening",
  title: "Only approved model selections reach OpenRouter",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Approved chat requests still work",
      run: async (ctx) => {
        await ctx.prove("An enabled alias is rewritten and forwarded through chat completions", {
          voiceover: vo[0],
          // "An authenticated client sends `POST /api/v1/chat/completions` with an enable"
          assert: async () => {
            provePassingTests(ctx, ["rewrites approved model aliases before forwarding JSON requests"]);
          },
        });
      },
    },
    {
      name: "Top-level alternate selectors are blocked",
      run: async (ctx) => {
        await ctx.prove("Every supported top-level alternate model selector is rejected locally", {
          voiceover: vo[1],
          // "Requests containing `models`, `fallbacks`, `preset`, or `route` are rejected"
          assert: async () => {
            provePassingTests(ctx, [
              "rejects the top-level models selector when present",
              "rejects the top-level fallbacks selector when present",
              "rejects the top-level preset selector when present",
              "rejects the top-level route selector when present",
            ]);
          },
        });
      },
    },
    {
      name: "Nested selectors are blocked without breaking function tools",
      run: async (ctx) => {
        await ctx.prove("Model-selecting OpenRouter plugins and tools are blocked while ordinary tools remain valid", {
          voiceover: vo[2],
          // "OpenRouter tools/plugins that can select nested models—Fusion, advisor, suba"
          assert: async () => {
            provePassingTests(ctx, [
              "rejects the Fusion plugin",
              "rejects the openrouter:advisor server tool",
              "rejects the openrouter:subagent server tool",
              "rejects the openrouter:fusion server tool",
              "rejects the openrouter:image_generation server tool",
              "allows ordinary function tools with a model property in their JSON Schema",
            ]);
          },
        });
      },
    },
    {
      name: "The proxy exposes only its intended API",
      run: async (ctx) => {
        await ctx.prove("The local model catalog is returned without forwarding and unsupported routes stay local", {
          voiceover: vo[3],
          // "Only approved inference routes and methods are accepted; `GET /api/v1/models"
          assert: async () => {
            provePassingTests(ctx, [
              "returns the authenticated local model catalog without forwarding",
              "blocks unsupported POST /api/v1/responses locally",
              "authenticates before rejecting unsupported routes",
            ]);
          },
        });
      },
    },
    {
      name: "The complete regression contract passes",
      run: async (ctx) => {
        await ctx.prove("All focused inference routing regression tests pass", {
          voiceover: vo[4],
          // "Regression tests prove no alternate model selector or unsupported route reac"
          assert: async () => {
            const run = runTests();
            const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
            ctx.assert(run.status === 0, "Focused inference tests exit successfully");
            ctx.assert(output.includes("fail 0"), "No focused inference regression failed");
            ctx.output("Focused regression result", output.trim());
          },
        });
      },
    },
  ],
};
