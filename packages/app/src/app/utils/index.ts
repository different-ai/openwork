import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
  MessageGroup,
  MessageInfo,
  MessageWithParts,
  ModelRef,
  OpencodeEvent,
  PlaceholderAssistantMessage,
  ProviderListItem,
} from "../types";
import type { WorkspaceInfo } from "../lib/tauri";

export function formatModelRef(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`;
}

export function parseModelRef(raw: string | null): ModelRef | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [providerID, ...rest] = trimmed.split("/");
  if (!providerID || rest.length === 0) return null;
  return { providerID, modelID: rest.join("/") };
}

export function modelEquals(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

const FRIENDLY_PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
};

const humanizeModelLabel = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized && FRIENDLY_PROVIDER_LABELS[normalized]) {
    return FRIENDLY_PROVIDER_LABELS[normalized];
  }

  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return value;

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/\d/.test(word) || word.length <= 3) {
        return word.toUpperCase();
      }
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
};

export function formatModelLabel(model: ModelRef, providers: ProviderListItem[] = []) {
  const provider = providers.find((p) => p.id === model.providerID);
  const modelInfo = provider?.models?.[model.modelID];

  const providerLabel = provider?.name ?? humanizeModelLabel(model.providerID);
  const modelLabel = modelInfo?.name ?? humanizeModelLabel(model.modelID);

  return `${providerLabel} · ${modelLabel}`;
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ != null;
}

export function isWindowsPlatform() {
  if (typeof navigator === "undefined") return false;

  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const platform =
    typeof (navigator as any).userAgentData?.platform === "string"
      ? (navigator as any).userAgentData.platform
      : typeof navigator.platform === "string"
        ? navigator.platform
        : "";

  return /windows/i.test(platform) || /windows/i.test(ua);
}

const STARTUP_PREF_KEY = "openwork.startupPref";
const LEGACY_PREF_KEY = "openwork.modePref";
const LEGACY_PREF_KEY_ALT = "openwork_mode_pref";

export function readStartupPreference(): "local" | "server" | null {
  if (typeof window === "undefined") return null;

  try {
    const pref =
      window.localStorage.getItem(STARTUP_PREF_KEY) ??
      window.localStorage.getItem(LEGACY_PREF_KEY) ??
      window.localStorage.getItem(LEGACY_PREF_KEY_ALT);

    if (pref === "local" || pref === "server") return pref;
    if (pref === "host") return "local";
    if (pref === "client") return "server";
  } catch {
    // ignore
  }

  return null;
}

export function writeStartupPreference(nextPref: "local" | "server") {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STARTUP_PREF_KEY, nextPref);
    window.localStorage.removeItem(LEGACY_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY_ALT);
  } catch {
    // ignore
  }
}

export function clearStartupPreference() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(STARTUP_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY_ALT);
  } catch {
    // ignore
  }
}

export function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "<circular>";
          }
          seen.add(val as object);
        }

        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "reasoningencryptedcontent" ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("access_token") ||
          lowerKey.includes("refresh_token") ||
          lowerKey.includes("token") ||
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("secret")
        ) {
          return "[redacted]";
        }

        return val;
      },
      2,
    );
  } catch {
    return "<unserializable>";
  }
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  const rounded = idx === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

export function normalizeDirectoryPath(input?: string | null) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const unified = trimmed.replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  const normalized = withoutTrailing || "/";
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized;
}

export function normalizeEvent(raw: unknown): OpencodeEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties,
    };
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties,
      };
    }
  }

  return null;
}

export function formatRelativeTime(timestampMs: number) {
  const delta = Date.now() - timestampMs;

  if (delta < 0) {
    return "just now";
  }

  if (delta < 60_000) {
    return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  }

  if (delta < 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  }

  if (delta < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / (60 * 60_000)))}h ago`;
  }

  return new Date(timestampMs).toLocaleDateString();
}

export function commandPathFromWorkspaceRoot(workspaceRoot: string, commandName: string) {
  const root = workspaceRoot.trim().replace(/\/+$/, "");
  const name = commandName.trim().replace(/^\/+/, "");
  if (!root || !name) return null;
  return `${root}/.opencode/commands/${name}.md`;
}

export function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function addOpencodeCacheHint(message: string) {
  const lower = message.toLowerCase();
  const cacheSignals = [
    ".cache/opencode",
    "library/caches/opencode",
    "appdata/local/opencode",
    "fetch_jwks.js",
    "opencode cache",
  ];

  if (cacheSignals.some((signal) => lower.includes(signal)) && lower.includes("enoent")) {
    return `${message}\n\nOpenCode cache looks corrupted. Use Repair cache in Settings to rebuild it.`;
  }

  return message;
}

