import { z } from "zod";
import {
  SANDBOX_TOOL_NAMES,
  sandboxToolDescriptions,
  sandboxToolSchemas,
  type SandboxToolCall,
  type SandboxToolName,
} from "../sandbox-tool-host.js";
import { providerSchemaProblems } from "./provider-safe-tool-schema.js";

const modeSchema = z.enum(["off", "tools", "only"]);
export type SandboxToolMode = z.infer<typeof modeSchema>;
const resultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string().max(32_000) })).max(8),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SandboxEngineResult = z.infer<typeof resultSchema>;
export type SandboxNativeTool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, call: SandboxToolCall): Promise<SandboxEngineResult>;
};
type Registration = { dispose(): Promise<void> };
export type SandboxPluginContext = {
  options: unknown;
  location?: { directory?: string };
  tool: {
    transform(callback: (editor: { list(): readonly { id: string }[]; remove(id: string): void; add(tool: SandboxNativeTool): void }) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  session: { hook(name: "prompt", callback: () => Promise<void>): Promise<Registration> };
};
export type SandboxPluginDependencies = {
  status(): Promise<SandboxToolMode>;
  execute(name: SandboxToolName, input: unknown, call: SandboxToolCall): Promise<SandboxEngineResult>;
};

/**
 * Package-level integration seam. `only` replaces the six primitive IDs, not a
 * complete security policy: other catalog entries/late transforms and external
 * host APIs need the separate host-tool/MCP enforcement layer before exposure.
 */
export async function setupSandboxTools(context: SandboxPluginContext, dependencies: SandboxPluginDependencies) {
  const offeredMode = async (previous: SandboxToolMode): Promise<SandboxToolMode> => {
    try { return modeSchema.parse(await dependencies.status()); }
    catch { return previous === "only" ? "only" : "off"; }
  };
  let mode = await offeredMode("off");
  let closed = false;
  const definitions = SANDBOX_TOOL_NAMES.map(name => ({ name, input: z.toJSONSchema(sandboxToolSchemas[name]) }));
  // A replacement schema must never silently disappear and leave a host tool
  // behind. Validate all schemas before making a single catalog modification.
  for (const definition of definitions) {
    const problems = providerSchemaProblems(definition.input);
    if (problems.length) throw new Error(`Unsafe sandbox tool schema for ${definition.name}: ${problems.join(", ")}`);
  }
  const registration = await context.tool.transform(editor => {
    const catalogMode = mode;
    if (catalogMode === "off") return;
    if (catalogMode === "only") {
      for (const tool of editor.list()) if (SANDBOX_TOOL_NAMES.some(name => tool.id === name)) editor.remove(tool.id);
    }
    for (const definition of definitions) {
      const name = definition.name;
      editor.add({
        name: catalogMode === "only" ? name : `sandbox_${name}`,
        description: sandboxToolDescriptions[name],
        input: definition.input,
        options: { codemode: true },
        async execute(input, call) {
          call.signal.throwIfAborted();
          if (closed) throw new Error("Sandbox tools are closed.");
          // Never trust a stale inference snapshot after a workspace mode change.
          const current = modeSchema.parse(await dependencies.status());
          call.signal.throwIfAborted();
          if (current === "off" || current !== catalogMode) throw new Error("Sandbox tool mode changed; refresh the tool catalog before retrying.");
          const parsed = sandboxToolSchemas[name].parse(input);
          return resultSchema.parse(await dependencies.execute(name, parsed, call));
        },
      });
    }
  });
  let prompt: Registration;
  try {
    prompt = await context.session.hook("prompt", async () => {
      const next = await offeredMode(mode);
      if (closed || next === mode) return;
      const previous = mode;
      mode = next;
      try { await context.tool.reload(); } catch (error) {
        mode = previous;
        throw error;
      }
    });
  } catch (error) {
    await registration.dispose();
    throw error;
  }
  return async () => {
    closed = true;
    try { await prompt.dispose(); } finally { await registration.dispose(); }
  };
}

/** Trusted options come from the server; no environment flags or model-supplied endpoint. */
export default {
  id: "openwork.sandbox",
  async setup(context: SandboxPluginContext) {
    const options = z.object({ url: z.string().url(), token: z.string().min(1) }).strict().parse(context.options);
    const url = new URL(options.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash) throw new Error("Sandbox bridge requires a local HTTP endpoint.");
    const directory = context.location?.directory;
    if (!directory) throw new Error("Sandbox bridge requires the engine's trusted workspace directory.");
    const request = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: signal ?? AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, directory }),
      });
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
        const reason = failure.success ? ` ${failure.data.error.slice(0, 500)}` : "";
        throw new Error(`Sandbox bridge request failed (${response.status}); host fallback is disabled.${reason}`);
      }
      return response.json();
    };
    return setupSandboxTools(context, {
      async status() { return z.object({ mode: modeSchema }).strict().parse(await request({ operation: "status" })).mode; },
      async execute(name, input, call) {
        return resultSchema.parse(await request({ operation: "execute", name, input, sessionId: call.sessionID, ...(call.id ? { callId: call.id } : {}) }, call.signal));
      },
    });
  },
};
