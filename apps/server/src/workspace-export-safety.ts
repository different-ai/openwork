import type { PortableFile } from "./portable-files.js";

export type WorkspaceExportSensitiveMode = "auto" | "include" | "exclude";

export type WorkspaceExportWarning = {
  id: string;
  label: string;
  detail: string;
};

const CONFIG_SECTION_METADATA: Record<string, { warningId: string; label: string; intro: string }> = {
  mcp: {
    warningId: "mcp-config",
    label: "MCP servers",
    intro: "Contains secret-like MCP config",
  },
  plugin: {
    warningId: "plugin-config",
    label: "Plugin settings",
    intro: "Contains secret-like plugin config",
  },
  provider: {
    warningId: "provider-config",
    label: "Provider settings",
    intro: "Contains secret-like provider config",
  },
};

const PORTABLE_FILE_PREFIXES = [".opencode/plugins/", ".opencode/tools/"] as const;

const COMMON_SECRET_KEY_PATTERNS = [
  { id: "apiKey", test: (tokens: string[], normalized: string) => normalized.includes("apikey") || hasWordPair(tokens, "api", "key") },
  { id: "key", test: (tokens: string[], normalized: string) => tokens.length === 1 && normalized === "key" },
  { id: "token", test: (tokens: string[], normalized: string) => tokens.includes("token") || normalized.includes("authtoken") || normalized.includes("accesstoken") || normalized.includes("refreshtoken") },
  { id: "Bearer", test: (tokens: string[], normalized: string) => tokens.includes("bearer") || normalized.includes("authorization") },
  { id: "secret", test: (tokens: string[], normalized: string) => tokens.includes("secret") || hasWordPair(tokens, "client", "secret") },
  { id: "password", test: (tokens: string[], normalized: string) => tokens.includes("password") || normalized.includes("passwd") },
  { id: "credentials", test: (tokens: string[], normalized: string) => tokens.includes("credential") || tokens.includes("credentials") || normalized.includes("credential") },
  { id: "privateKey", test: (tokens: string[]) => hasWordPair(tokens, "private", "key") },
] as const;

const KNOWN_SECRET_VALUE_PATTERNS = [
  { id: "Bearer", test: (value: string) => /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/.test(value) },
  { id: "token", test: (value: string) => /\b(?:ghp|gho|github_pat|xox[baprs]|sk|rk|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,}\b/.test(value) },
  { id: "JWT", test: (value: string) => /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/.test(value) },
] as const;

const RAW_SECRET_TEXT_PATTERNS = [
  { id: "apiKey", test: (value: string) => /\bapi[_-]?key\b/i.test(value) },
  { id: "token", test: (value: string) => /\b(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|token)\b/i.test(value) },
  { id: "Bearer", test: (value: string) => /\bBearer\b/.test(value) },
  { id: "secret", test: (value: string) => /\b(?:client[_-]?secret|secret)\b/i.test(value) },
  { id: "password", test: (value: string) => /\b(?:password|passwd)\b/i.test(value) },
  { id: "credentials", test: (value: string) => /\bcredentials?\b/i.test(value) },
  { id: "privateKey", test: (value: string) => /\bprivate[_-]?key\b/i.test(value) },
] as const;

const GENERIC_KEY_ASSIGNMENT_PATTERNS = [
  /\bkey\b\s*[:=]\s*["'`]([^"'`\n]{12,})["'`]/gi,
  /["'`]key["'`]\s*:\s*["'`]([^"'`\n]{12,})["'`]/gi,
] as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function hasWordPair(tokens: string[], left: string, right: string): boolean {
  return tokens.includes(left) && tokens.includes(right);
}

function splitNameIntoTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function detectSensitiveKeySignals(key: string, value: unknown): string[] {
  const tokens = splitNameIntoTokens(key);
  if (!tokens.length) return [];
  const normalized = tokens.join("");
  const matches = COMMON_SECRET_KEY_PATTERNS.filter((pattern) => pattern.test(tokens, normalized)).map((pattern) => pattern.id);

  if (tokens.includes("public") && tokens.includes("key")) {
    return matches.filter((match) => match !== "privateKey");
  }

  const primitive = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  const genericKeyOnly = tokens.length === 1 && tokens[0] === "key";
  if (genericKeyOnly && !primitive) return [];
  if (genericKeyOnly) {
    if (typeof value !== "string") return [];
    if (!looksLikeGenericSecretValue(value)) return [];
  }

  return matches;
}

function looksLikeGenericSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16) return false;
  if (/\s/.test(trimmed)) return false;
  if (detectSensitiveStringSignals(trimmed).some((match) => match !== "key")) return true;
  if (/^[a-f0-9]{32,}$/i.test(trimmed)) return true;

  const classes = [/[a-z]/.test(trimmed), /[A-Z]/.test(trimmed), /\d/.test(trimmed), /[-_=+/.]/.test(trimmed)].filter(Boolean).length;
  return classes >= 3 && /^[A-Za-z0-9._~+\/-=]+$/.test(trimmed);
}

function detectGenericKeyAssignments(value: string): string[] {
  const matches = new Set<string>();
  for (const pattern of GENERIC_KEY_ASSIGNMENT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const candidate = typeof match[1] === "string" ? match[1] : "";
      if (looksLikeGenericSecretValue(candidate)) {
        matches.add("key");
      }
    }
  }
  return Array.from(matches);
}

