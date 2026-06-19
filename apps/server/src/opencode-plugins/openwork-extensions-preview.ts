import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { z } from "zod";

type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
};

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
  action: z.string().describe("Action id from openwork_extension_list_actions."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the action."),
});

const uiExecuteArgsSchema = z.object({
  actionId: z.string().describe("The action id from openwork_ui_list_actions, e.g. 'settings.panel.open' or 'composer.set_text'."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the action, if required."),
});

const browserOpenUrlArgsSchema = z.object({
  url: z.string().describe("The website URL to open in the OpenWork built-in browser."),
  provider: z.enum(["auto", "builtin", "external"]).optional().describe("Browser provider. Use builtin or auto; external is reserved for future support."),
});

const browserSetProxyArgsSchema = z.object({
  proxy: z.string().describe("Proxy URL like http://user:pass@host:8080 or socks5://host:1080. Prefer env:NAME (resolves the OPENWORK_BROWSER_PROXY_NAME environment variable on the user's machine) so credentials never enter the conversation."),
});

const OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check OpenWork extensions before saying the capability is unavailable. Use openwork_extension_list_actions to inspect available extension actions, then call the matching action with openwork_extension_call.";

const OPENWORK_UI_CONTROL_INSTRUCTION =
  `IMPORTANT: You are running inside the OpenWork desktop app. When the user asks you to open settings, navigate the app, add providers, or control the OpenWork UI in any way, ALWAYS use the openwork_ui_* tools — NOT the browser_* tools. The browser tools are for external websites only. The openwork_ui_* tools control the app directly and are instant (one tool call).

To open settings: openwork_ui_execute_action with actionId "settings.panel.open" and args {panel:"general"} (or "ai", "extensions", "permissions", "skills", "appearance", etc.)
To add a provider: openwork_ui_execute_action with actionId "settings.provider.add" and optional args {providerId:"anthropic"}
To see what the user sees: openwork_ui_snapshot
To list all available actions: openwork_ui_list_actions
To ask what OpenWork can do: openwork_ui_execute_action with actionId "help.capabilities"

## Cross-session memory
When the user asks what they said, what happened, or what was decided in another OpenWork chat/session, treat it as a session-history lookup through the OpenWork UI, not hidden model memory.
Use openwork_ui_execute_action with actionId "session.list_sessions" to find matching sessions by title, workspace, topic, or session ID.
If there is one clear match, use actionId "session.open" with args {sessionId:"..."}, then use actionId "session.read_transcript" with args {count:30} to read recent messages.
Answer only from the returned transcript. If multiple sessions match, ask a short clarifying question. If the returned transcript is limited or missing the older context needed, say so instead of guessing.

Do NOT use browser_navigate, browser_click, or browser_snapshot to interact with the OpenWork app itself. Those are for browsing external websites.

## Built-in Browser (external websites)
For web browsing tasks, ALWAYS start with openwork_browser_open_url. It creates/selects a built-in OpenWork browser tab and returns browser_url plus target_id. Use that exact browser_url and target_id for every later browser_snapshot, browser_click, browser_fill, browser_eval, and browser_screenshot call.
Do not call browser_navigate without a target_id returned by openwork_browser_open_url. Do not use browser_* tools on the OpenWork app target (avoid targets with title "OpenWork" or URLs containing ":5173/#/").`;

// ── UI control bridge discovery ──

type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;

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

function addContext(payload: unknown, context: OpenCodeContext): object {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return Object.assign({}, payload, { context: contextPayload(context) });
  }
  return { payload, context: contextPayload(context) };
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

async function postJson(path: string, body: ExtensionActionPayload): Promise<unknown> {
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
    directory: context.directory,
    worktree: context.worktree,
  };
}