const SANDBOX_DOCKER_OFFLINE_HINTS = [
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "docker daemon",
  "docker desktop",
  "docker engine",
  "error during connect",
  "docker.sock",
  "docker_socket",
  "open //./pipe/docker_engine",
];

const SANDBOX_NETWORK_HINTS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "request timed out",
  "timeout",
  "connection refused",
  "econnrefused",
  "connection reset",
  "socket hang up",
  "enotfound",
  "getaddrinfo",
  "could not connect",
];

export function isSandboxWorkspace(workspace: WorkspaceInfo) {
  return (
    workspace.workspaceType === "remote" &&
    (workspace.sandboxBackend === "docker" ||
      Boolean(workspace.sandboxRunId?.trim()) ||
      Boolean(workspace.sandboxContainerName?.trim()))
  );
}

export function getWorkspaceTaskLoadErrorDisplay(workspace: WorkspaceInfo, error?: string | null) {
  const raw = error?.trim() ?? "";
  const fallbackTitle = raw || "Failed to load tasks";
  if (!raw || !isSandboxWorkspace(workspace)) {
    return {
      tone: "error" as const,
      label: "Error",
      message: "Failed to load tasks",
      title: fallbackTitle,
    };
  }

  const normalized = raw.toLowerCase();
  const hasDockerHint = SANDBOX_DOCKER_OFFLINE_HINTS.some((hint) => normalized.includes(hint));
  const hasNetworkHint = SANDBOX_NETWORK_HINTS.some((hint) => normalized.includes(hint));
  const host = `${workspace.baseUrl ?? ""} ${workspace.openworkHostUrl ?? ""}`.toLowerCase();
  const localHost = host.includes("localhost") || host.includes("127.0.0.1");

  if (!hasDockerHint && !(localHost && hasNetworkHint)) {
    return {
      tone: "error" as const,
      label: "Error",
      message: "Failed to load tasks",
      title: fallbackTitle,
    };
  }

  const message = "Sandbox is offline. Start Docker Desktop, then test connection.";
  return {
    tone: "offline" as const,
    label: "Offline",
    message,
    title: `${message}\n\n${raw}`,
  };
}

export function parseTemplateFrontmatter(raw: string) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  const header = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).replace(/^\r?\n/, "");
  const data: Record<string, string> = {};

  const unescapeValue = (value: string) => {
    if (value.startsWith("\"") && value.endsWith("\"")) {
      const inner = value.slice(1, -1);
      return inner.replace(/\\(\\|\"|n|r|t)/g, (_match, code) => {
        switch (code) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          case "\\":
            return "\\";
          case "\"":
            return "\"";
          default:
            return code;
        }
      });
    }

    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }

    return value;
  };

  for (const line of header.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) continue;
    const key = entry.slice(0, colonIndex).trim();
    let value = entry.slice(colonIndex + 1).trim();
    if (!key) continue;
    value = unescapeValue(value);
    data[key] = value;
  }

  return { data, body };
}

export function upsertSession(list: Session[], next: Session) {
  const idx = list.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...list, next];

  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export function upsertMessage(list: MessageWithParts[], nextInfo: MessageInfo) {
  const idx = list.findIndex((m) => m.info.id === nextInfo.id);
  if (idx === -1) {
    return list.concat({ info: nextInfo, parts: [] });
  }

  const copy = list.slice();
  copy[idx] = { ...copy[idx], info: nextInfo };
  return copy;
}

