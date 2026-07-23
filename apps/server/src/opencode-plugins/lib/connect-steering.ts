import { z } from "zod";

import { logPromptDebug, promptTraceId } from "../openwork-debug-log.js";
import {
  readContext,
  readProviderModel,
  type OpenCodeContext,
  type OpenWorkEngineMcpStatusClient,
} from "./context.js";
import { OPENWORK_CLOUD_MCP_NAME } from "./constants.js";
import { getRecordProperty, isRecord, readNestedString, readString } from "./records.js";
import {
  errorMessage,
  parseResponse,
  requireOpenWorkServer,
  type OpenWorkFetch,
} from "./server-client.js";

export type { OpenCodeContext, OpenWorkEngineMcpStatusClient } from "./context.js";

export type OpenWorkExtensionConnectState = {
  connectEnabled: boolean;
  connectCatalogEnabled: boolean;
  cloudMcpPresent: boolean;
  cloudHealth: OpenWorkCloudHealthSummary | null;
  workspace?: {
    resolution?: string;
    id?: string | null;
    directory?: string | null;
    reason?: string;
  };
  googleWorkspace: {
    legacyConfigured: boolean;
  };
};

export type OpenWorkContextBundle = {
  ok: true;
  schemaVersion: 1;
  steering: OpenWorkExtensionConnectState | null;
  skills: {
    instruction: string;
    count: number;
  };
  diagnostics: string[];
  generatedAt: number;
};

export type OpenWorkContextBundleFailure =
  | { classification: "configuration" }
  | { classification: "auth"; status: number }
  | { classification: "http"; status: number }
  | { classification: "schema" }
  | { classification: "transport" }
  | { classification: "unknown" };

class OpenWorkContextBundleFetchError extends Error {
  readonly failure: OpenWorkContextBundleFailure;

  constructor(failure: OpenWorkContextBundleFailure) {
    super(`OpenWork context bundle request failed (${failure.classification})`);
    this.name = "OpenWorkContextBundleFetchError";
    this.failure = failure;
  }
}

/**
 * Reduces a context-bundle failure to fields that are safe for diagnostics.
 * Deliberately excludes thrown messages, response bodies, request URLs, and
 * authorization values.
 */
export function classifyOpenWorkContextBundleFailure(
  error: unknown,
): OpenWorkContextBundleFailure {
  if (error instanceof OpenWorkContextBundleFetchError) return error.failure;
  return { classification: "unknown" };
}

export type OpenWorkCloudHealthSummary = {
  usable: boolean;
  usableByCurrentModel: boolean | null;
  phase: string;
  connectCatalogEnabled?: boolean;
  workspace: {
    id: string;
    directory: string | null;
  };
  desired: {
    present: boolean;
    revision: string | null;
  };
  delivery?: {
    appliedRevision?: string | null;
  };
  engine?: {
    status?: string;
  };
  firstFailure: {
    code: string;
    stage: string;
    recommendedAction: string;
    message: string;
  } | null;
};

export type OpenWorkEngineMcpStatusSource = {
  client?: OpenWorkEngineMcpStatusClient;
  directory?: string;
};

type EngineMcpStatusResult =
  | { found: true; status: string | undefined }
  | { found: false };

const cloudFailureSchema = z.object({
  code: z.string(),
  stage: z.string(),
  recommendedAction: z.string(),
  message: z.string(),
}).passthrough();

const cloudHealthSchema = z.object({
  usable: z.boolean(),
  usableByCurrentModel: z.boolean().nullable(),
  phase: z.string(),
  connectCatalogEnabled: z.boolean().optional(),
  workspace: z.object({
    id: z.string(),
    directory: z.string().nullable(),
  }).passthrough(),
  desired: z.object({
    present: z.boolean(),
    revision: z.string().nullable(),
  }).passthrough(),
  delivery: z.object({
    appliedRevision: z.string().nullable().optional(),
  }).passthrough().optional(),
  engine: z.object({
    status: z.string().optional(),
  }).passthrough().optional(),
  firstFailure: cloudFailureSchema.nullable(),
}).passthrough();

