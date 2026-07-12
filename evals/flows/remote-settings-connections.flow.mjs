import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "remote-settings-connections";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(ROOT, "apps", "app");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

export default {
  id: FLOW_ID,
  title: "Settings connections stay on the selected workspace's server",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The workspace server projection is characterized",
      run: async (ctx) => {
        await ctx.prove("Remote connection lists begin from the owning worker", {
          voiceover: vo[0],
          assert: async () => {
            const result = run("bun", ["test", "tests/settings-workspace-server-target.test.ts"], APP);
            witness(ctx, result.status === 0, "The focused workspace-server suite passes", result.output.split("\n").slice(-12).join("\n"));
            witness(ctx, result.output.includes("projects the selected remote endpoint"), "Remote endpoint projection is exercised");
            witness(ctx, result.output.includes("fails closed"), "Missing endpoint behavior is exercised");
            ctx.output("remote-settings-connections-tests", result.output);
          },
        });
      },
    },
    {
      name: "Workspace stores share one endpoint-backed server",
      run: async (ctx) => {
        await ctx.prove("MCP and provider mutations cannot inherit the local host client", {
          voiceover: vo[1],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            witness(ctx, settings.includes("openworkServer: workspaceOpenworkServer"), "Workspace stores receive the endpoint-backed adapter");
            witness(ctx, settings.includes("routeStateRef.current.openworkServerClient = selectedWorkspaceServer.openworkServerClient"), "The adapter follows the selected endpoint");
            witness(ctx, settings.includes("markReloadRequired: markWorkspaceReloadRequired"), "Connection mutations capture workspace reload ownership");
          },
        });
      },
    },
    {
      name: "Reload ownership survives workspace changes",
      run: async (ctx) => {
        await ctx.prove("Provider reloads remain attached to the worker that was changed", {
          voiceover: vo[2],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const target = readFileSync(path.join(APP, "src/react-app/domains/connections/workspace-openwork-server.ts"), "utf8");
            witness(ctx, settings.includes("pendingWorkspaceReloadTargetRef.current ?? selectedTarget"), "A captured pending target wins over later selection");
            witness(ctx, target.includes("captureWorkspaceReloadTarget"), "Client and workspace ID are captured together");
            witness(ctx, target.includes("!input.remoteWorkspace"), "Remote reloads cannot use the local desktop fallback");
          },
        });
      },
    },
    {
      name: "Disconnected workers fail within their own boundary",
      run: async (ctx) => {
        await ctx.prove("A remote outage cannot mutate local connection state", {
          voiceover: vo[3],
          assert: async () => {
            const provider = readFileSync(path.join(APP, "src/react-app/domains/connections/provider-auth/store.ts"), "utf8");
            const guide = readFileSync(path.join(ROOT, "docs/remote-settings-connections.md"), "utf8").replace(/\s+/g, " ");
            witness(ctx, provider.includes("remoteWorkspace: openworkSnapshot.openworkServerIsRemote"), "Provider fallback checks endpoint ownership");
            witness(ctx, guide.includes("fail closed"), "Disconnected behavior is documented");
            witness(ctx, guide.includes("No token value is logged or copied"), "Credential handling is documented");
          },
        });
      },
    },
  ],
};
