import type { Part } from "@opencode-ai/sdk/v2/client";
import { t } from "../../i18n";
import type {
  MessageInfo,
  ModelRef,
  OpencodeEvent,
} from "../types";

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

/**
 * Provider ID → friendly display name.
 * Used when the backend doesn't return a provider name.
 */
export const FRIENDLY_PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  openrouter: "OpenRouter",
  together: "Together AI",
  fireworks: "Fireworks",
  perplexity: "Perplexity",
  xai: "xAI",
  cohere: "Cohere",
};

/**
 * Model ID → friendly display name.
 * Matches by substring so "gpt-4.1-2025-04-14" still hits "gpt-4.1".
 * Order matters: more specific patterns first.
 */
export const FRIENDLY_MODEL_LABELS: [pattern: string, label: string][] = [
  // OpenAI
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5", "GPT-5"],
  ["gpt-4.1-mini", "GPT-4.1 Mini"],
  ["gpt-4.1-nano", "GPT-4.1 Nano"],
  ["gpt-4.1", "GPT-4.1"],
  ["gpt-4o-mini", "GPT-4o Mini"],
  ["gpt-4o", "GPT-4o"],
  ["gpt-4-turbo", "GPT-4 Turbo"],
  ["gpt-4", "GPT-4"],
  ["o4-mini", "o4 Mini"],
  ["o3-pro", "o3 Pro"],
  ["o3-mini", "o3 Mini"],
  ["o3", "o3"],
  ["o1-pro", "o1 Pro"],
  ["o1-mini", "o1 Mini"],
  ["o1", "o1"],
  ["codex-mini", "Codex Mini"],

  // Anthropic
  ["claude-sonnet-4", "Claude Sonnet 4"],
  ["claude-opus-4", "Claude Opus 4"],
  ["claude-3.7-sonnet", "Claude 3.7 Sonnet"],
  ["claude-3.5-sonnet", "Claude 3.5 Sonnet"],
  ["claude-3.5-haiku", "Claude 3.5 Haiku"],
  ["claude-3-opus", "Claude 3 Opus"],
  ["claude-3-sonnet", "Claude 3 Sonnet"],
  ["claude-3-haiku", "Claude 3 Haiku"],

  // Google
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["gemini-2.0-flash", "Gemini 2.0 Flash"],
  ["gemini-1.5-pro", "Gemini 1.5 Pro"],
  ["gemini-1.5-flash", "Gemini 1.5 Flash"],

  // DeepSeek
  ["deepseek-r1", "DeepSeek R1"],
  ["deepseek-v3", "DeepSeek V3"],
  ["deepseek-chat", "DeepSeek Chat"],

  // Mistral
  ["mistral-large", "Mistral Large"],
  ["mistral-medium", "Mistral Medium"],
  ["mistral-small", "Mistral Small"],
  ["codestral", "Codestral"],

  // xAI
  ["grok-3", "Grok 3"],
  ["grok-2", "Grok 2"],

  // OpenCode
  ["big-pickle", "Big Pickle"],
];

/**
 * Resolve a friendly display name for a model ID.
 * Checks FRIENDLY_MODEL_LABELS first (substring match), then falls back
 * to humanizeModelLabel which title-cases the raw ID.
 */
export function resolveModelDisplayName(modelID: string): string {
  const normalized = modelID.trim().toLowerCase();
  for (const [pattern, label] of FRIENDLY_MODEL_LABELS) {
    if (normalized.includes(pattern)) return label;
  }
  return humanizeModelLabel(modelID);
}

/**
 * Resolve a friendly display name for a provider ID.
 */
export function resolveProviderDisplayName(providerID: string): string {
  return FRIENDLY_PROVIDER_LABELS[providerID.trim().toLowerCase()] ?? humanizeModelLabel(providerID);
}