const connectSnapshotSchema = z.object({
  connectEnabled: z.boolean(),
  connectCatalogEnabled: z.boolean().optional(),
  cloudMcpPresent: z.boolean(),
  cloudHealth: cloudHealthSchema.nullable().optional(),
  workspace: z.object({
    resolution: z.string().optional(),
    id: z.string().nullable().optional(),
    directory: z.string().nullable().optional(),
    reason: z.string().optional(),
  }).passthrough().optional(),
  googleWorkspace: z.object({
    legacyConfigured: z.boolean(),
  }).passthrough(),
}).passthrough();

const connectStateResponseSchema = connectSnapshotSchema.extend({
  ok: z.literal(true),
  schemaVersion: z.number(),
});

const connectSkillsResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.number(),
  instruction: z.string(),
  diagnostics: z.array(z.string()).optional(),
}).passthrough();

const contextBundleResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(1),
  steering: connectSnapshotSchema.nullable(),
  skills: z.object({
    instruction: z.string(),
    count: z.number().int().nonnegative(),
  }).passthrough(),
  diagnostics: z.array(z.string()),
  generatedAt: z.number(),
}).passthrough();

export const OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check OpenWork extensions before saying the capability is unavailable. Use openwork_extension_list_actions to inspect available extension actions, then call the matching action with openwork_extension_call.";

export const OPENWORK_CLOUD_CONNECTION_INSTRUCTION =
  "The OpenWork Cloud connection is verified ready for this exact workspace/model. For email (Gmail), calendar, Google Drive, and org-connected services such as Notion, Linear, Slack, etc., FIRST call openwork-cloud_search_capabilities with 2-4 keyword variants, then call openwork-cloud_execute_capability with an exact returned name. Search before claiming these are unavailable. OpenWork extensions (openwork_extension_list_actions / openwork_extension_call) remain available for other local actions such as image generation; use OpenWork Cloud capabilities for Google Workspace. Settings > Connect is the relevant settings surface for Google Workspace. A successful search proves OpenWork Cloud itself is authorized, so a downstream connector failure does not mean OpenWork Cloud needs to be reconnected. If a result has kind connection_status, name connectionStatus.connectionName and relay connectionStatus.action exactly: use Your Connections for the member, the organization Connections dashboard for an org admin, or the provider admin console for a provider-side failure. After the requested human fixes that connector, search again in the same task because results are live, not cached, so unchanged retries return the same error.";

export const OPENWORK_CONNECT_SIGN_IN_INSTRUCTION =
  `${OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION} OpenWork Cloud is not signed in or no desired agent access configuration exists for this workspace. Direct the user to sign in to OpenWork and connect the service in Settings → Connect.`;

export const OPENWORK_CONNECT_DISABLED_INSTRUCTION =
  `${OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION} OpenWork Cloud agent access is explicitly disabled for this workspace. Explain that the user can enable agent access in Settings → Connect.`;

function readEngineDirectory(input: unknown, fallback?: string): string | undefined {
  const context = readContext(input);
  return context.directory ?? context.worktree ?? readString(fallback);
}

function engineStatusPayload(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const data = result.data;
  if (data !== undefined) return data;
  if (result.error !== undefined) throw new Error("OpenCode MCP status request failed");
  const responseOk = getRecordProperty(result.response, "ok");
  if (responseOk === false) throw new Error("OpenCode MCP status request failed");
  return result;
}

function readEngineMcpStatus(result: unknown): EngineMcpStatusResult {
  const entry = getRecordProperty(engineStatusPayload(result), OPENWORK_CLOUD_MCP_NAME);
  if (entry === undefined) return { found: false };
  if (typeof entry === "string") return { found: true, status: readString(entry) };
  return { found: true, status: readNestedString(entry, ["status"]) };
}

async function fetchEngineMcpStatus(input: unknown, engine: OpenWorkEngineMcpStatusSource): Promise<EngineMcpStatusResult> {
  if (!engine.client) return { found: false };
  const directory = readEngineDirectory(input, engine.directory);
  const request = directory ? { query: { directory } } : undefined;
  return readEngineMcpStatus(await engine.client.mcp.status(request));
}

