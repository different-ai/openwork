import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("inference-sentry-debug");
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
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  ctx.assert(run.status === 0, `Focused inference tests exit successfully (actual: ${run.status})`);
  for (const name of names) {
    ctx.assert(output.includes(`✔ ${name}`), `Passing test witnessed: ${name}`);
  }
  ctx.output(
    "$ pnpm --filter @openwork-ee/inference test",
    output.split("\n").filter((line) => names.some((name) => line.includes(name))).join("\n"),
  );
}

export default {
  id: "inference-sentry-debug",
  title: "Inference requests are diagnosable in Sentry without exposing credentials",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Model selection and resolution are correlated",
      run: async (ctx) => {
        await ctx.prove("Every authenticated completion report carries the incoming and resolved model", {
          voiceover: vo[0],
          assert: async () => {
            proveTests(ctx, [
              "rewrites approved model aliases before forwarding JSON requests",
              "returns model_not_found for unknown JSON model aliases",
            ]);
          },
        });
      },
    },
    {
      name: "Ordinary payloads are summarized",
      run: async (ctx) => {
        await ctx.prove("Ordinary organizations expose useful payload shape without prompt content", {
          voiceover: vo[1],
          assert: async () => {
            proveTests(ctx, ["summarizes ordinary organization payload shape without message content or secrets"]);
          },
        });
      },
    },
    {
      name: "The selected debug organization gets full payload context",
      run: async (ctx) => {
        await ctx.prove("The approved debug organization retains full prompt and tool-argument context", {
          voiceover: vo[2],
          assert: async () => {
            proveTests(ctx, ["logs full debug organization payload with recursive credential redaction"]);
          },
        });
      },
    },
    {
      name: "Credentials and client IPs remain redacted",
      run: async (ctx) => {
        await ctx.prove("Credential-like headers and payload fields are redacted while key IDs remain searchable", {
          voiceover: vo[3],
          assert: async () => {
            proveTests(ctx, ["redacts credential-like incoming headers without redacting non-secret IDs"]);
          },
        });
      },
    },
    {
      name: "Handled failures preserve request context",
      run: async (ctx) => {
        await ctx.prove("Upstream responses and exceptions remain tied to their inference request context", {
          voiceover: vo[4],
          assert: async () => {
            proveTests(ctx, [
              "reports handled upstream errors with searchable request context",
              "reports caught upstream fetch exceptions with the original Error object",
            ]);
          },
        });
      },
    },
  ],
};
