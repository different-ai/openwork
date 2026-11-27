import { z } from "zod";
import {
  SANDBOX_TOOL_NAMES,
  sandboxToolDescriptions,
  sandboxToolSchemas,
  type SandboxToolCall,
  type SandboxToolName,
} from "../sandbox-tool-host.js";
import { providerSchemaProblems } from "./provider-safe-tool-schema.js";

import { computerBindingSchema, computerRouting, computerStatusSchema, type ComputerRouting } from "./computer-routing-v2.js";

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
export type SandboxInferenceEvent = {
  sessionID?: string;
  tools: Record<string, unknown>;
  system: { type?: "text"; text: string; metadata?: Record<string, unknown> }[];
};
const instructionMetadata = z.object({
  experimental: z.object({
    instructions: z.array(z.object({ key: z.string(), text: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();

function removeHostCatalog(event: SandboxInferenceEvent) {
  const worktreeGuidance = "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.";
  for (let index = event.system.length - 1; index >= 0; index--) {
    const part = event.system[index]!;
    if (part.text === worktreeGuidance && part.metadata === undefined) {
      event.system.splice(index, 1);
      continue;
    }
    const parsed = instructionMetadata.safeParse(part.metadata);
    if (!parsed.success) continue;
    const sources = parsed.data.experimental.instructions;
    for (const source of sources) {
      if (source.key !== "core/codemode" || !source.text) continue;
      const start = part.text.indexOf(source.text);
      if (start < 0) throw new Error("OpenWork couldn’t verify which tools were safe to offer. Restart OpenWork and send your message again.");
      part.text = part.text.slice(0, start) + part.text.slice(start + source.text.length);
    }
    part.metadata = { ...parsed.data, experimental: {
      ...parsed.data.experimental, instructions: sources.filter(source => source.key !== "core/codemode"),
    } };
  }
}
export type HostNativeTool = {
  output?: unknown;
  name: string; description: string; input: Record<string, unknown> | ((...args: never[]) => unknown); options?: { codemode?: boolean };
  execute(input: unknown, call: SandboxToolCall): Promise<unknown>;
};
type CatalogEntry = Partial<HostNativeTool> & { id: string };
export type SandboxPluginContext = {
  options: unknown;
  location?: { directory?: string };
  tool: {
    transform(callback: (editor: { list(): readonly CatalogEntry[]; remove(id: string): void; add(tool: HostNativeTool): void }) => void): Promise<Registration>;
    reload(): Promise<void>;
    hook?(name: "execute.before", callback: (event: { readonly tool: string }) => Promise<void>): Promise<Registration>;
  };
  mcp?: {
    transform(callback: (editor: { list(): Iterable<readonly [string, unknown]>; set(name: string, config: Record<string, unknown>): void }) => void): Promise<Registration>;
    reload?(): Promise<void>;
  };
  session: {
    get?(input: { sessionID: string }): Promise<{ parentID?: string; location?: { directory?: string } } | undefined>;
    hook: {
    (name: "prompt", callback: () => Promise<void>): Promise<Registration>;
    (name: "context" | "generate" | "compaction", callback: (event: SandboxInferenceEvent) => Promise<void>): Promise<Registration>;
  } };
};
export type SandboxPluginDependencies = {
  status(): Promise<SandboxToolMode>;
  computers?: ComputerRouting;
  prewarm?(): Promise<void>;
  assertHostExecution?(): Promise<void>;
  projectConfigDisabled?: boolean;
  execute(name: SandboxToolName, input: unknown, call: SandboxToolCall): Promise<SandboxEngineResult>;
};

export async function setupSandboxTools(context: SandboxPluginContext, dependencies: SandboxPluginDependencies) {
  let mode: SandboxToolMode;
  try { mode = modeSchema.parse(await dependencies.status()); }
  catch { mode = "only"; }
  let lastKnownMode = mode;
  const computers = dependencies.computers ? computerRouting(context, dependencies.computers) : undefined;
  let computerStatus = await computers?.status() ?? "off";
  const readMode = async (): Promise<SandboxToolMode> => {
    lastKnownMode = modeSchema.parse(await dependencies.status());
    return lastKnownMode;
  };
  const offeredMode = (): Promise<SandboxToolMode> => readMode().catch(() => lastKnownMode === "only" ? "only" : "off");
  let closed = false;
  const assertProjectIsolation = () => {
    if (dependencies.projectConfigDisabled === false) throw new Error("Restart OpenWork to apply your sandbox setting, then try again. Nothing ran.");
  };
  const hooksAvailable = !!context.tool.hook && !!context.mcp;
  if (mode === "only" && !hooksAvailable) throw new Error("OpenWork couldn’t enforce your sandbox setting. Restart OpenWork and try again.");
  let mcpMode = mode;
  const guard = await context.tool.hook?.("execute.before", async event => {
    if (SANDBOX_TOOL_NAMES.some(name => event.tool === name) || (event.tool === "runs_on" && computerStatus === "enabled")) return;
    if (dependencies.assertHostExecution) return dependencies.assertHostExecution();
    if (modeSchema.parse(await dependencies.status()) === "only") {
      throw new Error("This tool can’t run with your sandbox setting. Use the sandbox tools instead.");
    }
  });
  const servers = await context.mcp?.transform(editor => {
    if (mode !== "only") return;
    for (const [name, value] of editor.list()) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) editor.set(name, { ...value, disabled: true });
      else editor.set(name, { disabled: true });
    }
  });
  const definitions = SANDBOX_TOOL_NAMES.map(name => ({ name, input: z.toJSONSchema(sandboxToolSchemas[name]) }));
  for (const definition of definitions) {
    const problems = providerSchemaProblems(definition.input);
    if (problems.length) throw new Error(`Unsafe sandbox tool schema for ${definition.name}: ${problems.join(", ")}`);
  }
  const registration = await context.tool.transform(editor => {
    const catalogMode = mode;
    if (catalogMode === "only") {
      for (const tool of editor.list()) editor.remove(tool.id);
    } else {
      for (const original of editor.list()) {
        const execute = original.execute;
        if (!execute || !original.name || original.description === undefined || !original.input) throw new Error("OpenWork couldn’t check its tools. Update OpenWork and try again.");
        editor.remove(original.id);
        const computerOutput = catalogMode === "off" && computerStatus === "enabled" && computers?.routes(original.id);
        editor.add({ ...original, ...(computerOutput ? { output: {} } : {}), name: original.name, description: original.description, input: original.input, async execute(input, call) {
          if (dependencies.assertHostExecution) await dependencies.assertHostExecution();
          else if (await dependencies.status() === "only") throw new Error("This tool can’t run with your current sandbox setting. Nothing ran.");
          if (catalogMode === "off" && computerStatus !== "off") {
            const result = await computers?.execute(original.id, input, call);
            if (result) return computerOutput ? { ...result, output: {} } : result;
          }
          return execute(input, call);
        } });
      }
    }
    if (computerStatus === "enabled" && computers) editor.add(computers.control(catalogMode));
    if (catalogMode === "off") return;
    for (const definition of definitions) {
      const name = definition.name;
      editor.add({
        name: catalogMode === "only" ? name : `sandbox_${name}`,
        description: sandboxToolDescriptions[name],
        input: definition.input,
        options: { codemode: false },
        async execute(input, call) {
          call.signal.throwIfAborted();
          if (closed) throw new Error("The sandbox has closed. Reopen OpenWork and try again.");
          if (await readMode() === "only") assertProjectIsolation();
          call.signal.throwIfAborted();
          const parsed = sandboxToolSchemas[name].parse(input);
          return resultSchema.parse(await dependencies.execute(name, parsed, call));
        },
      });
    }
  });
  let prompt: Registration;
  try {
    prompt = await context.session.hook("prompt", async () => {
      const next = await offeredMode();
      const previousComputerStatus = computerStatus;
      computerStatus = await computers?.status() ?? "off";
      const controlsChanged = (previousComputerStatus === "enabled") !== (computerStatus === "enabled");
      if (next !== "off") void dependencies.prewarm?.().catch(() => undefined);
      if (next === "only") assertProjectIsolation();
      if (next === "only" && !hooksAvailable) throw new Error("Restart OpenWork to apply your sandbox setting, then send your message again.");
      if (next !== mcpMode && (next === "only" || mcpMode === "only")) {
        if (!context.mcp?.reload) throw new Error("Restart OpenWork to apply your sandbox setting to connected tools, then try again.");
        mode = next;
        await context.mcp.reload();
        mcpMode = next;
        await context.tool.reload();
      }
      if (closed || (next === mode && !controlsChanged)) return;
      const previous = mode;
      mode = next;
      try { await context.tool.reload(); } catch (error) {
        mode = previous;
        computerStatus = previousComputerStatus;
        throw error;
      }
    });
  } catch (error) {
    await registration.dispose();
    throw error;
  }
  const inference: Registration[] = [];
  for (const name of ["context", "generate", "compaction"] satisfies ("context" | "generate" | "compaction")[]) {
    inference.push(await context.session.hook(name, async event => {
      const current = await readMode().catch(() => lastKnownMode);
      if (current !== "only") {
        if (name === "context" && current === "off" && computerStatus === "enabled" && event.sessionID) {
          const instruction = await computers?.instruction(event.sessionID);
          if (instruction) event.system.push({ type: "text", text: instruction });
        }
        return;
      }
      assertProjectIsolation();
      removeHostCatalog(event);
      for (const id of Object.keys(event.tools)) if (!SANDBOX_TOOL_NAMES.some(name => id === name)) delete event.tools[id];
      for (const definition of definitions) event.tools[definition.name] = {
        description: sandboxToolDescriptions[definition.name], input: definition.input,
      };
      if (computerStatus === "enabled" && computers) {
        const control = computers.control(current);
        event.tools[control.name] = { description: control.description, input: control.input };
      }
    }));
  }
  return async () => {
    closed = true;
    try { for (const hook of inference) await hook.dispose(); await prompt.dispose(); } finally {
      try { await registration.dispose(); } finally { await servers?.dispose(); await guard?.dispose(); }
    }
  };
}

export default {
  id: "openwork.sandbox",
  async setup(context: SandboxPluginContext) {
    const options = z.object({ url: z.string().url(), token: z.string().min(1), computers: z.boolean().optional() }).strict().parse(context.options);
    const url = new URL(options.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash) throw new Error("OpenWork couldn’t connect to the sandbox on this computer.");
    const directory = context.location?.directory;
    if (!directory) throw new Error("Open a project folder in OpenWork before using the sandbox.");
    const request = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: signal ?? AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ directory, ...body }),
      });
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
        throw new Error(failure.success ? failure.data.error.slice(0, 500) : "The sandbox request failed. Try again. Nothing ran on this computer.");
      }
      return response.json();
    };
    return setupSandboxTools(context, {
      projectConfigDisabled: ["1", "true"].includes(process.env.OPENCODE_CONFIG_PROJECT_DISABLE?.toLowerCase() ?? ""),
      ...(options.computers ? { computers: {
        async status() { return z.object({ status: computerStatusSchema }).parse(await request({ operation: "computers-status" })).status; },
        async binding(location) {
          return z.object({ binding: computerBindingSchema.nullable() }).parse(await request({ operation: "computer-binding", ...location, directory: location.directory ?? directory })).binding;
        },
        async select(location, input, signal) {
          return z.object({ text: z.string() }).parse(await request({ operation: "computer-select", ...location, directory: location.directory ?? directory, input }, signal)).text;
        },
        async execute(location, name, input, signal) {
          return z.object({ result: resultSchema.nullable() }).parse(await request({ operation: "computer-execute", ...location, directory: location.directory ?? directory, name, input }, signal)).result;
        },
      } } : {}),
      async status() { return z.object({ mode: modeSchema }).strict().parse(await request({ operation: "status" })).mode; },
      async prewarm() { await request({ operation: "prompt" }); },
      async assertHostExecution() { z.object({ allowed: z.literal(true) }).strict().parse(await request({ operation: "host" })); },
      async execute(name, input, call) {
        return resultSchema.parse(await request({ operation: "execute", name, input, sessionId: call.sessionID, ...(call.id ? { callId: call.id } : {}) }, call.signal));
      },
    });
  },
};
