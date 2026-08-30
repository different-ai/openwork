import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { z } from "zod";
import type { OpenworkAffordanceEffects } from "@openwork/types/openwork-affordance";
import { automationProposalSchema } from "@openwork/types/automations";
import {
  composeAgentInstructions,
  createInstructionSection,
} from "./agent-instruction-compose.js";
import {
  composeSkillAuthoringInstruction,
  resolveOpenWorkAutomationInstruction,
  resolveOpenWorkConnectSkillInstruction,
  resolveOpenWorkExtensionDiscoveryInstruction,
  type OpenCodeContext,
  type OpenWorkEngineMcpStatusClient,
} from "./openwork-extensions-preview-steering.js";
import {
  buildOpenworkProviderContributions,
  type ConnectSkillDescriptor,
  type EngineMcpDescriptor,
} from "./openwork-provider-adapters.js";

type ExtensionActionPayload = {
  extensionId: string;
  action: string;
  args: Record<string, unknown>;
  context: ReturnType<typeof contextPayload>;
};

const listActionsArgsSchema = z.object({
  extensionId: z.string().optional().describe("Optional extension id to filter by, such as google-workspace."),
});

const callArgsSchema = z.object({
  extensionId: z.string().describe("Extension id, such as google-workspace."),
  action: z.string().describe("Action id from extension.actions."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the action."),
});

const openworkAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1).describe("Semantic affordance id from openwork_context."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the affordance."),
  expectedRevision: z.number().int().nonnegative().optional().describe("Context revision from openwork_context. Use for commands to prevent stale writes."),
  actor: z.string().trim().min(1).optional().describe("Optional agent or client id used to attribute serialized commands."),
});

const connectSkillDescriptorSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  capability: z.string(),
}).passthrough();

const connectSkillsEnvelopeSchema = z.object({
  skills: z.array(connectSkillDescriptorSchema),
}).passthrough();

