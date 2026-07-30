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

async function probeSemanticTools() {
  const { stdout } = await execFile("bun", ["-e", PROBE_SCRIPT], {
    cwd: ROOT,
    env: process.env,
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
  title: "Built-in OpenWork agent surface is semantic-only",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Only semantic OpenWork tools are registered",
      run: async (ctx) => {
        let result = null;
        await ctx.prove("The preview plugin exposes openwork_context/query/execute only", {
          voiceover: "The bundled OpenWork plugin no longer registers legacy session, extension, browser, or UI-control tool aliases. Agents use the three semantic tools and affordance ids from openwork_context.",
          action: async () => {
            result = await probeSemanticTools();
            ctx.output("semantic tool surface", pretty(result));
          },
          assert: async () => {
            witness(ctx, Array.isArray(result?.tools), "The probe printed a tools array", result ? pretty(result.tools) : "null");
            witness(ctx, result.tools.join(",") === "openwork_context,openwork_execute,openwork_query", "Only the three semantic tools are registered", result.tools.join(", "));
            witness(ctx, !result.tools.some((tool) => tool.startsWith("openwork_ui_")), "Legacy openwork_ui_* tools are gone", result.tools.join(", "));
            witness(ctx, !result.tools.some((tool) => tool.startsWith("openwork_session_")), "Legacy openwork_session_* tools are gone", result.tools.join(", "));
            witness(ctx, !result.system.includes("openwork_ui_"), "The system prompt lacks openwork_ui_ steering", result.system);
            witness(ctx, result.system.includes("openwork_context"), "The system prompt steers toward openwork_context", result.system);
            witness(ctx, result.system.includes("browser.open_url"), "The system prompt steers browser work through browser.open_url", result.system);
          },
        });
      },
    },
  ],
};