export function upsertPart(list: MessageWithParts[], nextPart: Part) {
  const msgIdx = list.findIndex((m) => m.info.id === nextPart.messageID);
  if (msgIdx === -1) {
    // avoids missing streaming events before message.updated
    const placeholder: PlaceholderAssistantMessage = {
      id: nextPart.messageID,
      sessionID: nextPart.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return list.concat({ info: placeholder, parts: [nextPart] });
  }

  const copy = list.slice();
  const msg = copy[msgIdx];
  const parts = msg.parts.slice();
  const partIdx = parts.findIndex((p) => p.id === nextPart.id);

  if (partIdx === -1) {
    parts.push(nextPart);
  } else {
    parts[partIdx] = nextPart;
  }

  copy[msgIdx] = { ...msg, parts };
  return copy;
}

export function removePart(list: MessageWithParts[], messageID: string, partID: string) {
  const msgIdx = list.findIndex((m) => m.info.id === messageID);
  if (msgIdx === -1) return list;

  const copy = list.slice();
  const msg = copy[msgIdx];
  copy[msgIdx] = { ...msg, parts: msg.parts.filter((p) => p.id !== partID) };
  return copy;
}

export function normalizeSessionStatus(status: unknown) {
  if (!status || typeof status !== "object") return "idle";
  const record = status as Record<string, unknown>;
  if (record.type === "busy") return "running";
  if (record.type === "retry") return "retry";
  if (record.type === "idle") return "idle";
  return "idle";
}

export function modelFromUserMessage(info: MessageInfo): ModelRef | null {
  if (!info || typeof info !== "object") return null;
  if ((info as any).role !== "user") return null;

  const model = (info as any).model as unknown;
  if (!model || typeof model !== "object") return null;

  const providerID = (model as any).providerID;
  const modelID = (model as any).modelID;

  if (typeof providerID !== "string" || typeof modelID !== "string") return null;
  return { providerID, modelID };
}

export function lastUserModelFromMessages(list: MessageWithParts[]): ModelRef | null {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const model = modelFromUserMessage(list[i]?.info);
    if (model) return model;
  }

  return null;
}

export function isStepPart(part: Part) {
  return part.type === "reasoning" || part.type === "tool";
}

export function groupMessageParts(parts: Part[], messageId: string): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const steps: Part[] = [];
  let textBuffer = "";
  let stepGroupIndex = 0;
  let sawExecution = false;

  const flushText = () => {
    if (!textBuffer) return;
    groups.push({
      kind: "text",
      part: { type: "text", text: textBuffer } as Part,
      segment: sawExecution ? "result" : "intent",
    });
    textBuffer = "";
  };

  const flushSteps = () => {
    if (!steps.length) return;
    groups.push({
      kind: "steps",
      id: `steps-${messageId}-${stepGroupIndex}`,
      parts: steps.splice(0, steps.length),
      segment: "execution",
    });
    stepGroupIndex += 1;
    sawExecution = true;
  };

  parts.forEach((part) => {
    if (part.type === "text") {
      flushSteps();
      textBuffer += (part as { text?: string }).text ?? "";
      return;
    }

    if (part.type === "agent") {
      flushSteps();
      const name = (part as { name?: string }).name ?? "";
      textBuffer += name ? `@${name}` : "@agent";
      return;
    }

    if (part.type === "file") {
      flushSteps();
      flushText();
      groups.push({ kind: "text", part, segment: sawExecution ? "result" : "intent" });
      return;
    }

    if (part.type === "step-start" || part.type === "step-finish") {
      return;
    }

    flushText();

    if (part.type === "reasoning" && steps.length > 0) {
      flushSteps();
    }

    steps.push(part);
  });

  flushText();

  flushSteps();

  return groups;
}

/** Classify a tool name into a semantic category for icon selection */
export function classifyTool(toolName: string): "read" | "edit" | "write" | "search" | "terminal" | "glob" | "task" | "skill" | "tool" {
  const lower = toolName.toLowerCase();
  if (lower === "skill") return "skill";
  if (lower.includes("read") || lower.includes("cat") || lower.includes("fetch")) return "read";
  if (lower === "apply_patch") return "write";
  if (lower.includes("edit") || lower.includes("replace") || lower.includes("update")) return "edit";
  if (lower.includes("write") || lower.includes("create") || lower.includes("patch")) return "write";
  if (lower.includes("grep") || lower.includes("search") || lower.includes("find")) return "search";
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec") || lower.includes("command") || lower.includes("run")) return "terminal";
  if (lower.includes("glob") || lower.includes("list") || lower.includes("ls")) return "glob";
  if (lower.includes("task") || lower.includes("agent") || lower.includes("todo")) return "task";
  return "tool";
}

