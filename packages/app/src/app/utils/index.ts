import type { Part, Provider, Session } from "@opencode-ai/sdk/v2/client";
import type { ArtifactItem, MessageGroup, MessageInfo, MessageWithParts, ModelRef, OpencodeEvent, PlaceholderAssistantMessage } from "../types";

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

export function formatModelLabel(model: ModelRef, providers: Provider[] = []) {
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

export function readModePreference(): "host" | "client" | null {
  if (typeof window === "undefined") return null;

  try {
    const pref =
      window.localStorage.getItem("openwork.modePref") ??
      window.localStorage.getItem("openwork_mode_pref");

    if (pref === "host" || pref === "client") {
      // Migrate legacy key if needed.
      try {
        window.localStorage.setItem("openwork.modePref", pref);
      } catch {
        // ignore
      }
      return pref;
    }
  } catch {
    // ignore
  }

  return null;
}

export function writeModePreference(nextMode: "host" | "client") {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem("openwork.modePref", nextMode);
    // Keep legacy key for now.
    window.localStorage.setItem("openwork_mode_pref", nextMode);
  } catch {
    // ignore
  }
}

export function clearModePreference() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem("openwork.modePref");
    window.localStorage.removeItem("openwork_mode_pref");
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

export function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  if (seconds > 0) {
    return `${seconds}s`;
  }
  return `${ms}ms`;
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
  const resolveType = (value: unknown) => {
    if (!value) return null;
    if (typeof value === "string") return value.toLowerCase();
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.type === "string") return record.type.toLowerCase();
    }
    return null;
  };

  const type = resolveType(status);
  if (!type) return "idle";

  if (type === "busy" || type === "running") return "running";
  if (type === "retry") return "retry";
  if (type === "idle") return "idle";

  if (["terminated", "terminate", "killed"].includes(type)) return "terminated";
  if (["interrupt", "interrupted", "aborted", "cancelled", "canceled"].includes(type)) return "interrupted";
  if (["error", "failed", "failure"].includes(type)) return "error";

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
  // Only count reasoning and tool as real steps, ignore step-start/step-finish markers
  return part.type === "reasoning" || part.type === "tool";
}

export function groupMessageParts(parts: Part[], messageId: string): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const steps: Part[] = [];
  let textBuffer = "";

  const flushText = () => {
    if (!textBuffer) return;
    groups.push({ kind: "text", part: { type: "text", text: textBuffer } as Part });
    textBuffer = "";
  };

  parts.forEach((part) => {
    if (part.type === "text") {
      textBuffer += (part as { text?: string }).text ?? "";
      return;
    }

    if (part.type === "agent") {
      const name = (part as { name?: string }).name ?? "";
      textBuffer += name ? `@${name}` : "@agent";
      return;
    }

    if (part.type === "file") {
      const record = part as { label?: string; path?: string; filename?: string; url?: string };
      const url = record.url;
      if (typeof url === "string" && !url.startsWith("file://")) {
        flushText();
        return;
      }
      const label = record.label ?? record.path ?? record.filename ?? "";
      textBuffer += label ? `@${label}` : "@file";
      return;
    }

    flushText();
    steps.push(part);
  });

  flushText();

  if (steps.length) {
    groups.push({ kind: "steps", id: `steps-${messageId}`, parts: steps });
  }

  return groups;
}

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  patch: "Patch",
  multiedit: "MultiEdit",
  grep: "Grep",
  glob: "Glob",
  task: "Task",
  webfetch: "Fetch",
  fetchurl: "Fetch",
  websearch: "Search",
  execute: "Execute",
  create: "Create",
  ls: "List",
  skill: "Skill",
  todowrite: "Todo",
};

// Tools that should show GitHub icon (git operations)
const GITHUB_TOOLS = new Set([
  "git", "gh", "github", "mcp_github", "mcp-github",
  "git_status", "git_diff", "git_log", "git_commit", "git_push", "git_pull",
  "create_pull_request", "list_pull_requests", "get_pull_request",
  "create_issue", "list_issues", "get_issue",
  "create_branch", "list_branches", "create_repository",
]);

// Shorten path to last N segments
function shortenPath(path: string, segments = 3): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return parts.slice(-segments).join("/");
}

// Format file size or line count
function formatReadInfo(input: Record<string, unknown>): string | null {
  const parts: string[] = [];
  
  // Get file path (shortened)
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string" && filePath.trim()) {
    parts.push(shortenPath(filePath.trim()));
  }
  
  // Add line range info if present
  const offset = input.offset ?? input.start_line;
  const limit = input.limit ?? input.end_line ?? input.lines;
  if (typeof offset === "number" || typeof limit === "number") {
    const rangeInfo: string[] = [];
    if (typeof offset === "number" && offset > 0) rangeInfo.push(`from L${offset}`);
    if (typeof limit === "number") rangeInfo.push(`${limit} lines`);
    if (rangeInfo.length) parts.push(`(${rangeInfo.join(", ")})`);
  }
  
  return parts.length ? parts.join(" ") : null;
}

// Format list directory info
function formatListInfo(input: Record<string, unknown>): string | null {
  const dirPath = input.directory_path ?? input.path ?? input.folder;
  if (typeof dirPath === "string" && dirPath.trim()) {
    return shortenPath(dirPath.trim());
  }
  return null;
}

