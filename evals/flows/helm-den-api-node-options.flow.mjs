import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "helm-den-api-node-options";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHART = join(ROOT, "packaging", "helm", "openwork-ee");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, assertion);
}

export default {
  id: FLOW_ID,
  title: "Helm passes configured Node.js options to Den API startup",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Render configured Den API Node.js options",
      run: async (ctx) => {
        let rendered = "";
        await ctx.prove("Configured Den API Node.js flags reach the Node process at startup", {
          voiceover: vo[0],
          action: async () => {
            const result = spawnSync(
              "helm",
              [
                "template",
                "openwork-ee",
                CHART,
                "--set-string",
                "config.denApiNodeOptions=--use-openssl-ca --max-old-space-size=4096",
              ],
              { encoding: "utf8" },
            );
            witness(ctx, result.status === 0, "helm template exits successfully", result.stderr.trim());
            rendered = result.stdout;
          },
          assert: async () => {
            witness(
              ctx,
              rendered.includes('DEN_API_NODE_OPTIONS: "--use-openssl-ca --max-old-space-size=4096"'),
              "The ConfigMap contains DEN_API_NODE_OPTIONS",
            );
            witness(
              ctx,
              (rendered.match(/name: NODE_OPTIONS/g) ?? []).length === 1,
              "Only Den API receives NODE_OPTIONS",
            );
            witness(
              ctx,
              rendered.includes("key: DEN_API_NODE_OPTIONS"),
              "NODE_OPTIONS reads DEN_API_NODE_OPTIONS from the ConfigMap",
            );
            ctx.output(
              "$ helm template openwork-ee ... --set-string config.denApiNodeOptions=...",
              rendered
                .split("\n")
                .filter((line) => line.includes("DEN_API_NODE_OPTIONS") || line.includes("NODE_OPTIONS"))
                .join("\n"),
            );
          },
        });
      },
    },
  ],
};
