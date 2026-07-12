import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "remote-auto-compaction";
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
  title: "Auto-compaction follows the selected workspace's owning endpoint",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The preference contract is characterized",
      run: async (ctx) => {
        await ctx.prove("A remote workspace starts from its authoritative saved value", {
          voiceover: vo[0],
          assert: async () => {
            const result = run("bun", ["test", "tests/remote-auto-compaction.test.ts"], APP);
            witness(ctx, result.status === 0, "The focused auto-compaction suite passes", result.output.split("\n").slice(-12).join("\n"));
            witness(ctx, result.output.includes("defaults to enabled only after an authoritative config is loaded"), "The default parsing contract is exercised");
            witness(ctx, result.output.includes("loads from the selected endpoint"), "Endpoint-owned loading is exercised");
            ctx.output("remote-auto-compaction-tests", result.output);
          },
        });
      },
    },
    {
      name: "Reads and writes stay on one endpoint target",
      run: async (ctx) => {
        await ctx.prove("The selected endpoint owns both sides of the preference update", {
          voiceover: vo[1],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const helper = readFileSync(path.join(APP, "src/react-app/domains/settings/auto-compact-context.ts"), "utf8");
            witness(ctx, settings.includes("loadAutoCompactContext(endpoint)"), "Settings loads through the resolved endpoint");
            witness(ctx, settings.includes("saveAutoCompactContext(endpoint, next)"), "Settings saves through that same endpoint");
            witness(ctx, helper.includes("target.client.patchConfig(target.workspaceId"), "The client and server-side workspace ID remain paired");
          },
        });
      },
    },
    {
      name: "Workspace changes cannot expose stale state",
      run: async (ctx) => {
        await ctx.prove("Only the current endpoint can enable or update the switch", {
          voiceover: vo[2],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const preferences = readFileSync(path.join(APP, "src/react-app/domains/settings/pages/preferences-view.tsx"), "utf8");
            witness(ctx, settings.includes("autoCompactContextLoadedEndpoint === selectedWorkspaceEndpoint"), "Loaded state is tied to exact endpoint identity");
            witness(ctx, settings.includes("if (cancelled) return"), "Late responses are ignored after selection changes");
            witness(ctx, settings.includes("autoCompactContextEndpointRef.current === endpoint"), "A late failed save cannot revert another workspace's value");
            witness(ctx, preferences.includes("!props.autoCompactContextLoaded"), "The switch stays disabled until the current endpoint is loaded");
          },
        });
      },
    },
    {
      name: "Failure stays scoped to the owning server",
      run: async (ctx) => {
        await ctx.prove("An unavailable worker cannot produce an unverified write or local fallback", {
          voiceover: vo[3],
          assert: async () => {
            const settings = readFileSync(path.join(APP, "src/react-app/shell/settings-route.tsx"), "utf8");
            const guide = readFileSync(path.join(ROOT, "docs/remote-auto-compaction.md"), "utf8");
            const normalizedGuide = guide.replace(/\s+/g, " ");
            witness(ctx, settings.includes("!autoCompactContextLoaded || !endpoint"), "Writes require a loaded current endpoint");
            witness(ctx, normalizedGuide.includes("fall back to the local server"), "Fail-closed routing is documented");
            witness(ctx, normalizedGuide.includes("No credential is copied, persisted, logged, or sent to a fallback endpoint"), "The credential boundary is documented");
          },
        });
      },
    },
  ],
};