// Format search info (grep/glob)
function formatSearchInfo(toolName: string, input: Record<string, unknown>): string | null {
  const parts: string[] = [];
  
  // Pattern
  const pattern = input.pattern ?? input.query ?? input.patterns;
  if (typeof pattern === "string" && pattern.trim()) {
    const p = pattern.trim();
    parts.push(p.length > 30 ? `"${p.slice(0, 30)}…"` : `"${p}"`);
  } else if (Array.isArray(pattern) && pattern.length > 0) {
    const first = String(pattern[0]);
    parts.push(first.length > 30 ? `"${first.slice(0, 30)}…"` : `"${first}"`);
  }
  
  // Path context
  const path = input.path ?? input.folder ?? input.directory;
  if (typeof path === "string" && path.trim()) {
    parts.push(`in ${shortenPath(path.trim(), 2)}`);
  }
  
  // File type filter
  const fileType = input.type ?? input.glob_pattern;
  if (typeof fileType === "string" && fileType.trim()) {
    parts.push(`(${fileType})`);
  }
  
  return parts.length ? parts.join(" ") : null;
}

// Format command/execute info
function formatCommandInfo(input: Record<string, unknown>): string | null {
  const cmd = input.command ?? input.cmd;
  if (typeof cmd === "string" && cmd.trim()) {
    const trimmed = cmd.trim();
    // Show first line only, truncate if too long
    const firstLine = trimmed.split("\n")[0];
    return firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine;
  }
  return null;
}

export type StepSummary = {
  title: string;
  detail?: string;
  icon?: "github" | "default";
};

export function summarizeStep(part: Part): StepSummary {
  if (part.type === "tool") {
    const record = part as any;
    const toolName = record.tool ? String(record.tool) : "Tool";
    const toolLower = toolName.toLowerCase();
    const label = TOOL_LABELS[toolLower] ?? toolName;
    const state = record.state ?? {};
    const input = typeof state.input === "object" && state.input ? state.input : {};
    
    // Determine if this is a GitHub-related tool
    const isGithubTool = GITHUB_TOOLS.has(toolLower) || 
      toolLower.includes("github") || 
      toolLower.includes("git_") ||
      toolLower.startsWith("gh_") ||
      (toolLower === "execute" && typeof input.command === "string" && 
        (input.command.startsWith("git ") || input.command.startsWith("gh ")));
    
    // Some tools don't need detail
    const noDetailTools = ["todowrite"];
    if (noDetailTools.includes(toolLower)) {
      return { title: label, icon: isGithubTool ? "github" : "default" };
    }
    
    // Extract detail based on tool type
    let detail: string | null = null;
    
    // Read file
    if (toolLower === "read") {
      detail = formatReadInfo(input);
    }
    // List directory
    else if (toolLower === "ls" || toolLower === "list") {
      detail = formatListInfo(input);
    }
    // Search (grep/glob)
    else if (["grep", "glob", "find"].includes(toolLower)) {
      detail = formatSearchInfo(toolLower, input);
    }
    // Command/Execute
    else if (["bash", "execute", "shell"].includes(toolLower)) {
      detail = formatCommandInfo(input);
    }
    // Edit/Write/Create - show file path
    else if (["edit", "write", "create", "patch", "multiedit"].includes(toolLower)) {
      const filePath = input.file_path ?? input.path;
      if (typeof filePath === "string" && filePath.trim()) {
        detail = shortenPath(filePath.trim());
      }
    }
    // Fetch/WebSearch - show URL or query
    else if (["webfetch", "fetchurl", "websearch"].includes(toolLower)) {
      const url = input.url;
      const query = input.query;
      if (typeof url === "string" && url.trim()) {
        const u = url.trim();
        detail = u.length > 50 ? `${u.slice(0, 50)}…` : u;
      } else if (typeof query === "string" && query.trim()) {
        const q = query.trim();
        detail = q.length > 40 ? `"${q.slice(0, 40)}…"` : `"${q}"`;
      }
    }
    
    // Fallback to state.title if no detail extracted
    if (!detail && state.title) {
      const titleStr = typeof state.title === "string" 
        ? state.title 
        : typeof state.title === "object" 
          ? JSON.stringify(state.title).slice(0, 80)
          : String(state.title);
      const title = titleStr.trim();
      detail = title.length > 60 ? `${title.slice(0, 60)}…` : title;
    }
    
    return { 
      title: label, 
      detail: detail ?? undefined,
      icon: isGithubTool ? "github" : "default"
    };
  }

  if (part.type === "reasoning") {
    return { title: "Thinking" };
  }

  return { title: "Step" };
}

export function deriveArtifacts(list: MessageWithParts[]): ArtifactItem[] {
  const results = new Map<string, ArtifactItem>();

  list.forEach((message) => {
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

      const text = [state.title, state.output]
        .filter((v): v is string => typeof v === "string")
        .join(" ");

      if (text) {
        const pathPattern =
          /(?:^|[\s"'`([{])((?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|~[/\\]|[/\\])[\w./\\\-]*\.[a-z][a-z0-9]{0,9}|[\w.\-]+[/\\][\w./\\\-]*\.[a-z][a-z0-9]{0,9})/gi;

        Array.from(text.matchAll(pathPattern))
          .map((m) => m[1])
          .filter((f) => f && f.length <= 500)
          .forEach((f) => matches.add(f));
      }

      if (matches.size === 0) return;

      matches.forEach((match) => {
        const normalizedPath = match.trim().replace(/[\\/]+/g, "/");
        if (!normalizedPath) return;

        const key = normalizedPath.toLowerCase();
        const name = normalizedPath.split("/").pop() ?? normalizedPath;
        const id = `artifact-${encodeURIComponent(normalizedPath)}`;

        // Delete and re-add to move to end (most recent)
        if (results.has(key)) results.delete(key);
        results.set(key, {
          id,
          name,
          path: normalizedPath,
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
    const normalized = rawKey.trim().replace(/[\\/]+/g, "/").toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(item.name);
    if (results.length >= 5) break;
  }

  return results;
}