function detectSensitiveStringSignals(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const matches = new Set<string>();
  for (const pattern of KNOWN_SECRET_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) {
      matches.add(pattern.id);
    }
  }

  if (/https?:\/\//i.test(trimmed) && trimmed.length > 32) {
    matches.add("long URL");
  }

  for (const pattern of RAW_SECRET_TEXT_PATTERNS) {
    if (pattern.test(trimmed)) {
      matches.add(pattern.id);
    }
  }

  for (const match of detectGenericKeyAssignments(trimmed)) {
    matches.add(match);
  }

  return Array.from(matches);
}

function collectSignals(value: unknown, keyHint?: string): string[] {
  const matches = new Set<string>();

  if (keyHint) {
    for (const match of detectSensitiveKeySignals(keyHint, value)) {
      matches.add(match);
    }
  }

  if (typeof value === "string") {
    for (const match of detectSensitiveStringSignals(value)) {
      matches.add(match);
    }
    return Array.from(matches);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const match of collectSignals(item)) {
        matches.add(match);
      }
    }
    return Array.from(matches);
  }

  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      for (const match of collectSignals(childValue, childKey)) {
        matches.add(match);
      }
    }
  }

  return Array.from(matches);
}

function describeSignals(intro: string, signals: string[]): string {
  const unique = Array.from(new Set(signals));
  if (!unique.length) return intro + ".";
  return `${intro}: ${unique.slice(0, 4).join(", ")}${unique.length > 4 ? ", ..." : ""}.`;
}

function sanitizeValue(value: unknown, keyHint?: string): unknown {
  const directSignals = new Set<string>();
  if (keyHint) {
    for (const match of detectSensitiveKeySignals(keyHint, value)) {
      directSignals.add(match);
    }
  }
  if (typeof value === "string") {
    for (const match of detectSensitiveStringSignals(value)) {
      directSignals.add(match);
    }
    return directSignals.size ? undefined : value;
  }

  if (directSignals.size) return undefined;

  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeValue(item))
      .filter((item) => item !== undefined);
    return items;
  }

  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeValue(childValue, childKey);
      if (sanitized === undefined) continue;
      if (Array.isArray(sanitized) && sanitized.length === 0) continue;
      if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && Object.keys(sanitized as Record<string, unknown>).length === 0) {
        continue;
      }
      next[childKey] = sanitized;
    }
    return next;
  }

  return value;
}

function isPortableFileCandidate(path: string): boolean {
  return PORTABLE_FILE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function collectWorkspaceExportWarnings(input: {
  opencode: Record<string, unknown> | null | undefined;
  files: PortableFile[];
}): WorkspaceExportWarning[] {
  const warnings = new Map<string, WorkspaceExportWarning>();
  const opencode = input.opencode ?? {};

  for (const [sectionKey, sectionValue] of Object.entries(opencode)) {
    const signals = collectSignals(sectionValue);
    if (!signals.length) continue;
    const metadata =
      CONFIG_SECTION_METADATA[sectionKey] ?? {
        warningId: `config-${sectionKey}`,
        label: formatSectionLabel(sectionKey),
        intro: `Contains secret-like ${sectionKey} config`,
      };
    warnings.set(metadata.warningId, {
      id: metadata.warningId,
      label: metadata.label,
      detail: describeSignals(metadata.intro, signals),
    });
  }

  for (const file of input.files) {
    const path = String(file.path ?? "").trim();
    if (!path || !isPortableFileCandidate(path)) continue;
    const signals = collectSignals(file.content);
    if (!signals.length) continue;
    warnings.set(`portable-file:${path}`, {
      id: `portable-file:${path}`,
      label: path,
      detail: describeSignals("Contains secret-like file content", signals),
    });
  }

  return Array.from(warnings.values());
}

export function stripSensitiveWorkspaceExportData(input: {
  opencode: Record<string, unknown> | null | undefined;
  files: PortableFile[];
}): {
  opencode: Record<string, unknown>;
  files: PortableFile[];
} {
  const opencode = cloneJson(
    input.opencode && typeof input.opencode === "object" && !Array.isArray(input.opencode)
      ? input.opencode
      : {},
  ) as Record<string, unknown>;

  for (const [sectionKey, sectionValue] of Object.entries(opencode)) {
    const sanitized = sanitizeValue(sectionValue);
    if (sanitized === undefined) {
      delete opencode[sectionKey];
      continue;
    }
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && Object.keys(sanitized as Record<string, unknown>).length === 0) {
      delete opencode[sectionKey];
      continue;
    }
    if (Array.isArray(sanitized) && sanitized.length === 0) {
      delete opencode[sectionKey];
      continue;
    }
    opencode[sectionKey] = sanitized;
  }

  const files = input.files
    .filter((file) => {
      const path = String(file.path ?? "").trim();
      if (!isPortableFileCandidate(path)) return true;
      return collectSignals(file.content).length === 0;
    })
    .map((file) => ({ ...file }));

  return { opencode, files };
}

function formatSectionLabel(sectionKey: string): string {
  return sectionKey
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}