function connectQuery(
  input: unknown,
  includeProviderModel: boolean,
  options: { steering?: "active" | "passive" | "omit" } = {},
): string {
  const context = readContext(input);
  const query = new URLSearchParams();
  const workspaceId = context.workspaceId ?? context.workspaceID;
  const directory = context.worktree ?? context.directory;
  if (workspaceId) query.set("workspaceId", workspaceId);
  if (directory) query.set("directory", directory);
  if (includeProviderModel) {
    const providerModel = readProviderModel(input);
    if (providerModel) {
      query.set("provider", providerModel.provider);
      query.set("model", providerModel.model);
    }
  }
  if (options.steering && options.steering !== "active") query.set("steering", options.steering);
  return query.size ? `?${query.toString()}` : "";
}

function normalizeConnectState(
  parsed: z.infer<typeof connectSnapshotSchema>,
): OpenWorkExtensionConnectState {
  return {
    connectEnabled: parsed.connectEnabled,
    connectCatalogEnabled: parsed.connectCatalogEnabled ?? parsed.connectEnabled,
    cloudMcpPresent: parsed.cloudMcpPresent,
    cloudHealth: parsed.cloudHealth ?? null,
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
    googleWorkspace: {
      legacyConfigured: parsed.googleWorkspace.legacyConfigured,
    },
  };
}

