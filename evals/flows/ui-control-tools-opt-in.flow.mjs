import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROBE_SCRIPT = `
  const { OpenWorkExtensionsPreview } = await import("./apps/server/src/opencode-plugins/openwork-extensions-preview.ts");
  const plugin = await OpenWorkExtensionsPreview();
  const output = { system: [] };
  await plugin["experimental.chat.system.transform"](undefined, output);
  console.log(JSON.stringify({ tools: Object.keys(plugin.tool).sort(), system: output.system.join("\\n") }));
`;

function envWithUiControl(value) {
  const env = { ...process.env };
  if (value === null) delete env.OPENWORK_UI_CONTROL_TOOLS;
  else env.OPENWORK_UI_CONTROL_TOOLS = value;
  return env;
}

async function probeUiControlTools(value) {
  const { stdout } = await execFile("bun", ["-e", PROBE_SCRIPT], {
    cwd: ROOT,
    env: envWithUiControl(value),
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function witness(ctx, condition, assertion, actual) {
  const detail = actual === undefined ? undefined : String(actual);
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual: detail });
    ctx.assert(false, assertion + (detail ? ` (actual: ${detail})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual: detail });
}

export default {
  id: "ui-control-tools-opt-in",
  title: "Built-in OpenWork UI-control preview tools are opt-in",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "UI-control tools are absent by default",
      run: async (ctx) => {
        let result = null;
        await ctx.prove("The built-in UI-control preview tools do not clutter default sessions", {
          voiceover: "With the environment flag unset, the plugin still exposes extension discovery and cross-session memory, but the openwork UI-control preview tools are gone from the tool list and the system prompt.",
          action: async () => {
            result = await probeUiControlTools(null);
            ctx.output("OPENWORK_UI_CONTROL_TOOLS unset", pretty(result));
          },
          assert: async () => {
            witness(ctx, Array.isArray(result?.tools), "The probe printed a tools array", result ? pretty(result.tools) : "null");
            witness(ctx, !result.tools.includes("openwork_ui_snapshot"), "openwork_ui_snapshot is not registered by default", result.tools.join(", "));
            witness(ctx, !result.tools.includes("openwork_ui_list_actions"), "openwork_ui_list_actions is not registered by default", result.tools.join(", "));
            witness(ctx, !result.tools.includes("openwork_ui_execute_action"), "openwork_ui_execute_action is not registered by default", result.tools.join(", "));
            witness(ctx, result.tools.includes("openwork_session_search"), "openwork_session_search remains registered", result.tools.join(", "));
            witness(ctx, !result.system.includes("openwork_ui_"), "The default system prompt lacks openwork_ui_ steering", result.system);
          },
        });
      },
    },
    {
      name: "Setting OPENWORK_UI_CONTROL_TOOLS=1 restores the surface",
      run: async (ctx) => {
        let result = null;
        await ctx.prove("The preview UI-control surface returns when explicitly opted in", {
          voiceover: "When internal tooling sets OPENWORK_UI_CONTROL_TOOLS to one, the same plugin initialization registers all three openwork UI-control tools and restores the steering that tells agents how to use them.",
          action: async () => {
            result = await probeUiControlTools("1");
            ctx.output("OPENWORK_UI_CONTROL_TOOLS=1", pretty(result));
          },
          assert: async () => {
            witness(ctx, Array.isArray(result?.tools), "The opt-in probe printed a tools array", result ? pretty(result.tools) : "null");
            witness(ctx, result.tools.includes("openwork_ui_snapshot"), "openwork_ui_snapshot is registered when opted in", result.tools.join(", "));
            witness(ctx, result.tools.includes("openwork_ui_list_actions"), "openwork_ui_list_actions is registered when opted in", result.tools.join(", "));
            witness(ctx, result.tools.includes("openwork_ui_execute_action"), "openwork_ui_execute_action is registered when opted in", result.tools.join(", "));
            witness(ctx, result.system.includes("openwork_ui_execute_action"), "The opt-in system prompt includes UI-control steering", result.system);
          },
        });
      },
    },
  ],
};
