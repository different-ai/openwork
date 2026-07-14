const MAX_ENGINE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ENGINE_AGENT_COUNT = 200;
const MAX_ENGINE_PERMISSION_RULES = 2_000;
const MAX_ENGINE_MCP_COUNT = 200;
const MAX_ENGINE_PLUGIN_COUNT = 200;
const MAX_ENGINE_PROMPT_LENGTH = 1024 * 1024;
const MAX_ENGINE_TEXT_LENGTH = 500;

export type EffectiveEnginePermissionAction = "allow" | "ask" | "deny";

export type EffectiveEnginePermissionRule = {
  permission: string;
  pattern: string;
  action: EffectiveEnginePermissionAction;
};

export type EffectiveEngineAgent = {
  name: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  prompt: string;
  permission: EffectiveEnginePermissionRule[];
};

export type EffectiveEngineSnapshot = {
  defaultAgent: string | null;
  pluginSpecs: string[];
  mcps: Array<{ name: string; config: Record<string, unknown> }>;
  agents: EffectiveEngineAgent[];
};

export type AgentDiagnosticsEngineInspectionPayload = {
  config: unknown;
  agents: unknown;
};

export type InspectAgentDiagnosticsEngine = (
  signal: AbortSignal,
) => Promise<AgentDiagnosticsEngineInspectionPayload>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_ENGINE_TEXT_LENGTH ? value : null;
}

function parsePermissionRules(value: unknown): EffectiveEnginePermissionRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_ENGINE_PERMISSION_RULES) return null;
  const rules: EffectiveEnginePermissionRule[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const permission = boundedText(raw.permission);
    const pattern = boundedText(raw.pattern);
    const action = raw.action;
    if (!permission || !pattern || (action !== "allow" && action !== "ask" && action !== "deny")) {
      return null;
    }
    rules.push({ permission, pattern, action });
  }
  return rules;
}

function parseAgents(value: unknown): EffectiveEngineAgent[] | null {
  if (!Array.isArray(value) || value.length > MAX_ENGINE_AGENT_COUNT) return null;
  const agents: EffectiveEngineAgent[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const name = boundedText(raw.name);
    const mode = raw.mode;
    const prompt = raw.prompt === undefined ? "" : raw.prompt;
    const permission = parsePermissionRules(raw.permission);
    if (
      !name
      || (mode !== "subagent" && mode !== "primary" && mode !== "all")
      || typeof prompt !== "string"
      || prompt.length > MAX_ENGINE_PROMPT_LENGTH
      || permission === null
    ) {
      return null;
    }
    agents.push({
      name,
      mode,
      hidden: raw.hidden === true,
      prompt,
      permission,
    });
  }
  return agents;
}

function parsePluginSpecs(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENGINE_PLUGIN_COUNT) return null;
  const specs: string[] = [];
  for (const raw of value) {
    const spec = typeof raw === "string"
      ? raw
      : Array.isArray(raw) && typeof raw[0] === "string"
        ? raw[0]
        : null;
    if (spec === null || spec.length > MAX_ENGINE_TEXT_LENGTH) return null;
    specs.push(spec);
  }
  return specs;
}

function parseMcps(value: unknown): EffectiveEngineSnapshot["mcps"] | null {
  if (value === undefined) return [];
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_ENGINE_MCP_COUNT) return null;
  const mcps: EffectiveEngineSnapshot["mcps"] = [];
  for (const [name, config] of entries) {
    if (!name || name.length > MAX_ENGINE_TEXT_LENGTH || !isRecord(config)) return null;
    mcps.push({ name, config });
  }
  return mcps;
}

/**
 * Reduce the live engine responses to a strict, bounded allowlist before the
 * analyzer uses them. Raw config, prompts, errors, and credential values never
 * cross into the diagnostics report.
 */
export function validateEffectiveEngineSnapshot(
  payload: AgentDiagnosticsEngineInspectionPayload,
): EffectiveEngineSnapshot | null {
  if (!isRecord(payload) || !isRecord(payload.config)) return null;
  const defaultAgent = payload.config.default_agent === undefined
    ? null
    : boundedText(payload.config.default_agent);
  if (payload.config.default_agent !== undefined && defaultAgent === null) return null;
  const pluginSpecs = parsePluginSpecs(payload.config.plugin);
  const mcps = parseMcps(payload.config.mcp);
  const agents = parseAgents(payload.agents);
  if (pluginSpecs === null || mcps === null || agents === null) return null;
  return { defaultAgent, pluginSpecs, mcps, agents };
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  try {
    return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s")
      .test(value.replaceAll("\\", "/"));
  } catch {
    return false;
  }
}

/** Mirrors OpenCode's tool-visibility rule: the last matching permission wins,
 * and only a whole-resource (`pattern: "*"`) deny removes a tool from context.
 */
export function effectiveToolDecision(
  rules: EffectiveEnginePermissionRule[],
  toolId: string,
): EffectiveEnginePermissionAction {
  let winning: EffectiveEnginePermissionRule | undefined;
  for (const rule of rules) {
    if (wildcardMatch(toolId, rule.permission)) winning = rule;
  }
  if (winning?.pattern === "*" && winning.action === "deny") return "deny";
  if (winning?.pattern === "*" && winning.action === "ask") return "ask";
  return "allow";
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; callers receive only a stable safe error.
  }
}

async function bufferBoundedResponse(response: Response, maxBytes: number): Promise<Response> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponse(response);
    throw new Error("agent_diagnostics_engine_response_too_large");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("agent_diagnostics_engine_response_too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** A dedicated fetch wrapper for the two diagnostics engine reads. */
export function createAgentDiagnosticsEngineFetch(
  fetchImpl: typeof fetch,
  maxBytes = MAX_ENGINE_RESPONSE_BYTES,
): typeof fetch {
  const run = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const response = await fetchImpl(new Request(request, { redirect: "manual" }));
    if (response.status >= 300 && response.status < 400) {
      await cancelResponse(response);
      throw new Error("agent_diagnostics_engine_redirect_rejected");
    }
    return bufferBoundedResponse(response, maxBytes);
  };
  return Object.assign(run, { preconnect: fetchImpl.preconnect });
}
