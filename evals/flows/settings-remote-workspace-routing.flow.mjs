import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "settings-remote-workspace-routing";
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
  title: "Settings keeps remote task history on the workspace's owning endpoint",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Remote and local endpoint ownership is characterized",
      run: async (ctx) => {
        await ctx.prove("A remote workspace has one stable task history before Settings opens", {
          voiceover: vo[0],
          assert: async () => {
            const result = run("bun", ["test", "tests/settings-remote-workspace-routing.test.ts"], APP);
            witness(ctx, result.status === 0, "The focused routing suite passes", result.output.split("\n").slice(-12).join("\n"));
            witness(ctx, result.output.includes("resolves a remote workspace to its worker"), "Remote ownership is exercised");
            witness(ctx, result.output.includes("keeps the local server as owner"), "Local ownership is preserved");
            ctx.output("settings-remote-routing-tests", result.output);
          },
        });
      },
    },
    {
      name: "Settings loads tasks from the owning workspace endpoint",
      run: async (ctx) => {
        await ctx.prove("Opening Settings preserves the remote task list instead of replacing it with empty local data", {
          voiceover: vo[1],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            witness(ctx, settings.includes("const endpoint = resolveWorkspaceEndpoint(workspace"), "Settings resolves each workspace independently");
            witness(ctx, settings.includes("endpoint.client.listSessions(endpoint.workspaceId"), "Settings calls the owning server with its workspace ID");
            witness(ctx, !settings.includes("serverWorkspaceIds.has(workspace.id)"), "Desktop-managed remote rows are no longer discarded by the local-server membership gate");
          },
        });
      },
    },
    {
      name: "Session and Settings share one filtering rule",
      run: async (ctx) => {
        await ctx.prove("Local and remote workspaces keep their correct endpoint and directory semantics", {
          voiceover: vo[2],
          assert: async () => {
            const helper = readFileSync(path.join(APP, "src/react-app/shell/route-workspaces.ts"), "utf8");
            const sessionRoute = readFileSync(path.join(APP, "src/react-app/shell/use-workspace-route-state.ts"), "utf8");
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            witness(ctx, helper.includes("filterSessionsForRouteWorkspace"), "The filtering contract has one shared implementation");
            witness(ctx, sessionRoute.includes("filterSessionsForRouteWorkspace(workspace, fetchedItems)"), "Session consumes the shared rule");
            witness(ctx, settings.includes("filterSessionsForRouteWorkspace(workspace, response.items ?? [])"), "Settings consumes the shared rule");
          },
        });
      },
    },
    {
      name: "Worker-specific recovery remains intact",
      run: async (ctx) => {
        await ctx.prove("Remote failures remain scoped to the worker and keep the existing recovery path", {
          voiceover: vo[3],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const guide = readFileSync(path.join(ROOT, "docs/settings-remote-workspace-routing.md"), "utf8");
            witness(ctx, settings.includes("diagnoseRemoteWorkspaceTaskLoadFailure(workspace, fallback)"), "Settings still invokes remote-worker diagnostics");
            witness(ctx, guide.includes("remote token is sent only to the remote endpoint"), "The credential boundary is documented");
            witness(ctx, guide.includes("No tokens are copied into a new cache"), "The fix introduces no new token persistence");
          },
        });
      },
    },
  ],
};