export const OpenWorkExtensionsPreview = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push(OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION);
    output.system.push(OPENWORK_UI_CONTROL_INSTRUCTION);
  },
  tool: {
    openwork_extension_list_actions: {
      description: `List extension actions currently exposed by OpenWork. ${OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION}`,
      args: listActionsArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = listActionsArgsSchema.parse(rawArgs);
        const query = args.extensionId ? `?extensionId=${encodeURIComponent(args.extensionId)}` : "";
        const { url, token } = requireOpenWorkServer();
        const response = await fetch(`${url}/experimental/extensions/actions${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await parseResponse(response);
        if (!response.ok) throw new Error(errorMessage(payload, "OpenWork extension action listing failed"));
        return JSON.stringify(addContext(payload, context), null, 2);
      },
    },
    openwork_extension_call: {
      description: `Call an OpenWork extension action. Use openwork_extension_list_actions first to inspect available actions and schemas. ${OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION}`,
      args: callArgsSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const args = callArgsSchema.parse(rawArgs);
        const payload = await postJson("/experimental/extensions/call", {
          extensionId: args.extensionId,
          action: args.action,
          args: args.args ?? {},
          context: contextPayload(context),
        });
        return JSON.stringify(payload, null, 2);
      },
    },
    openwork_ui_snapshot: {
      description: "Get a snapshot of the current OpenWork UI state: active route, narration, visible actions, and status. Use this to understand what the user sees before taking action.",
      args: {},
      async execute() {
        const result = await uiBridgeRequest("/snapshot");
        return JSON.stringify(result, null, 2);
      },
    },
    openwork_ui_list_actions: {
      description: `List all UI control actions currently available in OpenWork. Each action has an id you can pass to openwork_ui_execute_action. ${OPENWORK_UI_CONTROL_INSTRUCTION}`,
      args: {},
      async execute() {
        const result = await uiBridgeRequest("/actions");
        return JSON.stringify(result, null, 2);
      },
    },
    openwork_ui_execute_action: {
      description: `Execute an OpenWork UI action by its id. Use openwork_ui_list_actions first to see available actions. ${OPENWORK_UI_CONTROL_INSTRUCTION}`,
      args: uiExecuteArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const { actionId, args } = uiExecuteArgsSchema.parse(rawArgs);
        const result = await uiBridgeRequest("/execute", {
          method: "POST",
          body: { actionId, args: args ?? {} },
        });
        return JSON.stringify(result, null, 2);
      },
    },
    openwork_browser_open_url: {
      description: "Open a URL in the OpenWork built-in browser and return the exact CDP browser_url and target_id to use for browser_* automation tools. Always use this before browser_snapshot/click/fill/eval for web browsing tasks.",
      args: browserOpenUrlArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = browserOpenUrlArgsSchema.parse(rawArgs);
        const result = await uiBridgeRequest("/execute", {
          method: "POST",
          body: {
            actionId: "browser.open_url",
            args: { url: args.url, provider: args.provider ?? "builtin" },
          },
        });
        return JSON.stringify(result, null, 2);
      },
    },
    openwork_browser_set_proxy: {
      description: "Route all OpenWork built-in browser traffic through an HTTP/SOCKS proxy — for example to fetch search results or pages as seen from another location. Applies to every built-in browser tab (including browser_* automation) until cleared with openwork_browser_clear_proxy. If the user has named proxies configured as OPENWORK_BROWSER_PROXY_<NAME> environment variables, pass env:NAME instead of a raw URL.",
      args: browserSetProxyArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = browserSetProxyArgsSchema.parse(rawArgs);
        const result = await uiBridgeRequest("/execute", {
          method: "POST",
          body: { actionId: "browser.set_proxy", args: { proxy: args.proxy } },
        });
        return JSON.stringify(result, null, 2);
      },
    },
    openwork_browser_clear_proxy: {
      description: "Clear the OpenWork built-in browser proxy and restore the system network settings.",
      args: {},
      async execute() {
        const result = await uiBridgeRequest("/execute", {
          method: "POST",
          body: { actionId: "browser.set_proxy", args: { proxy: "" } },
        });
        return JSON.stringify(result, null, 2);
      },
    },
  },
});