const sessionSearchArgsSchema = z.object({
  query: z.string().trim().min(1).describe("Text to search for across OpenWork session titles and message transcripts."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name to limit the search."),
  limit: z.number().int().positive().max(20).optional().describe("Maximum matching sessions to return. Defaults to 10, max 20."),
  scanLimit: z.number().int().positive().max(500).optional().describe("Maximum newest sessions to scan across matching workspaces. Defaults to 100, max 500."),
  messageLimit: z.number().int().positive().max(1000).optional().describe("Maximum recent messages to load per scanned session. Defaults to 400, max 1000."),
});

const sessionReadArgsSchema = z.object({
  sessionId: z.string().trim().min(1).describe("OpenWork/OpenCode session ID returned by session.search."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
  count: z.number().int().positive().max(100).optional().describe("Number of recent transcript messages to return. Defaults to 30, max 100."),
});

const sessionCreateArgsSchema = z.object({
  sessions: z.array(z.object({
    title: z.string().trim().min(1).max(120).describe("Short title shown in the OpenWork session list."),
    prompt: z.string().trim().min(1).max(100_000).describe("Self-contained task to start in the new session."),
  })).min(1).describe("One entry per new session to create and start."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Defaults to the workspace containing the current session."),
});

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  path: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

const workspaceListEnvelopeSchema = z.object({
  items: z.array(workspaceSchema),
}).passthrough();

const sessionTimeSchema = z.object({
  created: z.number().optional(),
  updated: z.number().optional(),
}).passthrough();

const sessionInfoSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  directory: z.string().optional(),
  time: sessionTimeSchema.optional(),
}).passthrough();

const sessionPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();

const sessionMessageSchema = z.object({
  info: z.object({
    id: z.string(),
    role: z.string(),
    time: sessionTimeSchema.optional(),
  }).passthrough(),
  parts: z.array(sessionPartSchema),
}).passthrough();

const OPENWORK_AGENT_SURFACE_INSTRUCTION =
  `## OpenWork app context
Use openwork_context when the request depends on the current OpenWork screen, open tabs, split view, focused pane, sidebar, side panel, settings panel, or available app actions.
Each affordance declares its effects and executor. Use openwork_query only for side-effect-free affordances whose executor is OpenWork. Use openwork_execute for OpenWork commands without activating the desktop window. If executor names another tool, call that exact tool instead.
Reading another session does not require opening it. Prefer session.search then session.read for transcript questions; use session.create for new chats and a UI command only when the user asks to navigate.
To open settings or navigate the app, use openwork_execute with ids from openwork_context such as settings.panel.open — never browser_* tools for the OpenWork app itself.`;

// The one authoritative statement of the browser rules — the app-surface
// section already forbids browser_* on the OpenWork app, so this block only
// adds the external-web mechanics.
const OPENWORK_BROWSER_INSTRUCTION =
  `## Built-in Browser (external websites)
For web browsing tasks, ALWAYS start with openwork_execute id browser.open_url. It creates/selects a built-in OpenWork browser tab and returns browser_url plus target_id. Use that exact browser_url and target_id for every later browser_snapshot, browser_click, browser_fill, browser_eval, and browser_screenshot call.
Do not call browser_navigate without a target_id returned by browser.open_url. Never use browser_* tools on the OpenWork app itself (avoid targets with title "OpenWork" or URLs containing ":5173/#/").`;

// ── UI control bridge discovery ──

type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;

type OpenWorkWorkspace = z.infer<typeof workspaceSchema>;
type SessionInfo = z.infer<typeof sessionInfoSchema>;
type SessionMessage = z.infer<typeof sessionMessageSchema>;
type SessionSearchSnippet = { before: string; match: string; after: string };
type SessionSearchResult = {
  workspaceId: string;
  workspace: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  kind: "title" | "message";
  snippet: SessionSearchSnippet;
  role?: string;
  messageId?: string;
  messageIndex?: number;
};
type CreatedOpenWorkSessionResult = {
  ok: true;
  sessionId: string;
  title: string;
  started: boolean;
  route: string;
};
type FailedOpenWorkSessionResult = {
  ok: false;
  title: string;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_PRESERVED_MCP_APP_RESULT_BYTES = 1024 * 1024;

function preserveMcpResult(output: unknown): void {
  if (!isRecord(output) || !Array.isArray(output.content)) return;

  const appResult = {
    content: output.content,
    ...(output.structuredContent !== undefined ? { structuredContent: output.structuredContent } : {}),
    ...(isRecord(output._meta) ? { _meta: output._meta } : {}),
  };
  try {
    if (new TextEncoder().encode(JSON.stringify(appResult)).byteLength > MAX_PRESERVED_MCP_APP_RESULT_BYTES) return;
  } catch {
    return;
  }

  const existing = isRecord(output.metadata) ? output.metadata : {};
  output.metadata = {
    ...existing,
    // This is transport-only result preservation. Whether the completed tool
    // owns an MCP App is determined later from its current tool definition.
    openworkMcpApp: appResult,
  };
}

const affordanceReadEffects: OpenworkAffordanceEffects = { data: "read", ui: "none", external: false };
const affordanceWriteEffects: OpenworkAffordanceEffects = { data: "write", ui: "none", external: false };
const affordanceExternalWriteEffects: OpenworkAffordanceEffects = { data: "write", ui: "none", external: true };
// A proposal writes nothing anywhere: it is rendered for a person to act on.
const affordanceProposalEffects: OpenworkAffordanceEffects = { data: "none", ui: "none", external: false };

function affordanceResult(
  id: string,
  result: unknown,
  effects: OpenworkAffordanceEffects,
) {
  if (isRecord(result) && result.ok === false) {
    return {
      ok: false,
      id,
      error: typeof result.error === "string" ? result.error : `${id} failed`,
      code: "failed",
    };
  }
  return { ok: true, id, result, effects };
}

function unavailableAffordance(id: string, error: string) {
  return { ok: false, id, error, code: "unavailable" };
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

type OpenWorkEngineMcpStatusFunction = OpenWorkEngineMcpStatusClient["mcp"]["status"];

function isOpenWorkEngineMcpStatusFunction(value: unknown): value is OpenWorkEngineMcpStatusFunction {
  return typeof value === "function";
}

function readEngineMcpStatusClient(value: unknown): OpenWorkEngineMcpStatusClient | undefined {
  const client = isRecord(value) ? value.client : undefined;
  const mcp = isRecord(client) ? client.mcp : undefined;
  const status = isRecord(mcp) ? mcp.status : undefined;
  if (!isOpenWorkEngineMcpStatusFunction(status)) return undefined;
  return { mcp: { status: (request) => status.call(mcp, request) } };
}

function normalizeOpenCodeContext(value: unknown): OpenCodeContext {
  const nested = isRecord(value) && isRecord(value.context) ? value.context : value;
  const agent = optionalStringProperty(nested, "agent");
  const sessionID = optionalStringProperty(nested, "sessionID");
  const messageID = optionalStringProperty(nested, "messageID");
  const directory = optionalStringProperty(nested, "directory");
  const worktree = optionalStringProperty(nested, "worktree");
  const workspaceId = optionalStringProperty(nested, "workspaceId");
  const workspaceID = optionalStringProperty(nested, "workspaceID");
  return {
    ...(agent ? { agent } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(messageID ? { messageID } : {}),
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceID ? { workspaceID } : {}),
  };
}

function mergeTransformInputWithFactoryContext(input: unknown, factoryContext: OpenCodeContext): unknown {
  if (Object.keys(factoryContext).length === 0) return input;
  const inputRecord = isRecord(input) ? input : {};
  const inputContext = isRecord(inputRecord.context) ? inputRecord.context : {};
  return {
    ...inputRecord,
    context: {
      ...factoryContext,
      ...inputContext,
    },
  };
}

const SESSION_SEARCH_DEFAULT_LIMIT = 10;
const SESSION_SEARCH_DEFAULT_SCAN_LIMIT = 100;
const SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT = 400;
const SESSION_SEARCH_CONCURRENCY = 6;
const SESSION_SNIPPET_BEFORE = 36;
const SESSION_SNIPPET_AFTER = 72;

function userAppDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function uiControlDiscoveryPaths(): string[] {
  return [
    process.env.OPENWORK_UI_CONTROL_DISCOVERY?.trim(),
    join(userAppDataDir(), "com.differentai.openwork", "openwork-ui-control.json"),
    join(userAppDataDir(), "com.differentai.openwork.dev", "openwork-ui-control.json"),
  ].filter((p): p is string => Boolean(p));
}

async function discoverUiBridge(): Promise<UiBridge | null> {
  if (cachedBridge && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS) return cachedBridge;
  for (const candidate of uiControlDiscoveryPaths()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        cachedBridge = { baseUrl: parsed.baseUrl, token: parsed.token };
        cachedBridgeAt = Date.now();
        return cachedBridge;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

async function uiBridgeRequest(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const bridge = await discoverUiBridge();
  if (!bridge) return { ok: false, error: "OpenWork UI bridge not available. The desktop app may not be running." };
  try {
    const response = await fetch(`${bridge.baseUrl}${path}`, {
      method: options.method || "GET",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${response.status}` }; }
  } catch (error) {
    cachedBridge = null;
    cachedBridgeAt = 0;
    return { ok: false, error: `UI bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function serverGet(path: string): Promise<unknown> {
  const { url, token } = requireOpenWorkServer();
  const response = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "OpenWork server request failed"));
  return payload;
}

async function readConnectSkillDescriptors(): Promise<ConnectSkillDescriptor[]> {
  try {
    const parsed = connectSkillsEnvelopeSchema.safeParse(
      await serverGet("/experimental/connect/skills"),
    );
    return parsed.success ? parsed.data.skills : [];
  } catch {
    return [];
  }
}

async function readEngineMcpDescriptors(
  client: OpenWorkEngineMcpStatusClient | undefined,
  directory: string | undefined,
): Promise<EngineMcpDescriptor[]> {
  if (!client) return [];
  try {
    const result = await client.mcp.status(directory ? { query: { directory } } : undefined);
    const payload = isRecord(result) && result.data !== undefined ? result.data : result;
    if (!isRecord(payload)) return [];
    return Object.entries(payload).map(([name, entry]) => {
      const status = typeof entry === "string"
        ? entry
        : optionalStringProperty(entry, "status");
      return status ? { name, status } : { name };
    });
  } catch {
    return [];
  }
}

async function readOpenworkAgentContext(
  engineMcpStatusClient: OpenWorkEngineMcpStatusClient | undefined,
  engineMcpStatusDirectory: string | undefined,
): Promise<Record<string, unknown>> {
  const [uiResult, skills, mcps] = await Promise.all([
    uiBridgeRequest("/context"),
    readConnectSkillDescriptors(),
    readEngineMcpDescriptors(engineMcpStatusClient, engineMcpStatusDirectory),
  ]);
  const contributions = buildOpenworkProviderContributions(skills, mcps);
  const providerAffordances = contributions.flatMap((contribution) => contribution.affordances);
  const uiContext = isRecord(uiResult) && isRecord(uiResult.context) ? uiResult.context : null;
  if (!uiContext) {
    return {
      ok: true,
      context: null,
      ui: uiResult,
      availableAffordances: providerAffordances,
      contributions,
    };
  }
  const uiAffordances = Array.isArray(uiContext.availableAffordances)
    ? uiContext.availableAffordances
    : [];
  return {
    ok: true,
    context: {
      ...uiContext,
      availableAffordances: [...uiAffordances, ...providerAffordances],
      contributions,
    },
  };
}

async function queryOpenworkAffordance(rawArgs: unknown): Promise<unknown> {
  const request = openworkAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "session.search") {
    return affordanceResult(
      request.id,
      await searchOpenWorkSessions(request.args ?? {}),
      affordanceReadEffects,
    );
  }
  if (request.id === "session.read") {
    return affordanceResult(
      request.id,
      await readOpenWorkSession(request.args ?? {}),
      affordanceReadEffects,
    );
  }
  if (request.id === "extension.actions") {
    const args = listActionsArgsSchema.parse(request.args ?? {});
    const query = args.extensionId ? `?extensionId=${encodeURIComponent(args.extensionId)}` : "";
    return affordanceResult(
      request.id,
      await serverGet(`/experimental/extensions/actions${query}`),
      affordanceReadEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in openwork_context.",
    );
  }
  const result = await uiBridgeRequest("/query", {
    method: "POST",
    body: request,
  });
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "OpenWork UI query returned an invalid response.");
}

async function executeOpenworkAffordance(
  rawArgs: unknown,
  context: OpenCodeContext,
): Promise<unknown> {
  const request = openworkAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "session.create") {
    return affordanceResult(
      request.id,
      await createOpenWorkSessions(request.args ?? {}, context),
      affordanceWriteEffects,
    );
  }
  if (request.id === "automation.propose") {
    return affordanceResult(
      request.id,
      proposeAutomation(request.args ?? {}, context),
      affordanceProposalEffects,
    );
  }
  if (request.id === "extension.call") {
    const args = callArgsSchema.parse(request.args ?? {});
    return affordanceResult(
      request.id,
      await postJson("/experimental/extensions/call", {
        extensionId: args.extensionId,
        action: args.action,
        args: args.args ?? {},
        context: contextPayload(context),
      }),
      affordanceExternalWriteEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in openwork_context.",
    );
  }
  const result = await uiBridgeRequest("/command", {
    method: "POST",
    body: request,
  });
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "OpenWork UI command returned an invalid response.");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function buildSessionSnippet(text: string, index: number, length: number): SessionSearchSnippet {
  const start = Math.max(0, index - SESSION_SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SESSION_SNIPPET_AFTER);
  const before = `${start > 0 ? "..." : ""}${collapseWhitespace(text.slice(start, index)).trimStart()}`;
  const after = `${collapseWhitespace(text.slice(index + length, end)).trimEnd()}${end < text.length ? "..." : ""}`;
  return { before, match: text.slice(index, index + length), after };
}

function workspaceLabel(workspace: OpenWorkWorkspace): string {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || workspace.id;
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.id;
}

function sessionUpdatedAt(session: SessionInfo): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function messageText(message: SessionMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    if (part.synthetic || part.ignored) continue;
    const text = part.text?.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function findTextMatch(text: string, queryLower: string): { index: number; length: number } | null {
  const lower = text.toLowerCase();
  const exact = lower.indexOf(queryLower);
  if (exact >= 0) return { index: exact, length: queryLower.length };

  const terms = queryLower.split(/\s+/).filter((term) => term.length > 1);
  if (terms.length < 2) return null;

  let firstIndex = Number.POSITIVE_INFINITY;
  let firstLength = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index < 0) return null;
    if (index < firstIndex) {
      firstIndex = index;
      firstLength = term.length;
    }
  }
  return Number.isFinite(firstIndex) ? { index: firstIndex, length: firstLength } : null;
}

function titleSearchResult(workspace: OpenWorkWorkspace, session: SessionInfo, queryLower: string): SessionSearchResult | null {
  const title = sessionTitle(session);
  const text = `${title} ${workspaceLabel(workspace)}`;
  const match = findTextMatch(text, queryLower);
  if (!match) return null;
  return {
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    sessionId: session.id,
    title,
    updatedAt: sessionUpdatedAt(session),
    kind: "title",
    snippet: buildSessionSnippet(text, match.index, match.length),
  };
}

function messageSearchResult(workspace: OpenWorkWorkspace, session: SessionInfo, messages: SessionMessage[], queryLower: string): SessionSearchResult | null {
  let fallback: SessionSearchResult | null = null;
  for (const [index, message] of messages.entries()) {
    const role = message.info.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    const match = findTextMatch(text, queryLower);
    if (!match) continue;
    const result: SessionSearchResult = {
      workspaceId: workspace.id,
      workspace: workspaceLabel(workspace),
      sessionId: session.id,
      title: sessionTitle(session),
      updatedAt: sessionUpdatedAt(session),
      kind: "message",
      role,
      messageId: message.info.id,
      messageIndex: index,
      snippet: buildSessionSnippet(text, match.index, match.length),
    };
    if (role === "user") return result;
    if (!fallback) fallback = result;
  }
  return fallback;
}

async function listOpenWorkWorkspaces(): Promise<OpenWorkWorkspace[]> {
  return workspaceListEnvelopeSchema.parse(await serverGet("/workspaces")).items;
}

function filterWorkspaces(workspaces: OpenWorkWorkspace[], workspaceId?: string): OpenWorkWorkspace[] {
  const query = workspaceId?.trim().toLowerCase();
  if (!query) return workspaces;
  return workspaces.filter((workspace) => {
    const labels = [workspace.id, workspace.name, workspace.displayName, workspace.path]
      .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
      .map((label) => label.trim().toLowerCase());
    return labels.includes(query);
  });
}

async function listWorkspaceSessions(workspace: OpenWorkWorkspace, limit: number): Promise<SessionInfo[]> {
  const query = new URLSearchParams({ roots: "true", limit: String(limit) });
  return z.array(sessionInfoSchema).parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/opencode/session?${query.toString()}`),
  );
}

// The removed wrapper route validated that a session actually belongs to the
// requested workspace before exposing it (requireWorkspaceSession). The native
// engine route only scopes the upstream request, so a caller supplying a
// foreign session ID would otherwise read cross-workspace transcript data.
async function assertSessionInWorkspace(workspace: OpenWorkWorkspace, session: SessionInfo): Promise<void> {
  const workspacePath = workspace.path?.trim();
  const sessionDirectory = session.directory?.trim();
  if (!workspacePath || !sessionDirectory) return;
  const [root, dir] = await Promise.all([
    realpath(workspacePath).catch(() => workspacePath),
    realpath(sessionDirectory).catch(() => sessionDirectory),
  ]);
  const normalizedRoot = normalizeDirPath(root);
  const normalizedDir = normalizeDirPath(dir);
  if (normalizedDir === normalizedRoot || normalizedDir.startsWith(`${normalizedRoot}/`)) return;
  throw new Error(`Session ${session.id} not found in workspace ${workspaceLabel(workspace)}`);
}

async function readWorkspaceSession(workspace: OpenWorkWorkspace, sessionId: string): Promise<SessionInfo> {
  const session = sessionInfoSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/opencode/session/${encodeURIComponent(sessionId)}`),
  );
  await assertSessionInWorkspace(workspace, session);
  return session;
}

async function readSessionMessages(workspace: OpenWorkWorkspace, sessionId: string, limit: number): Promise<SessionMessage[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  return z.array(sessionMessageSchema).parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/opencode/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`),
  );
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => worker()));
}

async function searchOpenWorkSessions(rawArgs: unknown): Promise<object> {
  const args = sessionSearchArgsSchema.parse(rawArgs);
  const resultLimit = args.limit ?? SESSION_SEARCH_DEFAULT_LIMIT;
  const scanLimit = args.scanLimit ?? SESSION_SEARCH_DEFAULT_SCAN_LIMIT;
  const messageLimit = args.messageLimit ?? SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT;
  const queryLower = args.query.trim().toLowerCase();
  const workspaces = filterWorkspaces(await listOpenWorkWorkspaces(), args.workspaceId);
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No OpenWork workspaces are available" };
  }

  const sessions: Array<{ workspace: OpenWorkWorkspace; session: SessionInfo }> = [];
  const workspaceErrors: Array<{ workspaceId: string; workspace: string; error: string }> = [];
  await Promise.all(workspaces.map(async (workspace) => {
    try {
      const items = await listWorkspaceSessions(workspace, scanLimit);
      for (const session of items) sessions.push({ workspace, session });
    } catch (error) {
      workspaceErrors.push({ workspaceId: workspace.id, workspace: workspaceLabel(workspace), error: unknownErrorMessage(error) });
    }
  }));

  const sessionsToScan = sessions
    .sort((left, right) => sessionUpdatedAt(right.session) - sessionUpdatedAt(left.session))
    .slice(0, scanLimit);
  const matches: SessionSearchResult[] = [];

  await forEachWithConcurrency(sessionsToScan, SESSION_SEARCH_CONCURRENCY, async ({ workspace, session }) => {
    const titleMatch = titleSearchResult(workspace, session, queryLower);
    try {
      const messages = await readSessionMessages(workspace, session.id, messageLimit);
      const messageMatch = messageSearchResult(workspace, session, messages, queryLower);
      if (messageMatch) matches.push(messageMatch);
      else if (titleMatch) matches.push(titleMatch);
    } catch {
      if (titleMatch) matches.push(titleMatch);
    }
  });

  const results = matches
    .filter((match) => match !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    ok: true,
    query: args.query,
    workspaceCount: workspaces.length,
    totalCandidateSessions: sessions.length,
    scannedSessions: sessionsToScan.length,
    scanLimit,
    messageLimit,
    resultLimit,
    workspaceErrors,
    truncated: sessions.length > sessionsToScan.length || results.length > resultLimit,
    results: results.slice(0, resultLimit),
  };
}

async function readOpenWorkSession(rawArgs: unknown): Promise<object> {
  const args = sessionReadArgsSchema.parse(rawArgs);
  const count = args.count ?? 30;
  const workspaces = filterWorkspaces(await listOpenWorkWorkspaces(), args.workspaceId);
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No OpenWork workspaces are available" };
  }

  for (const workspace of workspaces) {
    try {
      const session = await readWorkspaceSession(workspace, args.sessionId);
      const messages = await readSessionMessages(workspace, args.sessionId, count);
      const readable = messages
        .map((message, index) => ({
          index,
          id: message.info.id,
          role: message.info.role,
          text: messageText(message),
        }))
        .filter((message) => message.text.trim().length > 0);
      return {
        ok: true,
        workspaceId: workspace.id,
        workspace: workspaceLabel(workspace),
        sessionId: session.id,
        title: sessionTitle(session),
        updatedAt: sessionUpdatedAt(session),
        returned: readable.length,
        requested: count,
        messages: readable,
      };
    } catch {
      if (args.workspaceId) break;
    }
  }

  return { ok: false, error: `Session ${args.sessionId} was not found in matching OpenWork workspaces` };
}

function serverUrl(): string {
  return String(process.env.OPENWORK_SERVER_URL || "").replace(/\/$/, "");
}

function serverToken(): string {
  return String(process.env.OPENWORK_SERVER_TOKEN || "");
}

function requireOpenWorkServer(): { url: string; token: string } {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token) {
    throw new Error("OpenWork extension tools are only available when OpenCode is launched by OpenWork.");
  }
  return { url, token };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirPath(path: string): string {
  return path.replace(/\/+$/, "");
}

async function resolveContextWorkspace(workspaceId: string | undefined, context: OpenCodeContext): Promise<OpenWorkWorkspace> {
  const workspaces = await listOpenWorkWorkspaces();
  if (!workspaces.length) throw new Error("No OpenWork workspaces are available");
  if (workspaceId) {
    const match = filterWorkspaces(workspaces, workspaceId).at(0);
    if (!match) throw new Error(`No workspace matched ${workspaceId}`);
    return match;
  }
  const directory = context.worktree?.trim() || context.directory?.trim();
  if (directory) {
    const dir = normalizeDirPath(directory);
    const match = workspaces
      .filter((workspace) => {
        const path = workspace.path?.trim();
        if (!path) return false;
        const root = normalizeDirPath(path);
        return dir === root || dir.startsWith(`${root}/`);
      })
      .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))
      .at(0);
    if (match) return match;
  }
  const only = workspaces.at(0);
  if (workspaces.length === 1 && only) return only;
  throw new Error(`Multiple OpenWork workspaces match; pass workspaceId. Available: ${workspaces.map((workspace) => workspaceLabel(workspace)).join(", ")}`);
}

async function createOpenWorkSessions(rawArgs: unknown, context: OpenCodeContext): Promise<object> {
  const args = sessionCreateArgsSchema.parse(rawArgs);
  const workspace = await resolveContextWorkspace(args.workspaceId, context);
  const results = await Promise.all(args.sessions.map(async (session): Promise<CreatedOpenWorkSessionResult | FailedOpenWorkSessionResult> => {
    try {
      const payload = sessionInfoSchema.parse(await postJson(
        `/workspace/${encodeURIComponent(workspace.id)}/opencode/session`,
        { title: session.title },
      ));
      await postJson(
        `/workspace/${encodeURIComponent(workspace.id)}/opencode/session/${encodeURIComponent(payload.id)}/prompt_async`,
        { parts: [{ type: "text", text: session.prompt }] },
      );
      return {
        ok: true,
        sessionId: payload.id,
        title: payload.title?.trim() || session.title,
        started: true,
        route: `/workspace/${encodeURIComponent(workspace.id)}/session/${encodeURIComponent(payload.id)}`,
      };
    } catch (error) {
      return {
        ok: false,
        title: session.title,
        error: unknownErrorMessage(error),
      };
    }
  }));
  const created = results.filter((result): result is CreatedOpenWorkSessionResult => result.ok);
  const failures = results.filter((result): result is FailedOpenWorkSessionResult => !result.ok);
  return {
    ok: failures.length === 0,
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    created,
    failures,
  };
}

/**
 * Validates a proposed Automation and hands it back for the renderer to show.
 *
 * Deliberately does no I/O. Automations are active from the moment they exist,
 * and the Den credential lives in the renderer, so an agent can describe an
 * Automation but only a person can create one.
 */
function proposeAutomation(rawArgs: unknown, context: OpenCodeContext): object {
  const { workspaceId: _modelSupplied, ...parsed } = automationProposalSchema.parse(rawArgs);
  // Pin the proposing conversation's workspace so the Automation keeps running
  // there even after the person activates a different workspace. The pin comes
  // from the engine-provided context only: a model-supplied workspaceId is
  // discarded so a prompt-injected agent cannot retarget the Automation to a
  // workspace the person is not looking at.
  const workspaceId = context.workspaceId ?? context.workspaceID;
  const proposal = workspaceId ? { ...parsed, workspaceId } : parsed;
  return {
    ok: true,
    kind: "automation-proposal",
    proposal,
    created: false,
    limitation: "This Desktop proposal creates Desktop placement and runs only while a signed-in desktop runner is connected. Use Web or Cloud Chat to create headless Cloud placement.",
  };
}

async function postJson(path: string, body: ExtensionActionPayload | Record<string, unknown>): Promise<unknown> {
  const { url, token } = requireOpenWorkServer();
  const response = await fetch(url + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, "OpenWork extension call failed"));
  }
  return payload;
}

function contextPayload(context: OpenCodeContext) {
  return {
    agent: context.agent,
    sessionId: context.sessionID,
    messageId: context.messageID,
    workspaceId: context.workspaceId ?? context.workspaceID,
    directory: context.directory,
    worktree: context.worktree,
  };
}

export const OpenWorkExtensionsPreview = async (factoryInput?: unknown) => {
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  const engineMcpStatusClient = readEngineMcpStatusClient(factoryInput);
  const engineMcpStatusDirectory = factoryContext.directory ?? factoryContext.worktree;
  return {
  "tool.execute.after": async (_input: unknown, output: unknown) => {
    // OpenCode 1.17.x keeps the text projection of an MCP result but drops
    // structuredContent and result _meta before persisting the completed tool
    // part. Preserve those standard fields in the existing metadata channel
    // so OpenWork can host the UI without replaying the tool call.
    preserveMcpResult(output);
  },
  "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
    const mergedInput = mergeTransformInputWithFactoryContext(input, factoryContext);
    const [extensionInstruction, skillInstruction, automationInstruction] = await Promise.all([
      resolveOpenWorkExtensionDiscoveryInstruction(mergedInput, fetch, {
        client: engineMcpStatusClient,
        directory: engineMcpStatusDirectory,
      }),
      resolveOpenWorkConnectSkillInstruction(mergedInput, fetch),
      resolveOpenWorkAutomationInstruction(mergedInput, fetch),
    ]);
    const skillAuthoring = composeSkillAuthoringInstruction(extensionInstruction);
    if (process.env.OPENWORK_DEV_MODE === "1") {
      console.log("[openwork:skill-authoring] system prompt selected", {
        mode: skillAuthoring.mode,
        prompt: skillAuthoring.prompt,
        directory: normalizeOpenCodeContext(mergedInput).directory ?? factoryContext.directory ?? null,
      });
    }
    // One section id per concern — composition drops empties/duplicates so routing,
    // remote skills, session, and browser guidance never overlap by accident.
    output.system.push(...composeAgentInstructions(
      createInstructionSection("routing", extensionInstruction),
      createInstructionSection("agent-surface", OPENWORK_AGENT_SURFACE_INSTRUCTION),
      createInstructionSection("skill-authoring", skillAuthoring.prompt),
      createInstructionSection("connect-skills", skillInstruction),
      createInstructionSection("automations", automationInstruction),
      createInstructionSection("browser", OPENWORK_BROWSER_INSTRUCTION),
    ));
  },
  tool: {
    openwork_context: {
      description: "Read one semantic snapshot of OpenWork: current screen, retained conversation tabs, split view and focused pane, sidebar and side panel state, settings panel, provider contributions, remote skill guidance, and available affordances with explicit effects and executors.",
      args: {},
      async execute() {
        return JSON.stringify(
          await readOpenworkAgentContext(engineMcpStatusClient, engineMcpStatusDirectory),
          null,
          2,
        );
      },
    },
    openwork_query: {
      description: "Run a side-effect-free OpenWork affordance whose executor is OpenWork. Use the exact id and arguments from openwork_context. This reads backend or app state without navigation or window focus.",
      args: openworkAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown) {
        return JSON.stringify(await queryOpenworkAffordance(rawArgs), null, 2);
      },
    },
    openwork_execute: {
      description: "Execute an OpenWork command whose executor is OpenWork without activating the desktop window. Use the exact id and arguments from openwork_context, and pass expectedRevision for UI commands to prevent stale writes. If the descriptor names another executor tool, call that tool instead.",
      args: openworkAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const mergedContext = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        return JSON.stringify(await executeOpenworkAffordance(rawArgs, mergedContext), null, 2);
      },
    },
  },
  };
};