const humanizeModelLabel = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized && FRIENDLY_PROVIDER_LABELS[normalized]) {
    return FRIENDLY_PROVIDER_LABELS[normalized];
  }

  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return value;

  return cleaned
    .split(" ")
    .flatMap((word) => {
      if (!word) return [];
      if (/\d/.test(word) || word.length <= 3) {
        return [word.toUpperCase()];
      }
      const lower = word.toLowerCase();
      return [lower.charAt(0).toUpperCase() + lower.slice(1)];
    })
    .join(" ");
};

export { isDesktopRuntime, isElectronRuntime } from "../lib/runtime-env";

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

export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;

  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const platform =
    typeof (navigator as any).userAgentData?.platform === "string"
      ? (navigator as any).userAgentData.platform
      : typeof navigator.platform === "string"
        ? navigator.platform
        : "";

  return /mac/i.test(platform) || /macintosh|mac os x/i.test(ua);
}

const STARTUP_PREF_KEY = "openwork.startupPref";
const LEGACY_PREF_KEY = "openwork.modePref";
const LEGACY_PREF_KEY_ALT = "openwork_mode_pref";

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

/**
 * Convert a directory path to a forward-slash normalised form for **local**
 * comparison only (e.g. case-insensitive matching via {@link normalizeDirectoryPath}).
 *
 * **Do NOT use this when building a directory value that will be sent to the
 * OpenCode server** (session.list, session.create, mcp.status, etc.).  The
 * server compares directories with strict equality and on Windows it stores
 * native backslash paths.  Use
 * {@link import("../lib/session-scope").toSessionTransportDirectory toSessionTransportDirectory}
 * instead — it returns a branded {@link import("../lib/session-scope").TransportDirectory TransportDirectory}
 * that the compiler can enforce.
 */
export function normalizeDirectoryQueryPath(input?: string | null) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const withoutVerbatim = /^\\\\\?\\UNC\\/i.test(trimmed)
    ? `\\${trimmed.slice(7)}`
    : /^\\\\\?\\[a-zA-Z]:[\\/]/.test(trimmed)
      ? trimmed.slice(4)
      : trimmed;
  const unified = withoutVerbatim.replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  return withoutTrailing || "/";
}

export function normalizeDirectoryPath(input?: string | null) {
  const normalized = normalizeDirectoryQueryPath(input);
  if (!normalized) return "";
  if (isMacPlatform()) {
    return normalized.replace(/^\/private\/tmp(?=\/|$)/, "/tmp").toLowerCase();
  }
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
    return t("time.just_now");
  }

  if (delta < 60_000) {
    return t("time.seconds_ago", { count: Math.max(1, Math.round(delta / 1000)) });
  }

  if (delta < 60 * 60_000) {
    return t("time.minutes_ago", { count: Math.max(1, Math.round(delta / 60_000)) });
  }

  if (delta < 24 * 60 * 60_000) {
    return t("time.hours_ago", { count: Math.max(1, Math.round(delta / (60 * 60_000))) });
  }

  return new Date(timestampMs).toLocaleDateString();
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

export function redactTokenLikeText(value: string): string {
  return value
    .replace(/([?&](?:access_token|api_key|key|password|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(authorization:\s*bearer\s+)[^\s,]+/gi, "$1[redacted]")
    .replace(/\b(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bowt_[a-z0-9_-]+\b/gi, "owt_[redacted]");
}

export function getWorkspaceTaskLoadErrorDisplay(error?: string | null) {
  const raw = redactTokenLikeText(error?.trim() ?? "");
  return {
    tone: "error" as const,
    label: "Error",
    message: "Failed to load tasks",
    title: raw || "Failed to load tasks",
  };
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

export function isUserVisiblePart(part: Part) {
  const flags = part as { synthetic?: boolean; ignored?: boolean };
  return !flags.synthetic && !flags.ignored;
}

export function isVisibleTextPart(part: Part) {
  return part.type === "text" && isUserVisiblePart(part);
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
