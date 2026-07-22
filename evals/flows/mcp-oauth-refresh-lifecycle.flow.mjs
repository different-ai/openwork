import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-oauth-refresh-lifecycle";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

export default {
  id: FLOW_ID,
  title: "MCP OAuth refresh lifecycle remains observable under rapid expiry",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Exercise the real refresh lifecycle",
      run: async (ctx) => {
        await ctx.prove("The OAuth harness proves serial refresh, concurrent grace recovery, stale reuse revocation, and session revocation", {
          voiceover: vo[0],
          action: async () => {
            const result = spawnSync(
              "pnpm",
              [
                "--filter",
                "@openwork-ee/den-api",
                "exec",
                "bun",
                "test",
                "--conditions",
                "development",
                "test/mcp-oauth-refresh-lifecycle.test.ts",
              ],
              {
                cwd: ROOT,
                encoding: "utf8",
                timeout: 90_000,
              },
            );
            const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
            ctx.output("MCP OAuth refresh lifecycle", output);
            ctx.assert(result.status === 0, `Refresh lifecycle harness failed with status ${result.status}.`);
            ctx.assert(output.includes("1 pass"), "The lifecycle wrapper did not report a passing integration test.");
            ctx.assert(output.includes("0 fail"), "The lifecycle wrapper reported a failing integration test.");
          },
        });
      },
    },
  ],
};
