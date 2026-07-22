import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-write-scope";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEN_API = join(ROOT, "ee", "apps", "den-api");

// Narration is loaded from the approved script (evals/voiceovers/mcp-write-scope.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function runTest(file) {
  return spawnSync("bun", ["--conditions=development", "test", file], {
    cwd: DEN_API,
    encoding: "utf8",
    env: process.env,
  });
}

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

export default {
  id: FLOW_ID,
  title: "OpenWork Cloud MCP authorizes organization writes without weakening explicit scope consent",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "OpenWork Cloud MCP receives requested write access",
      run: async (ctx) => {
        let result;
        await ctx.prove("New MCP connections include write access and legacy connections can explicitly opt in", {
          voiceover: vo[0],
          action: async () => {
            result = runTest("test/mcp-scopes.test.ts");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The MCP scope policy tests pass", output);
            witness(ctx, output.includes("MCP OAuth client defaults include read and write access"), "New MCP OAuth clients receive mcp:write by default");
            witness(ctx, output.includes("a legacy MCP client can opt in to requested write access"), "A legacy MCP client accepts an explicitly requested mcp:write scope");
            witness(ctx, output.includes("a legacy MCP client is not implicitly upgraded to write access"), "A legacy MCP client stays read-only when authorization does not request mcp:write");
            ctx.output("$ bun --conditions=development test test/mcp-scopes.test.ts", output);
          },
        });
      },
    },
    {
      name: "An organization setting update succeeds through MCP",
      run: async (ctx) => {
        let result;
        await ctx.prove("A write-scoped MCP principal updates an organization setting without insufficient_mcp_scope", {
          voiceover: vo[1],
          action: async () => {
            result = runTest("test/mcp-invoke-body.test.ts");
          },
          assert: async () => {
            const output = commandOutput(result);
            witness(ctx, result.status === 0, "The MCP invocation tests pass", output);
            witness(ctx, output.includes("an MCP principal with write access can update an organization setting"), "The organization PATCH reaches the route and returns the updated setting");
            witness(ctx, !output.includes("0 pass"), "The targeted test suite executed assertions");
            ctx.output("$ bun --conditions=development test test/mcp-invoke-body.test.ts", output);
          },
        });
      },
    },
  ],
};
