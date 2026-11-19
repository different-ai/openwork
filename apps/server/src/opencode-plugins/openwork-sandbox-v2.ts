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
export type SandboxInferenceEvent = {
  tools: Record<string, unknown>;
  system: { text: string; metadata?: Record<string, unknown> }[];
};
const instructionMetadata = z.object({
  experimental: z.object({
    instructions: z.array(z.object({ key: z.string(), text: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();

/** Core 2.2.6 retains the initial instruction catalog independently of the tool
 * snapshot. Its supported request hooks identify generated sources explicitly;
 * never scrub arbitrary user/policy text merely for mentioning a host tool. */
function removeHostCatalog(event: SandboxInferenceEvent) {
  // The pinned core opencode-tools plugin appends this separate, unkeyed
  // SystemPart even after its session_move tool was removed by a transform.
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
  name: string; description: string; input: Record<string, unknown>; options?: { codemode?: boolean };
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
  session: { hook: {
    (name: "prompt", callback: () => Promise<void>): Promise<Registration>;
    (name: "context" | "generate" | "compaction", callback: (event: SandboxInferenceEvent) => Promise<void>): Promise<Registration>;
  } };
};
export type SandboxPluginDependencies = {
  status(): Promise<SandboxToolMode>;
  prewarm?(): Promise<void>;
  assertHostExecution?(): Promise<void>;
  /** Process-start fact supplied by the trusted native entrypoint. */
  projectConfigDisabled?: boolean;
  execute(name: SandboxToolName, input: unknown, call: SandboxToolCall): Promise<SandboxEngineResult>;
};

/** In required mode the supported catalog is exactly the six guest primitives.
 * Unknown/custom tools (including patch, browser and file-transfer helpers) are
 * denied by default, rather than guessed safe by name or a broad namespace.
 * Host APIs have their own server-side guards; this is not an OS process jail.
 */
export async function setupSandboxTools(context: SandboxPluginContext, dependencies: SandboxPluginDependencies) {
  // Plugin setup failures may be logged rather than abort engine startup. An
  // unknown initial mode therefore installs the restrictive catalog and MCP
  // guards; its context/tool calls still fail until authority can be verified.
  let mode: SandboxToolMode;
  try { mode = modeSchema.parse(await dependencies.status()); }
  catch { mode = "only"; }
  let lastKnownMode = mode;
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
    // Primitive implementations are individually guarded (guest and retained
    // host snapshots). Everything outside that bounded set, including Code
    // Mode's execute/fetch interpreter, needs fresh host authority.
    if (SANDBOX_TOOL_NAMES.some(name => event.tool === name)) return;
    if (dependencies.assertHostExecution) return dependencies.assertHostExecution();
    if (modeSchema.parse(await dependencies.status()) === "only") {
      throw new Error("This tool can’t run with your sandbox setting. Use the sandbox tools instead.");
    }
  });
  // Disable every MCP transport in the deliberately bounded first required-mode
  // catalog. In particular local/stdio commands never spawn before tool hooks.
  const servers = await context.mcp?.transform(editor => {
    if (mode !== "only") return;
    for (const [name, value] of editor.list()) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) editor.set(name, { ...value, disabled: true });
      else editor.set(name, { disabled: true });
    }
  });
  const definitions = SANDBOX_TOOL_NAMES.map(name => ({ name, input: z.toJSONSchema(sandboxToolSchemas[name]) }));
  // A replacement schema must never silently disappear and leave a host tool
  // behind. Validate all schemas before making a single catalog modification.
  for (const definition of definitions) {
    const problems = providerSchemaProblems(definition.input);
    if (problems.length) throw new Error(`Unsafe sandbox tool schema for ${definition.name}: ${problems.join(", ")}`);
  }
  const registration = await context.tool.transform(editor => {
    const catalogMode = mode;
    if (catalogMode === "only") {
      for (const tool of editor.list()) editor.remove(tool.id);
    } else {
      // Guard original implementations too: an inference snapshot made before
      // revocation may retain a host shell/read callable with the same id as
      // its new guest replacement. A name-only before hook cannot tell them apart.
      for (const original of editor.list()) {
        const execute = original.execute;
        if (!execute || !original.name || original.description === undefined || !original.input) throw new Error("OpenWork couldn’t check its tools. Update OpenWork and try again.");
        editor.remove(original.id);
        editor.add({ ...original, name: original.name, description: original.description, input: original.input, async execute(input, call) {
          if (dependencies.assertHostExecution) await dependencies.assertHostExecution();
          else if (await dependencies.status() === "only") throw new Error("This tool can’t run with your current sandbox setting. Nothing ran.");
          return execute(input, call);
        } });
      }
    }
    if (catalogMode === "off") return;
    for (const definition of definitions) {
      const name = definition.name;
      editor.add({
        name: catalogMode === "only" ? name : `sandbox_${name}`,
        description: sandboxToolDescriptions[name],
        input: definition.input,
        // Guest operations are direct tools in both modes. Code Mode's host-side
        // interpreter must never be required to reach the local microVM.
        options: { codemode: false },
        async execute(input, call) {
          call.signal.throwIfAborted();
          if (closed) throw new Error("The sandbox has closed. Reopen OpenWork and try again.");
          // A captured sandbox tool can finish after a catalog change. The
          // server still checks rollout, folder grants, and current authority.
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
  // Code Mode synthesizes execute plus browser namespaces after tool transforms.
  // Filter the final per-inference catalog too: its host-side fetch interpreter
  // must neither be advertised nor be required to reach the guest primitives.
  const inference: Registration[] = [];
  for (const name of ["context", "generate", "compaction"] satisfies ("context" | "generate" | "compaction")[]) {
    inference.push(await context.session.hook(name, async event => {
      const current = await readMode().catch(() => lastKnownMode);
      if (current !== "only") return;
      assertProjectIsolation();
      removeHostCatalog(event);
      for (const id of Object.keys(event.tools)) if (!SANDBOX_TOOL_NAMES.some(name => id === name)) delete event.tools[id];
      // OpenCode 2.2.6's built-in patch hook removes edit/write for gpt-* on
      // all three request kinds. Restore only our validated guest descriptors,
      // never host patch or execute. Core matches these names to this request's
      // executable registry snapshot, so a tool absent from that snapshot
      // (e.g. denied by agent permissions) is still unavailable, not invented.
      for (const definition of definitions) event.tools[definition.name] = {
        description: sandboxToolDescriptions[definition.name], input: definition.input,
      };
    }));
  }
  return async () => {
    closed = true;
    try { for (const hook of inference) await hook.dispose(); await prompt.dispose(); } finally {
      try { await registration.dispose(); } finally { await servers?.dispose(); await guard?.dispose(); }
    }
  };
}

/** Trusted options come from the server; no environment flags or model-supplied endpoint. */
export default {
  id: "openwork.sandbox",
  async setup(context: SandboxPluginContext) {
    const options = z.object({ url: z.string().url(), token: z.string().min(1) }).strict().parse(context.options);
    const url = new URL(options.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash) throw new Error("OpenWork couldn’t connect to the sandbox on this computer.");
    const directory = context.location?.directory;
    if (!directory) throw new Error("Open a project folder in OpenWork before using the sandbox.");
    const request = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: signal ?? AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, directory }),
      });
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
        throw new Error(failure.success ? failure.data.error.slice(0, 500) : "The sandbox request failed. Try again. Nothing ran on this computer.");
      }
      return response.json();
    };
    return setupSandboxTools(context, {
      projectConfigDisabled: ["1", "true"].includes(process.env.OPENCODE_CONFIG_PROJECT_DISABLE?.toLowerCase() ?? ""),
      async status() { return z.object({ mode: modeSchema }).strict().parse(await request({ operation: "status" })).mode; },
      async prewarm() { await request({ operation: "prompt" }); },
      async assertHostExecution() { z.object({ allowed: z.literal(true) }).strict().parse(await request({ operation: "host" })); },
      async execute(name, input, call) {
        return resultSchema.parse(await request({ operation: "execute", name, input, sessionId: call.sessionID, ...(call.id ? { callId: call.id } : {}) }, call.signal));
      },
    });
  },
};