async function fetchOpenWorkConnectState(input: unknown, fetcher: OpenWorkFetch): Promise<OpenWorkExtensionConnectState> {
  const { url, token } = requireOpenWorkServer();
  const response = await fetcher(`${url}/experimental/connect/state${connectQuery(input, true)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "OpenWork connect state request failed"));
  return normalizeConnectState(connectStateResponseSchema.parse(payload));
}

export async function fetchOpenWorkContextBundle(
  input?: unknown,
  fetcher: OpenWorkFetch = fetch,
  traceId: string = promptTraceId(input),
): Promise<OpenWorkContextBundle> {
  let server: { url: string; token: string };
  try {
    server = requireOpenWorkServer();
    const parsedUrl = new URL(server.url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Unsupported OpenWork server protocol");
    }
  } catch {
    throw new OpenWorkContextBundleFetchError({ classification: "configuration" });
  }

  let response: Response;
  try {
    response = await fetcher(
      `${server.url}/experimental/connect/context${connectQuery(input, false, { steering: "passive" })}`,
      {
        headers: {
          Authorization: `Bearer ${server.token}`,
          "X-OpenWork-Prompt-Trace": traceId,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    throw new OpenWorkContextBundleFetchError({ classification: "transport" });
  }

  if (!response.ok) {
    const classification = response.status === 401 || response.status === 403
      ? "auth"
      : "http";
    throw new OpenWorkContextBundleFetchError({ classification, status: response.status });
  }

  let payload: unknown;
  try {
    payload = await parseResponse(response);
  } catch {
    throw new OpenWorkContextBundleFetchError({ classification: "transport" });
  }

  let parsed: z.infer<typeof contextBundleResponseSchema>;
  try {
    parsed = contextBundleResponseSchema.parse(payload);
  } catch {
    throw new OpenWorkContextBundleFetchError({ classification: "schema" });
  }
  return {
    ok: true,
    schemaVersion: parsed.schemaVersion,
    steering: parsed.steering ? normalizeConnectState(parsed.steering) : null,
    skills: {
      instruction: parsed.skills.instruction,
      count: parsed.skills.count,
    },
    diagnostics: parsed.diagnostics,
    generatedAt: parsed.generatedAt,
  };
}

export async function resolveOpenWorkConnectSkillInstruction(input?: unknown, fetcher: OpenWorkFetch = fetch): Promise<string> {
  const trace = promptTraceId(input);
  try {
    const { url, token } = requireOpenWorkServer();
    // Connect skills are server/account-scoped; workspace query values are
    // relevant to steering but must not gate the remote skill catalog.
    const response = await fetcher(`${url}/experimental/connect/skills`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-OpenWork-Prompt-Trace": trace,
      },
    });
    if (!response.ok) {
      logPromptDebug("connect-skills", `trace=${trace} skill instruction skipped: /experimental/connect/skills returned HTTP ${response.status}`);
      return "";
    }
    const parsed = connectSkillsResponseSchema.parse(await parseResponse(response));
    for (const message of parsed.diagnostics ?? []) {
      logPromptDebug("connect-skills", `trace=${trace} server: ${message}`);
    }
    if (parsed.instruction) {
      logPromptDebug("connect-skills", `trace=${trace} skill instruction resolved (${parsed.instruction.length} chars) from server-scoped catalog`);
    } else {
      logPromptDebug("connect-skills", `trace=${trace} skill instruction skipped: server returned an empty instruction (see server reasons above)`);
    }
    return parsed.instruction;
  } catch {
    logPromptDebug(
      "connect-skills",
      `trace=${trace} skill instruction skipped: classification=configuration_transport_or_schema (details redacted)`,
    );
    return "";
  }
}

export function resolveOpenWorkConnectSkillInstructionFromBundle(
  input: unknown,
  bundle: OpenWorkContextBundle | null,
  trace: string = promptTraceId(input),
): string {
  if (!bundle) {
    logPromptDebug("connect-skills", `trace=${trace} skill instruction skipped: context bundle unavailable`);
    return "";
  }
  for (const message of bundle.diagnostics) {
    logPromptDebug("connect-skills", `trace=${trace} server: ${message}`);
  }
  const context = readContext(input);
  const workspaceId = context.workspaceId ?? context.workspaceID;
  const directory = context.worktree ?? context.directory;
  const scope = workspaceId ? "workspace" : directory ? "directory" : "unscoped";
  if (bundle.skills.instruction) {
    logPromptDebug("connect-skills", `trace=${trace} skill instruction resolved (${bundle.skills.instruction.length} chars, ${bundle.skills.count} catalog entries, scope=${scope})`);
  } else {
    logPromptDebug("connect-skills", `trace=${trace} skill instruction skipped: server returned an empty instruction (see server reasons above)`);
  }
  return bundle.skills.instruction;
}

export function composeOpenWorkExtensionDiscoveryInstruction(state: OpenWorkExtensionConnectState | null): string {
  if (!state) return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  if (state.workspace?.resolution && state.workspace.resolution !== "resolved") return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  const health = state.cloudHealth;
  if (health?.usable === true && health.usableByCurrentModel !== false) return OPENWORK_CLOUD_CONNECTION_INSTRUCTION;
  if (health?.phase === "engine_disabled" || health?.firstFailure?.code === "engine_disabled" || health?.firstFailure?.code === "cloud_mcp_disabled") return OPENWORK_CONNECT_DISABLED_INSTRUCTION;
  if (health) {
    if (!health.desired.present || health.firstFailure?.code === "cloud_mcp_missing") return OPENWORK_CONNECT_SIGN_IN_INSTRUCTION;
    return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  }
  if (!state.connectCatalogEnabled || state.googleWorkspace.legacyConfigured) return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  if (state.cloudMcpPresent) return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  return OPENWORK_CONNECT_SIGN_IN_INSTRUCTION;
}

export function composeSteeringFromEngineMcpStatus(status: string | undefined): string {
  if (status === "connected") return OPENWORK_CLOUD_CONNECTION_INSTRUCTION;
  if (status === "disabled") return OPENWORK_CONNECT_DISABLED_INSTRUCTION;
  if (status === "needs_auth" || status === "needs_client_registration") return OPENWORK_CONNECT_SIGN_IN_INSTRUCTION;
  return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
}

export async function resolveOpenWorkExtensionDiscoveryInstruction(
  input?: unknown,
  fetcher: OpenWorkFetch = fetch,
  engine: OpenWorkEngineMcpStatusSource = {},
  bundleSteering?: OpenWorkExtensionConnectState | null,
): Promise<string> {
  if (engine.client) {
    try {
      // Invariant: the OpenCode engine owns MCP registration and builds the
      // prompt tool list, so tool-availability steering must come from that
      // same in-process MCP state. Server health probes may fail for reasons
      // (for example corporate TLS trust) that do not affect engine tools.
      const engineStatus = await fetchEngineMcpStatus(input, engine);
      if (engineStatus.found) return composeSteeringFromEngineMcpStatus(engineStatus.status);
    } catch {
      return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
    }
  }
  if (bundleSteering !== undefined) {
    return composeOpenWorkExtensionDiscoveryInstruction(bundleSteering);
  }
  try {
    return composeOpenWorkExtensionDiscoveryInstruction(await fetchOpenWorkConnectState(input, fetcher));
  } catch {
    return OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION;
  }
}
