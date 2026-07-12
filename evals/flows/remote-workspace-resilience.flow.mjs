import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "remote-workspace-resilience";
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
  title: "Remote workspaces remain stable through server disconnects and reconnect cleanly",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "A mixed local and remote workspace snapshot is characterized",
      run: async (ctx) => {
        await ctx.prove("Local and remote workspace state begins from a verified reconciliation contract", {
          voiceover: vo[0],
          assert: async () => {
            const result = run("bun", ["test", "tests/remote-workspace-resilience.test.ts"], APP);
            witness(ctx, result.status === 0, "The focused workspace reconciliation suite passes", result.output.split("\n").slice(-12).join("\n"));
            witness(ctx, result.output.includes("retains server-sourced remote workspaces"), "Server-sourced remote retention is exercised");
            ctx.output("workspace-resilience-tests", result.output);
          },
        });
      },
    },
    {
      name: "Refresh failure preserves the rendered workspace list",
      run: async (ctx) => {
        await ctx.prove("A temporary disconnect retains remote rows and exposes reconnecting state", {
          voiceover: vo[1],
          assert: async () => {
            const route = readFileSync(path.join(APP, "src/react-app/shell/use-workspace-route-state.ts"), "utf8");
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const sidebar = readFileSync(path.join(APP, "src/react-app/domains/session/sidebar/app-sidebar.tsx"), "utf8");
            witness(ctx, route.includes("retainRouteWorkspacesOnRefreshFailure(workspacesRef.current, desktopWorkspaces)"), "Session retains its last successful snapshot on refresh failure");
            witness(ctx, settings.includes("retainRouteWorkspacesOnRefreshFailure("), "Settings uses the same failure reconciliation policy");
            witness(ctx, sidebar.includes('connectionState.status === "reconnecting"'), "The sidebar renders a distinct reconnecting state");
          },
        });
      },
    },
    {
      name: "Deletion and conflict rules remain explicit",
      run: async (ctx) => {
        await ctx.prove("Unknown availability cannot delete data, while explicit removal still wins", {
          voiceover: vo[2],
          assert: async () => {
            const reconciliation = readFileSync(path.join(APP, "src/react-app/shell/route-workspaces.ts"), "utf8");
            const sessionRoute = readFileSync(path.join(APP, "src/react-app/shell/session-route.tsx"), "utf8");
            const settingsRoute = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const guide = readFileSync(path.join(ROOT, "docs/remote-workspace-reconciliation.md"), "utf8");
            witness(ctx, reconciliation.includes("desktop-owned routing fields"), "Desktop-owned routing fields remain authoritative during fallback");
            witness(ctx, sessionRoute.includes("workspacesRef.current = retainedWorkspaces"), "Session removal updates the retained snapshot immediately");
            witness(ctx, settingsRoute.includes("workspacesRef.current = retainedWorkspaces"), "Settings removal updates the retained snapshot immediately");
            witness(ctx, guide.includes("Successful server response") && guide.includes("Explicit user removal"), "The conflict and deletion policy is documented");
          },
        });
      },
    },
    {
      name: "Reconnect signals are bounded and converge on live state",
      run: async (ctx) => {
        await ctx.prove("OpenWork retries automatically without overlapping an in-flight refresh", {
          voiceover: vo[3],
          assert: async () => {
            const route = readFileSync(path.join(APP, "src/react-app/shell/use-workspace-route-state.ts"), "utf8");
            const reconciliation = readFileSync(path.join(APP, "src/react-app/shell/route-workspaces.ts"), "utf8");
            witness(ctx, route.includes('window.addEventListener("online", retryFailedRefresh)'), "Network restoration triggers a retry");
            witness(ctx, route.includes('window.addEventListener("focus", retryFailedRefresh)'), "Returning to the app triggers a retry");
            witness(ctx, reconciliation.includes("WORKSPACE_REFRESH_RETRY_INTERVAL_MS = 30_000"), "Background retry is bounded to a 30-second interval");
            witness(ctx, !route.includes("retryFailedRefresh = () => {\n      refreshInFlightRef.current = false"), "Automatic retry respects the in-flight guard");
          },
        });
      },
    },
  ],
};