/** Extract a clean filename from a file path */
function extractFilename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function normalizeStepText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function cleanReasoningText(value: string): string {
  return value
    .replace(/\[REDACTED\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function truncateStepText(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function isPathLike(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|~[\\/]|\/|\.\.?[\\/])/.test(value) || /[\\/]/.test(value);
}

function normalizePathToken(value: string): string {
  const clean = value.trim().replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
  if (!isPathLike(clean)) return clean;
  return extractFilename(clean);
}

function getToolInput(state: any): Record<string, unknown> {
  const input = state?.input;
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function pickInputText(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    const text = normalizeStepText(value);
    if (text) return text;
  }
  return "";
}

function buildToolTitle(state: any, toolName: string): string {
  const lower = toolName.toLowerCase();
  const input = getToolInput(state);
  const pick = (...keys: string[]) => pickInputText(input, keys);
  const file = (...keys: string[]) => {
    const value = pick(...keys);
    if (!value) return "";
    return normalizePathToken(value);
  };

  if (lower === "read") {
    const target = file("filePath", "path", "file");
    return target ? `Read ${target}` : "Read file";
  }

  if (lower === "edit") {
    const target = file("filePath", "path", "file");
    return target ? `Edit ${target}` : "Edit file";
  }

  if (lower === "write") {
    const target = file("filePath", "path", "file");
    return target ? `Write ${target}` : "Write file";
  }

  if (lower === "apply_patch") {
    return "Apply patch";
  }

  if (lower === "list") {
    const target = file("path");
    return target ? `List ${target}` : "List files";
  }

  if (lower === "grep" || lower === "glob") {
    const pattern = pick("pattern", "query");
    return pattern ? `Search ${truncateStepText(pattern, 44)}` : "Search code";
  }

  if (lower === "bash") {
    const description = pick("description");
    if (description) return truncateStepText(description, 56);
    const command = pick("command", "cmd");
    if (command) return truncateStepText(`Run ${command}`, 56);
    return "Run command";
  }

  if (lower === "task") {
    const description = pick("description");
    if (description) return truncateStepText(description, 56);
    const agent = pick("subagent_type");
    return agent ? `Delegate ${agent}` : "Delegate task";
  }

  if (lower === "webfetch") {
    const url = pick("url");
    return url ? `Fetch ${truncateStepText(url, 44)}` : "Fetch web page";
  }

  if (lower === "skill") {
    const name = pick("name");
    return name ? `Load skill ${name}` : "Load skill";
  }

  const stateTitle = normalizeStepText(state?.title);
  if (stateTitle) {
    return truncateStepText(isPathLike(stateTitle) ? normalizePathToken(stateTitle) : stateTitle, 56);
  }

  const fallback = normalizeStepText(toolName).replace(/[_-]+/g, " ");
  return fallback || "Tool";
}

/** Build a concise detail line for a tool call — avoids dumping raw output */
function buildToolDetail(state: any, toolName: string): string | undefined {
  const lower = toolName.toLowerCase();
  const input = getToolInput(state);
  const pick = (...keys: string[]) => pickInputText(input, keys);

  if (lower === "read") {
    const chunks: string[] = [];
    const offset = input.offset;
    const limit = input.limit;
    if (typeof offset === "number") chunks.push(`offset ${offset}`);
    if (typeof limit === "number") chunks.push(`limit ${limit}`);
    if (chunks.length > 0) return chunks.join(" - ");
    return undefined;
  }

  if (lower === "bash") {
    const command = pick("command", "cmd");
    if (command) return truncateStepText(command, 80);
  }

  if (lower === "grep" || lower === "glob") {
    const root = pick("path");
    if (root) return `in ${normalizePathToken(root)}`;
  }

  if (lower === "task") {
    const agent = pick("subagent_type");
    if (agent) return `${agent} agent`;
  }

  if (lower === "webfetch") {
    const url = pick("url");
    if (url) return truncateStepText(url, 80);
  }

  // For file operations, show the filename
  const filePath = state?.path ?? state?.file;
  if (typeof filePath === "string" && filePath.trim()) {
    const name = extractFilename(filePath.trim());
    const status = state?.status;
    if (status === "completed" || status === "done") {
      return name;
    }
    return name;
  }

  // For edits that report updated files, show filename(s)
  const files = state?.files;
  if (Array.isArray(files) && files.length > 0) {
    const names = files.filter((f: any) => typeof f === "string").map(extractFilename);
    if (names.length === 1) return names[0];
    if (names.length > 1) return `${names[0]} +${names.length - 1} more`;
  }

  // For bash/terminal commands, show the command
  const command = state?.command ?? state?.cmd;
  if (typeof command === "string" && command.trim()) {
    const clean = command.trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  }

  // For search/grep, show the pattern
  const pattern = state?.pattern ?? state?.query;
  if (typeof pattern === "string" && pattern.trim()) {
    return `"${pattern.trim().length > 60 ? pattern.trim().slice(0, 57) + "..." : pattern.trim()}"`;
  }

  // Subtitle/detail from state as fallback
  const subtitle = state?.subtitle ?? state?.detail ?? state?.summary;
  if (typeof subtitle === "string" && subtitle.trim()) {
    const clean = subtitle.trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  }

  // For completed tools with output, show a very short summary
  const outputRaw = typeof state?.output === "string" ? state.output.trim() : "";
  if (outputRaw) {
    if (lower === "read") return undefined;

    const output = outputRaw.length > 3000 ? outputRaw.slice(0, 3000) : outputRaw;

    // Extract just the first meaningful line (skip line numbers and raw file markers)
    const lines = output.split("\n").filter((l: string) => {
      const trimmed = l.trim();
      return (
        trimmed &&
        !trimmed.startsWith("<file>") &&
        !trimmed.startsWith("<path>") &&
        !trimmed.startsWith("<type>") &&
        !trimmed.startsWith("<content>") &&
        !trimmed.startsWith("</content>") &&
        !/^\d{5}\|/.test(trimmed) &&
        !/^\d+:\s/.test(trimmed)
      );
    });
    if (lines.length > 0) {
      const first = lines[0].trim();
      if (first.startsWith("Success")) {
        // "Success. Updated the following files: M foo.ts" -> "foo.ts"
        const match = first.match(/:\s*[MADR]\s+(.+)/);
        if (match) return extractFilename(match[1].trim());
        return "Done";
      }
      return first.length > 80 ? `${first.slice(0, 77)}...` : first;
    }
  }

  return undefined;
}

const ARTIFACT_PATH_PATTERN =
  /(?:^|[\s"'`([{])((?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|~[/\\]|[/\\])[\w./\\\-]*\.[a-z][a-z0-9]{0,9}|[\w.\-]+[/\\][\w./\\\-]*\.[a-z][a-z0-9]{0,9})/gi;
const ARTIFACT_OUTPUT_SCAN_LIMIT = 4000;
const ARTIFACT_OUTPUT_SKIP_TOOLS = new Set(["webfetch"]);

// Patterns that indicate a path is a truncated system/absolute path rather than a workspace-relative path
const TRUNCATED_SYSTEM_PATH_PATTERNS = [
  /com\.[^/]+\.(openwork|opencode)/i, // macOS app bundle identifiers
  /\.openwork\.dev\//i, // OpenWork dev paths
  /Application Support\//i, // macOS Application Support
  /AppData[/\\]/i, // Windows AppData
  /\.local\/share\//i, // Linux XDG data
  /workspaces\/[^/]+\/workspaces\//i, // Nested workspaces paths (clearly malformed)
];

/**
 * Clean up an artifact path to extract the workspace-relative portion.
 * Returns null if the path should be rejected entirely.
 */
function cleanArtifactPath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/[\\/]+/g, "/");
  if (!normalized) return null;

  // Check if this looks like a truncated system path
  for (const pattern of TRUNCATED_SYSTEM_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      // Try to extract just the relative part after "workspaces/<name>/"
      const workspacesMatch = normalized.match(/workspaces\/[^/]+\/(.+)$/i);
      if (workspacesMatch && workspacesMatch[1]) {
        const relative = workspacesMatch[1];
        // Validate the extracted path doesn't still contain system patterns
        if (!TRUNCATED_SYSTEM_PATH_PATTERNS.some((p) => p.test(relative))) {
          return relative;
        }
      }
      // Reject the path entirely if we can't extract a clean relative path
      return null;
    }
  }

  return normalized;
}

type DeriveArtifactsOptions = {
  maxMessages?: number;
};

export function summarizeStep(part: Part): { title: string; detail?: string; isSkill?: boolean; skillName?: string; toolCategory?: string; status?: string } {
  if (part.type === "tool") {
    const record = part as any;
    const toolName = record.tool ? String(record.tool) : "Tool";
    const state = record.state ?? {};
    const title = buildToolTitle(state, toolName);
    const category = classifyTool(toolName);
    const status = state.status ? String(state.status) : undefined;
    const detail = buildToolDetail(state, toolName);
    const normalizedTitle = normalizeStepText(title).toLowerCase();
    const finalDetail = detail && normalizeStepText(detail).toLowerCase() !== normalizedTitle ? detail : undefined;
    
    // Detect skill trigger
    if (category === "skill") {
      const skillName = state.metadata?.name || title.replace(/^(Loaded skill:\s*|Load skill\s+)/i, "");
      return { title, isSkill: true, skillName, detail: finalDetail, toolCategory: category, status };
    }
    
    return { title, detail: finalDetail, toolCategory: category, status };
  }

  if (part.type === "reasoning") {
    const record = part as any;
    const text = typeof record.text === "string" ? cleanReasoningText(record.text) : "";
    if (!text) return { title: "Thinking", toolCategory: "tool" };

    const lines = text
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean);
    const compact = lines.join(" ");

    let headline = "";
    let detail = "";
    if (lines.length > 1) {
      headline = lines[0];
      detail = lines.slice(1).join("\n");
    } else {
      const sentenceBreak = compact.indexOf(". ");
      if (sentenceBreak > 18 && sentenceBreak < 120) {
        headline = compact.slice(0, sentenceBreak + 1).trim();
        detail = compact.slice(sentenceBreak + 2).trim();
      } else {
        headline = compact;
        detail = compact;
      }
    }

    headline = headline.replace(/^thinking[:\s-]*/i, "").trim();
    const title = `Thinking: ${truncateStepText(headline || "reviewing context", 96)}`;
    return { title, detail: detail || undefined, toolCategory: "tool" };
  }

  if (part.type === "step-start" || part.type === "step-finish") {
    const reason = (part as any).reason;
    return {
      title: part.type === "step-start" ? "Step started" : "Step finished",
      detail: reason ? String(reason) : undefined,
      toolCategory: "tool",
    };
  }

  return { title: "Step", toolCategory: "tool" };
}

export function deriveArtifacts(list: MessageWithParts[], options: DeriveArtifactsOptions = {}): ArtifactItem[] {
  const results = new Map<string, ArtifactItem>();
  const maxMessages =
    typeof options.maxMessages === "number" && Number.isFinite(options.maxMessages) && options.maxMessages > 0
      ? Math.floor(options.maxMessages)
      : null;
  const source = maxMessages && list.length > maxMessages ? list.slice(list.length - maxMessages) : list;

  source.forEach((message) => {
    const messageId = String((message.info as any)?.id ?? "");

    message.parts.forEach((part) => {
      if (part.type !== "tool") return;
      const record = part as any;
      const state = record.state ?? {};
      const matches = new Set<string>();

      const explicit = [
        state.path,
        state.file,
        ...(Array.isArray(state.files) ? state.files : []),
      ];

      explicit.forEach((f) => {
        if (typeof f === "string") {
          const trimmed = f.trim();
          if (
            trimmed.length > 0 &&
            trimmed.length <= 500 &&
            trimmed.includes(".") &&
            !/^\.{2,}$/.test(trimmed)
          ) {
            matches.add(trimmed);
          }
        }
      });

      const toolName =
        typeof record.tool === "string" && record.tool.trim()
          ? record.tool.trim().toLowerCase()
          : "";
      const titleText = typeof state.title === "string" ? state.title : "";
      const outputText =
        typeof state.output === "string" && !ARTIFACT_OUTPUT_SKIP_TOOLS.has(toolName)
          ? state.output.slice(0, ARTIFACT_OUTPUT_SCAN_LIMIT)
          : "";

      const text = [titleText, outputText]
        .filter((v): v is string => Boolean(v))
        .join(" ");

      if (text) {
        ARTIFACT_PATH_PATTERN.lastIndex = 0;
        Array.from(text.matchAll(ARTIFACT_PATH_PATTERN))
          .map((m) => m[1])
          .filter((f) => f && f.length <= 500)
          .forEach((f) => matches.add(f));
      }

      if (matches.size === 0) return;

      matches.forEach((match) => {
        const cleanedPath = cleanArtifactPath(match);
        if (!cleanedPath) return;

        const key = cleanedPath.toLowerCase();
        const name = cleanedPath.split("/").pop() ?? cleanedPath;
        const id = `artifact-${encodeURIComponent(cleanedPath)}`;

        // Delete and re-add to move to end (most recent)
        if (results.has(key)) results.delete(key);
        results.set(key, {
          id,
          name,
          path: cleanedPath,
          kind: "file" as const,
          size: state.size ? String(state.size) : undefined,
          messageId: messageId || undefined,
        });
      });
    });
  });

  return Array.from(results.values());
}

export function deriveWorkingFiles(items: ArtifactItem[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const rawKey = item.path ?? item.name;
    const normalizedPath = rawKey.trim().replace(/[\\/]+/g, "/");
    const normalizedKey = normalizedPath.toLowerCase();
    if (!normalizedPath || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    results.push(normalizedPath);
    if (results.length >= 5) break;
  }

  return results;
}
