import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "cloud-mcp-base-url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, assertion + (actual ? ` (actual: ${actual})` : ""));
}

function run(ctx, label, args) {
  const result = spawnSync("pnpm", args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  ctx.output(label, output);
  witness(ctx, result.status === 0, `${label} exits successfully`, String(result.status));
  return output;
}

export default {
  id: FLOW_ID,
  title: "Cloud MCP tokens follow the desktop base URL",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Sign-in token minting prepares the cloud-agent resource",
      run: async (ctx) => {
        await ctx.prove("The first-party token route derives its resource from the signed-in request", {
          voiceover: vo[0],
          assert: async () => {
            const route = await readFile(join(ROOT, "ee/apps/den-api/src/routes/mcp/index.ts"), "utf8");
            witness(ctx, route.includes("deriveFirstPartyMcpTokenResourceFromRequest(c.req.raw"), "The signed-in token route derives resource from the incoming request");
            witness(ctx, route.includes("trustedOrigins: firstPartyMcpTokenTrustedOrigins"), "Only trusted deployment origins may select the resource URL");
            ctx.output("First-party token route", route.split("\n").slice(108, 128).join("\n"));
          },
        });
      },
    },
    {
      name: "Minted resource follows the web base URL proxy",
      run: async (ctx) => {
        await ctx.prove("A proxied token request returns <baseUrl>/api/den/mcp and rejects spoofed origins", {
          voiceover: vo[1],
          assert: async () => {
            const output = run(ctx, "$ den-api MCP resource tests", [
              "--filter", "@openwork-ee/den-api", "exec", "bun", "test",
              "test/mcp-resource.test.ts", "test/mcp-resource-url.test.ts",
            ]);
            witness(ctx, output.includes("21 pass"), "All resource derivation and external OAuth regression tests pass", output.split("\n").at(-1) ?? output);
          },
        });
      },
    },
    {
      name: "Refresh replaces a stale direct API endpoint",
      run: async (ctx) => {
        await ctx.prove("Desktop reconciliation turns the minted proxy resource into /api/den/mcp/agent", {
          voiceover: vo[2],
          assert: async () => {
            const output = run(ctx, "$ desktop cloud MCP reconciliation test", [
              "--filter", "@openwork/app", "exec", "bun", "test",
              "tests/cloud-mcp-health.test.ts",
              "--test-name-pattern", "uses the minted web proxy resource",
            ]);
            witness(ctx, output.includes("1 pass"), "The minted proxy resource replaces a stale api.* fallback", output.split("\n").at(-1) ?? output);
          },
        });
      },
    },
    {
      name: "The trusted proxy path remains connectable",
      run: async (ctx) => {
        await ctx.prove("The web proxy supplies trusted metadata and the cloud MCP accepts its /api/den/mcp/agent endpoint", {
          voiceover: vo[3],
          assert: async () => {
            const proxyOutput = run(ctx, "$ den-web trusted proxy test", [
              "--filter", "@openwork-ee/den-web", "exec", "bun", "test",
              "app/api/_lib/upstream-proxy.test.mjs",
              "--test-name-pattern", "overwrites spoofable forwarded headers",
            ]);
            witness(ctx, proxyOutput.includes("1 pass"), "The web proxy overwrites spoofable forwarding metadata", proxyOutput.split("\n").at(-1) ?? proxyOutput);

            const connectOutput = run(ctx, "$ cloud MCP proxy endpoint test", [
              "--filter", "openwork-server", "exec", "bun", "test",
              "src/cloud-mcp-reconcile.e2e.test.ts",
              "--test-name-pattern", "normalizes a harmless trailing slash",
            ]);
            witness(ctx, connectOutput.includes("1 pass"), "The cloud MCP connects through an /api/den/mcp/agent endpoint", connectOutput.split("\n").at(-1) ?? connectOutput);
          },
        });
      },
    },
  ],
};
