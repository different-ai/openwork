import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ServerRepositories } from "../database/repositories.js";
import type { CloudSigninRecord, JsonObject, ManagedConfigRecord, WorkspaceRecord, WorkspaceShareRecord } from "../database/types.js";
import type { ServerWorkingDirectory } from "../database/working-directory.js";
import type { ConfigMaterializationService } from "./config-materialization-service.js";
import type { WorkspaceFileService } from "./workspace-file-service.js";
import { RouteError } from "../http.js";

const DEFAULT_HUB_REPO = {
  owner: "different-ai",
  repo: "openwork-hub",
  ref: "main",
} as const;

const ALLOWED_BUNDLE_TYPES = new Set(["skill", "skills-set", "workspace-profile"]);
const ALLOWED_PORTABLE_PREFIXES = [".opencode/agents/", ".opencode/plugins/", ".opencode/tools/"];
const RESERVED_PORTABLE_SEGMENTS = new Set([".DS_Store", "Thumbs.db", "node_modules"]);
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMMAND_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const MCP_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

type ManagedKind = "mcps" | "plugins" | "providerConfigs" | "skills";
type ManagedSummary = ManagedConfigRecord & { workspaceIds: string[] };
type WorkspaceExportSensitiveMode = "auto" | "include" | "exclude";
type WorkspaceExportWarning = { detail: string; id: string; label: string };
type HubRepo = { owner: string; repo: string; ref: string };
type PortableFile = { content: string; path: string };

function nowIso() {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(value: unknown) {
  const trimmed = normalizeString(value).replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : null;
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { body: content, data: {} as Record<string, unknown> };
  }
  const raw = match[1] ?? "";
  const data: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if (value === "true") {
      data[key] = true;
      continue;
    }
    if (value === "false") {
      data[key] = false;
      continue;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      data[key] = Number(value);
      continue;
    }
    data[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return {
    body: content.slice(match[0].length),
    data,
  };
}

function buildFrontmatter(data: Record<string, unknown>) {
  const yaml = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? String(value).replace(/\n/g, " ") : String(value)}`)
    .join("\n");
  return `---\n${yaml}\n---\n`;
}

function validateSkillName(name: string) {
  if (!name || name.length < 1 || name.length > 64 || !SKILL_NAME_REGEX.test(name)) {
    throw new RouteError(400, "invalid_request", "Skill name must be kebab-case (1-64 chars).");
  }
}

function validateCommandName(name: string) {
  if (!name || !COMMAND_NAME_REGEX.test(name)) {
    throw new RouteError(400, "invalid_request", "Command name must be alphanumeric with _ or -.");
  }
}

function validateMcpName(name: string) {
  if (!name || name.startsWith("-") || !MCP_NAME_REGEX.test(name)) {
    throw new RouteError(400, "invalid_request", "MCP name must be alphanumeric and not start with -.");
  }
}

function validateMcpConfig(config: Record<string, unknown>) {
  const type = config.type;
  if (type !== "local" && type !== "remote") {
    throw new RouteError(400, "invalid_request", "MCP config type must be local or remote.");
  }
  if (type === "local") {
    const command = config.command;
    if (!Array.isArray(command) || command.length === 0) {
      throw new RouteError(400, "invalid_request", "Local MCP requires command array.");
    }
  }
  if (type === "remote") {
    const url = config.url;
    if (!url || typeof url !== "string") {
      throw new RouteError(400, "invalid_request", "Remote MCP requires url.");
    }
  }
}

function normalizeManagedKey(value: string, fallback: string) {
  const trimmed = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return trimmed || fallback;
}

function normalizePortablePath(input: unknown) {
  const normalized = String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
  if (!normalized) {
    throw new RouteError(400, "invalid_request", "Portable file path is required.");
  }
  if (normalized.includes("\0")) {
    throw new RouteError(400, "invalid_request", `Portable file path contains an invalid byte: ${normalized}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RouteError(400, "invalid_request", `Portable file path is invalid: ${normalized}`);
  }
  return normalized;
}

function isAllowedPortableFilePath(input: unknown) {
  const filePath = normalizePortablePath(input);
  if (!ALLOWED_PORTABLE_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return false;
  }
  if (filePath.split("/").some((segment) => /^\.env(?:\..+)?$/i.test(segment) || RESERVED_PORTABLE_SEGMENTS.has(segment))) {
    return false;
  }
  return true;
}

function resolveSafeChild(baseDir: string, child: string) {
  const base = path.resolve(baseDir);
  const target = path.resolve(baseDir, child);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new RouteError(400, "invalid_request", "Invalid file path.");
  }
  return target;
}

function listPortableFiles(workspaceRoot: string): PortableFile[] {
  const root = path.resolve(workspaceRoot);
  const portableRoot = path.join(root, ".opencode");
  if (!fs.existsSync(portableRoot)) {
    return [];
  }

  const output: PortableFile[] = [];
  const walk = (currentPath: string) => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = normalizePortablePath(absolutePath.slice(root.length + 1));
      if (!isAllowedPortableFilePath(relativePath)) {
        continue;
      }
      output.push({ content: fs.readFileSync(absolutePath, "utf8"), path: relativePath });
    }
  };

  walk(portableRoot);
  output.sort((left, right) => left.path.localeCompare(right.path));
  return output;
}

function writePortableFiles(workspaceRoot: string, files: unknown, options?: { replace?: boolean }) {
  if (!Array.isArray(files) || files.length === 0) {
    return [] as PortableFile[];
  }
  const root = path.resolve(workspaceRoot);
  const planned = files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RouteError(400, "invalid_request", "Portable files must be objects with path and content.");
    }
    const record = entry as Record<string, unknown>;
    const filePath = normalizePortablePath(record.path);
    if (!isAllowedPortableFilePath(filePath)) {
      throw new RouteError(400, "invalid_request", `Portable file path is not allowed: ${filePath}`);
    }
    return {
      absolutePath: resolveSafeChild(root, filePath),
      content: typeof record.content === "string" ? record.content : String(record.content ?? ""),
      path: filePath,
    };
  });

  if (options?.replace) {
    for (const existing of listPortableFiles(workspaceRoot)) {
      fs.rmSync(path.join(root, existing.path), { force: true });
    }
  }

  for (const file of planned) {
    fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
    fs.writeFileSync(file.absolutePath, file.content, "utf8");
  }

  return planned;
}

function sanitizePortableOpencodeConfig(opencode: Record<string, unknown> | null | undefined) {
  const source = opencode && typeof opencode === "object" && !Array.isArray(opencode) ? opencode : {};
  const next: Record<string, unknown> = {};
  for (const key of ["agent", "command", "instructions", "mcp", "permission", "plugin", "share", "tools", "watcher"] as const) {
    if (key in source) {
      next[key] = cloneJson(source[key]);
    }
  }
  return next;
}

function sanitizeOpenworkTemplateConfig(openwork: Record<string, unknown> | null | undefined) {
  const next = cloneJson(openwork ?? {});
  const blueprint = readRecord(next.blueprint);
  if (!blueprint) {
    return next;
  }
  const materialized = readRecord(blueprint.materialized);
  if (materialized) {
    delete materialized.sessions;
    if (Object.keys(materialized).length === 0) {
      delete blueprint.materialized;
    } else {
      blueprint.materialized = materialized;
    }
  }
  next.blueprint = blueprint;
  return next;
}

function hasWordPair(tokens: string[], left: string, right: string) {
  return tokens.includes(left) && tokens.includes(right);
}

function splitNameIntoTokens(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function detectSensitiveStringSignals(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [] as string[];
  }
  const matches = new Set<string>();
  for (const pattern of [
    { id: "Bearer", test: /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/ },
    { id: "token", test: /\b(?:ghp|gho|github_pat|xox[baprs]|sk|rk|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,}\b/ },
    { id: "JWT", test: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/ },
    { id: "apiKey", test: /\bapi[_-]?key\b/i },
    { id: "token", test: /\b(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|token)\b/i },
    { id: "secret", test: /\b(?:client[_-]?secret|secret)\b/i },
    { id: "password", test: /\b(?:password|passwd)\b/i },
    { id: "credentials", test: /\bcredentials?\b/i },
    { id: "privateKey", test: /\bprivate[_-]?key\b/i },
  ]) {
    if (pattern.test.test(trimmed)) {
      matches.add(pattern.id);
    }
  }
  if (/https?:\/\//i.test(trimmed) && trimmed.length > 32) {
    matches.add("long URL");
  }
  return Array.from(matches);
}

function collectSignals(value: unknown, keyHint?: string): string[] {
  const matches = new Set<string>();
  if (keyHint) {
    const tokens = splitNameIntoTokens(keyHint);
    const normalized = tokens.join("");
    for (const pattern of [
      { id: "apiKey", test: () => normalized.includes("apikey") || hasWordPair(tokens, "api", "key") },
      { id: "token", test: () => tokens.includes("token") || normalized.includes("authtoken") },
      { id: "secret", test: () => tokens.includes("secret") || hasWordPair(tokens, "client", "secret") },
      { id: "password", test: () => tokens.includes("password") },
      { id: "credentials", test: () => tokens.includes("credential") || tokens.includes("credentials") },
      { id: "privateKey", test: () => hasWordPair(tokens, "private", "key") },
    ]) {
      if (pattern.test()) {
        matches.add(pattern.id);
      }
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

function describeSignals(intro: string, signals: string[]) {
  const unique = Array.from(new Set(signals));
  if (!unique.length) {
    return `${intro}.`;
  }
  return `${intro}: ${unique.slice(0, 4).join(", ")}${unique.length > 4 ? ", ..." : ""}.`;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return detectSensitiveStringSignals(value).length ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const directSignals = collectSignals(child, key);
      if (directSignals.length) {
        continue;
      }
      const sanitized = sanitizeValue(child);
      if (sanitized === undefined) {
        continue;
      }
      if (Array.isArray(sanitized) && sanitized.length === 0) {
        continue;
      }
      if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && Object.keys(sanitized as Record<string, unknown>).length === 0) {
        continue;
      }
      next[key] = sanitized;
    }
    return next;
  }
  return value;
}

function collectWorkspaceExportWarnings(input: { files: PortableFile[]; opencode: Record<string, unknown> | null | undefined }) {
  const warnings = new Map<string, WorkspaceExportWarning>();
  const opencode = input.opencode ?? {};
  for (const [sectionKey, sectionValue] of Object.entries(opencode)) {
    const signals = collectSignals(sectionValue);
    if (!signals.length) {
      continue;
    }
    const label = sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1);
    warnings.set(sectionKey, {
      detail: describeSignals(`Contains secret-like ${sectionKey} config`, signals),
      id: `${sectionKey}-config`,
      label,
    });
  }
  for (const file of input.files) {
    if (!file.path.startsWith(".opencode/plugins/") && !file.path.startsWith(".opencode/tools/")) {
      continue;
    }
    const signals = collectSignals(file.content);
    if (!signals.length) {
      continue;
    }
    warnings.set(`portable-file:${file.path}`, {
      detail: describeSignals("Contains secret-like file content", signals),
      id: `portable-file:${file.path}`,
      label: file.path,
    });
  }
  return Array.from(warnings.values());
}

function stripSensitiveWorkspaceExportData(input: { files: PortableFile[]; opencode: Record<string, unknown> | null | undefined }) {
  const opencode = cloneJson(input.opencode ?? {});
  for (const [sectionKey, sectionValue] of Object.entries(opencode)) {
    const sanitized = sanitizeValue(sectionValue);
    if (sanitized === undefined) {
      delete opencode[sectionKey];
      continue;
    }
    if (Array.isArray(sanitized) && sanitized.length === 0) {
      delete opencode[sectionKey];
      continue;
    }
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && Object.keys(sanitized as Record<string, unknown>).length === 0) {
      delete opencode[sectionKey];
      continue;
    }
    opencode[sectionKey] = sanitized;
  }
  const files = input.files.filter((file) => collectSignals(file.content).length === 0).map((file) => ({ ...file }));
  return { files, opencode };
}

function normalizeBundleFetchUrl(bundleUrl: unknown) {
  let inputUrl: URL;
  try {
    inputUrl = new URL(String(bundleUrl ?? "").trim());
  } catch {
    throw new RouteError(400, "invalid_request", "Invalid shared bundle URL.");
  }
  if (inputUrl.protocol !== "https:" && inputUrl.protocol !== "http:") {
    throw new RouteError(400, "invalid_request", "Shared bundle URL must use http(s).");
  }
  const trustedBaseUrl = new URL(resolvePublisherBaseUrl().replace(/\/+$/, ""));
  if (inputUrl.origin !== trustedBaseUrl.origin) {
    throw new RouteError(400, "invalid_request", `Shared bundle URLs must use the configured OpenWork publisher (${trustedBaseUrl.origin}).`);
  }
  const segments = inputUrl.pathname.split("/").filter(Boolean);
  if (segments[0] !== "b" || !segments[1]) {
    throw new RouteError(400, "invalid_request", "Shared bundle URL must point to a bundle id.");
  }
  trustedBaseUrl.pathname = `/b/${segments[1]}/data`;
  trustedBaseUrl.search = "";
  return trustedBaseUrl;
}

function readErrorMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof json.message === "string" ? json.message.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

function resolvePublisherBaseUrl() {
  return String(process.env.OPENWORK_PUBLISHER_BASE_URL ?? "").trim() || "https://share.openworklabs.com";
}

function resolvePublisherOrigin() {
  return String(process.env.OPENWORK_PUBLISHER_REQUEST_ORIGIN ?? "").trim() || "https://app.openwork.software";
}

function fetchTelegramBotInfo(token: string) {
  const trimmed = token.trim();
  if (!trimmed) {
    return Promise.resolve(null as { id: number; name?: string; username?: string } | null);
  }
  return fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
    headers: { Accept: "application/json" },
  }).then(async (response) => {
    if (!response.ok) {
      return null;
    }
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    const result = readRecord(json?.result);
    if (!result) {
      return null;
    }
    const id = Number(result.id);
    return Number.isFinite(id)
      ? {
          id,
          name: typeof result.first_name === "string" ? result.first_name : undefined,
          username: typeof result.username === "string" ? result.username : undefined,
        }
      : null;
  }).catch(() => null);
}

function createPairingCode() {
  return randomBytes(4).toString("hex").toUpperCase();
}

function pairingCodeHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function extractTriggerFromBody(body: string) {
  const lines = body.split(/\r?\n/);
  let inWhenSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "").trim();
      inWhenSection = /^when to use$/i.test(heading);
      continue;
    }
    if (!inWhenSection) {
      continue;
    }
    const cleaned = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (cleaned) {
      return cleaned;
    }
  }
  return "";
}

export type ManagedResourceService = ReturnType<typeof createManagedResourceService>;

export function createManagedResourceService(input: {
  config: ConfigMaterializationService;
  files: WorkspaceFileService;
  repositories: ServerRepositories;
  serverId: string;
  workingDirectory: ServerWorkingDirectory;
}) {
  const kindConfig = {
    mcps: {
      assignmentRepo: input.repositories.workspaceMcps,
      itemRepo: input.repositories.mcps,
      reloadReason: "mcp" as const,
      triggerType: "mcp" as const,
    },
    plugins: {
      assignmentRepo: input.repositories.workspacePlugins,
      itemRepo: input.repositories.plugins,
      reloadReason: "plugins" as const,
      triggerType: "plugin" as const,
    },
    providerConfigs: {
      assignmentRepo: input.repositories.workspaceProviderConfigs,
      itemRepo: input.repositories.providerConfigs,
      reloadReason: "config" as const,
      triggerType: "config" as const,
    },
    skills: {
      assignmentRepo: input.repositories.workspaceSkills,
      itemRepo: input.repositories.skills,
      reloadReason: "skills" as const,
      triggerType: "skill" as const,
    },
  };

  function getWorkspaceOrThrow(workspaceId: string) {
    const workspace = input.repositories.workspaces.getById(workspaceId);
    if (!workspace) {
      throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
    }
    return workspace;
  }

  function ensureWorkspaceMutable(workspace: WorkspaceRecord) {
    if (workspace.kind === "remote") {
      throw new RouteError(
        501,
        "not_implemented",
        "Phase 8 managed-resource mutation currently supports local, control, and help workspaces only. Remote managed-resource mutation stays on the compatibility path until remote credentials and projection ownership fully migrate.",
      );
    }
    if (!workspace.dataDir?.trim()) {
      throw new RouteError(400, "invalid_request", `Workspace ${workspace.id} does not have a local data directory.`);
    }
    return workspace;
  }

  function workspaceSkillPath(workspace: WorkspaceRecord, key: string) {
    const baseDir = workspace.configDir?.trim() || workspace.dataDir?.trim() || "";
    return path.join(baseDir, ".opencode", "skills", "openwork-managed", key, "SKILL.md");
  }

  function workspaceCommandDir(workspace: WorkspaceRecord) {
    return path.join(workspace.dataDir!.trim(), ".opencode", "commands");
  }

  function listWorkspaceCommands(workspace: WorkspaceRecord) {
    ensureWorkspaceMutable(workspace);
    const directory = workspaceCommandDir(workspace);
    if (!fs.existsSync(directory)) {
      return [] as Array<{ description?: string; name: string; template: string }>;
    }
    const items: Array<{ description?: string; name: string; template: string }> = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = parseFrontmatter(content);
      const name = typeof parsed.data.name === "string" ? parsed.data.name : entry.name.replace(/\.md$/, "");
      if (!COMMAND_NAME_REGEX.test(name)) {
        continue;
      }
      items.push({
        description: typeof parsed.data.description === "string" ? parsed.data.description : undefined,
        name,
        template: parsed.body.trim(),
      });
    }
    items.sort((left, right) => left.name.localeCompare(right.name));
    return items;
  }

  function upsertWorkspaceCommand(workspace: WorkspaceRecord, payload: { description?: string; name: string; template: string }) {
    ensureWorkspaceMutable(workspace);
    validateCommandName(payload.name);
    if (!payload.template.trim()) {
      throw new RouteError(400, "invalid_request", "Command template is required.");
    }
    const directory = workspaceCommandDir(workspace);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${payload.name}.md`);
    const content = `${buildFrontmatter({ description: payload.description, name: payload.name })}\n${payload.template.trim()}\n`;
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  function clearWorkspaceCommands(workspace: WorkspaceRecord) {
    ensureWorkspaceMutable(workspace);
    fs.rmSync(workspaceCommandDir(workspace), { force: true, recursive: true });
  }

  function summaryForKind(kind: ManagedKind, item: ManagedConfigRecord): ManagedSummary {
    return {
      ...item,
      workspaceIds: kindConfig[kind].assignmentRepo.listForItem(item.id).map((assignment) => assignment.workspaceId),
    };
  }

  async function materializeAssignments(kind: ManagedKind, workspaceIds: string[], action: "added" | "removed" | "updated", name: string) {
    for (const workspaceId of Array.from(new Set(workspaceIds.filter(Boolean)))) {
      const workspace = input.repositories.workspaces.getById(workspaceId);
      if (!workspace || workspace.kind === "remote") {
        continue;
      }
      input.config.ensureWorkspaceConfig(workspaceId);
      input.files.emitReloadEvent(workspaceId, kindConfig[kind].reloadReason, {
        action,
        name,
        path: kind === "skills" ? workspaceSkillPath(workspace, normalizeManagedKey(name, workspaceId)) : undefined,
        type: kindConfig[kind].triggerType,
      });
      await input.files.recordWorkspaceAudit(
        workspaceId,
        `${kind}.${action}`,
        workspace.dataDir ?? workspaceId,
        `${action === "removed" ? "Removed" : action === "updated" ? "Updated" : "Added"} ${kind} item ${name} through Server V2.`,
      );
    }
  }

  function upsertManaged(kind: ManagedKind, payload: {
    auth?: JsonObject | null;
    cloudItemId?: string | null;
    config?: JsonObject;
    displayName: string;
    id?: string;
    key?: string | null;
    metadata?: JsonObject | null;
    source?: ManagedConfigRecord["source"];
    workspaceIds?: string[];
  }) {
    const displayName = payload.displayName.trim();
    if (!displayName) {
      throw new RouteError(400, "invalid_request", "displayName is required.");
    }
    const key = normalizeManagedKey(payload.key?.trim() || displayName, kind.slice(0, -1));
    const id = payload.id?.trim() || `${kind.slice(0, -1)}_${randomUUID()}`;
    const workspaceIds = Array.from(new Set((payload.workspaceIds ?? []).map((value) => value.trim()).filter(Boolean)));
    for (const workspaceId of workspaceIds) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
    }
    const item = kindConfig[kind].itemRepo.upsert({
      auth: payload.auth ?? null,
      cloudItemId: payload.cloudItemId ?? null,
      config: payload.config ?? {},
      displayName,
      id,
      key,
      metadata: payload.metadata ?? null,
      source: payload.source ?? "openwork_managed",
    });
    if (payload.workspaceIds) {
      const currentAssignments = kindConfig[kind].assignmentRepo.listForItem(item.id).map((assignment) => assignment.workspaceId);
      for (const workspace of input.repositories.workspaces.list({ includeHidden: true })) {
        if (workspace.kind === "remote") {
          continue;
        }
        const nextAssigned = workspaceIds.includes(workspace.id);
        const currentlyAssigned = currentAssignments.includes(workspace.id);
        if (nextAssigned === currentlyAssigned) {
          continue;
        }
        const currentForWorkspace = kindConfig[kind].assignmentRepo.listForWorkspace(workspace.id).map((assignment) => assignment.itemId);
        const nextForWorkspace = nextAssigned
          ? Array.from(new Set([...currentForWorkspace, item.id]))
          : currentForWorkspace.filter((candidate) => candidate !== item.id);
        kindConfig[kind].assignmentRepo.replaceAssignments(workspace.id, nextForWorkspace);
      }
    }
    return summaryForKind(kind, item);
  }

  async function updateAssignments(kind: ManagedKind, itemId: string, workspaceIds: string[]) {
    const item = kindConfig[kind].itemRepo.getById(itemId);
    if (!item) {
      throw new HTTPException(404, { message: `${kind} item not found: ${itemId}` });
    }
    const normalizedWorkspaceIds = Array.from(new Set(workspaceIds.map((value) => value.trim()).filter(Boolean)));
    for (const workspaceId of normalizedWorkspaceIds) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
    }
    const changedWorkspaceIds = new Set<string>();
    for (const workspace of input.repositories.workspaces.list({ includeHidden: true })) {
      if (workspace.kind === "remote") {
        continue;
      }
      const currentForWorkspace = kindConfig[kind].assignmentRepo.listForWorkspace(workspace.id).map((assignment) => assignment.itemId);
      const currentlyAssigned = currentForWorkspace.includes(itemId);
      const nextAssigned = normalizedWorkspaceIds.includes(workspace.id);
      if (currentlyAssigned === nextAssigned) {
        continue;
      }
      const nextItemIds = nextAssigned
        ? Array.from(new Set([...currentForWorkspace, itemId]))
        : currentForWorkspace.filter((candidate) => candidate !== itemId);
      kindConfig[kind].assignmentRepo.replaceAssignments(workspace.id, nextItemIds);
      changedWorkspaceIds.add(workspace.id);
    }
    await materializeAssignments(kind, Array.from(changedWorkspaceIds), "updated", item.displayName);
    return summaryForKind(kind, item);
  }

  return {
    listManaged(kind: ManagedKind) {
      return kindConfig[kind].itemRepo.list().map((item) => summaryForKind(kind, item));
    },

    createManaged(kind: ManagedKind, payload: Parameters<typeof upsertManaged>[1]) {
      return upsertManaged(kind, payload);
    },

    async deleteManaged(kind: ManagedKind, itemId: string) {
      const item = kindConfig[kind].itemRepo.getById(itemId);
      if (!item) {
        throw new HTTPException(404, { message: `${kind} item not found: ${itemId}` });
      }
      const workspaceIds = kindConfig[kind].assignmentRepo.listForItem(itemId).map((assignment) => assignment.workspaceId);
      kindConfig[kind].assignmentRepo.deleteForItem(itemId);
      kindConfig[kind].itemRepo.deleteById(itemId);
      await materializeAssignments(kind, workspaceIds, "removed", item.displayName);
      return { deleted: true, id: itemId };
    },

    updateManaged(kind: ManagedKind, itemId: string, payload: Omit<Parameters<typeof upsertManaged>[1], "id">) {
      const existing = kindConfig[kind].itemRepo.getById(itemId);
      if (!existing) {
        throw new HTTPException(404, { message: `${kind} item not found: ${itemId}` });
      }
      return upsertManaged(kind, {
        auth: payload.auth ?? existing.auth,
        cloudItemId: payload.cloudItemId ?? existing.cloudItemId,
        config: payload.config ?? existing.config,
        displayName: payload.displayName || existing.displayName,
        id: itemId,
        key: payload.key ?? existing.key,
        metadata: payload.metadata ?? existing.metadata,
        source: payload.source ?? existing.source,
        workspaceIds: payload.workspaceIds,
      });
    },

    updateAssignments,

    listWorkspaceMcp(workspaceId: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      return kindConfig.mcps.assignmentRepo.listForWorkspace(workspaceId)
        .map((assignment) => input.repositories.mcps.getById(assignment.itemId))
        .filter(Boolean)
        .map((item) => ({
          config: item!.config,
          name: item!.key ?? item!.displayName,
          source: "config.project" as const,
        }));
    },

    async addWorkspaceMcp(workspaceId: string, payload: { config: Record<string, unknown>; name: string }) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      validateMcpName(payload.name);
      validateMcpConfig(payload.config);
      const key = normalizeManagedKey(payload.name, "mcp");
      const existing = this.listManaged("mcps").find((item) => item.key === key && item.workspaceIds.includes(workspaceId)) ?? null;
      const item = upsertManaged("mcps", {
        config: payload.config,
        displayName: payload.name,
        id: existing?.id,
        key,
        metadata: { workspaceId },
        workspaceIds: [workspace.id],
      });
      await materializeAssignments("mcps", [workspaceId], existing ? "updated" : "added", item.displayName);
      return { items: this.listWorkspaceMcp(workspaceId) };
    },

    async removeWorkspaceMcp(workspaceId: string, name: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const key = normalizeManagedKey(name, "mcp");
      const assignment = this.listManaged("mcps").find((item) => item.key === key && item.workspaceIds.includes(workspaceId)) ?? null;
      if (!assignment) {
        return { items: this.listWorkspaceMcp(workspaceId) };
      }
      const nextWorkspaceIds = assignment.workspaceIds.filter((candidate) => candidate !== workspaceId);
      if (nextWorkspaceIds.length === 0) {
        await this.deleteManaged("mcps", assignment.id);
      } else {
        await updateAssignments("mcps", assignment.id, nextWorkspaceIds);
      }
      return { items: this.listWorkspaceMcp(workspaceId) };
    },

    listWorkspacePlugins(workspaceId: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const items = kindConfig.plugins.assignmentRepo.listForWorkspace(workspaceId)
        .map((assignment) => input.repositories.plugins.getById(assignment.itemId))
        .filter(Boolean)
        .map((item) => ({
          scope: "project" as const,
          source: "config" as const,
          spec: typeof asObject(item!.config).spec === "string" ? String(asObject(item!.config).spec) : item!.displayName,
        }));
      return { items, loadOrder: ["config.global", "config.project", "dir.global", "dir.project"] };
    },

    async addWorkspacePlugin(workspaceId: string, spec: string) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const normalizedSpec = spec.trim();
      if (!normalizedSpec) {
        throw new RouteError(400, "invalid_request", "Plugin spec is required.");
      }
      const key = normalizeManagedKey(normalizedSpec.replace(/^file:/, ""), "plugin");
      const existing = this.listManaged("plugins").find((item) => item.key === key && item.workspaceIds.includes(workspaceId)) ?? null;
      const item = upsertManaged("plugins", {
        config: { spec: normalizedSpec },
        displayName: normalizedSpec,
        id: existing?.id,
        key,
        metadata: { workspaceId },
        workspaceIds: [workspace.id],
      });
      await materializeAssignments("plugins", [workspaceId], existing ? "updated" : "added", item.displayName);
      return this.listWorkspacePlugins(workspaceId);
    },

    async removeWorkspacePlugin(workspaceId: string, spec: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const key = normalizeManagedKey(spec.replace(/^file:/, ""), "plugin");
      const assignment = this.listManaged("plugins").find((item) => item.key === key && item.workspaceIds.includes(workspaceId)) ?? null;
      if (!assignment) {
        return this.listWorkspacePlugins(workspaceId);
      }
      const nextWorkspaceIds = assignment.workspaceIds.filter((candidate) => candidate !== workspaceId);
      if (nextWorkspaceIds.length === 0) {
        await this.deleteManaged("plugins", assignment.id);
      } else {
        await updateAssignments("plugins", assignment.id, nextWorkspaceIds);
      }
      return this.listWorkspacePlugins(workspaceId);
    },

    listWorkspaceSkills(workspaceId: string) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      return kindConfig.skills.assignmentRepo.listForWorkspace(workspaceId)
        .map((assignment) => input.repositories.skills.getById(assignment.itemId))
        .filter(Boolean)
        .map((item) => ({
          description: typeof asObject(item!.metadata).description === "string" ? String(asObject(item!.metadata).description) : item!.displayName,
          name: item!.key ?? item!.displayName,
          path: workspaceSkillPath(workspace, item!.key ?? item!.id),
          scope: "project" as const,
          trigger: typeof asObject(item!.metadata).trigger === "string" ? String(asObject(item!.metadata).trigger) : undefined,
        }));
    },

    getWorkspaceSkill(workspaceId: string, name: string) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const key = normalizeManagedKey(name, "skill");
      const skill = this.listManaged("skills").find((item) => item.key === key && item.workspaceIds.includes(workspaceId)) ?? null;
      if (!skill) {
        throw new HTTPException(404, { message: `Skill not found: ${name}` });
      }
      const content = typeof asObject(skill.config).content === "string" ? String(asObject(skill.config).content) : "";
      return {
        content,
        item: {
          description: typeof asObject(skill.metadata).description === "string" ? String(asObject(skill.metadata).description) : skill.displayName,
          name: skill.key ?? skill.displayName,
          path: workspaceSkillPath(workspace, skill.key ?? skill.id),
          scope: "project" as const,
          trigger: typeof asObject(skill.metadata).trigger === "string" ? String(asObject(skill.metadata).trigger) : undefined,
        },
      };
    },

    async upsertWorkspaceSkill(workspaceId: string, payload: {
      cloudItemId?: string | null;
      content: string;
      description?: string;
      metadata?: JsonObject | null;
      name: string;
      source?: ManagedConfigRecord["source"];
      trigger?: string;
    }) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      validateSkillName(payload.name);
      if (!payload.content.trim()) {
        throw new RouteError(400, "invalid_request", "Skill content is required.");
      }
      const parsed = parseFrontmatter(payload.content);
      const frontmatterName = typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
      if (frontmatterName && frontmatterName !== payload.name) {
        throw new RouteError(400, "invalid_request", "Skill frontmatter name must match payload name.");
      }
      const nextDescription = normalizeString(parsed.data.description) || normalizeString(payload.description) || payload.name;
      const trigger = normalizeString(parsed.data.trigger) || normalizeString(parsed.data.when) || normalizeString(payload.trigger) || extractTriggerFromBody(parsed.body);
      const content = Object.keys(parsed.data).length > 0
        ? `${buildFrontmatter({ ...parsed.data, description: nextDescription, name: payload.name })}${parsed.body.replace(/^\n/, "")}`
        : `${buildFrontmatter({ description: nextDescription, name: payload.name, ...(trigger ? { trigger } : {}) })}${payload.content.replace(/^\n/, "")}`;
      const existing = this.listManaged("skills").find((item) => item.key === payload.name && item.workspaceIds.includes(workspaceId)) ?? null;
      const nextMetadata = {
        ...(existing?.metadata ?? {}),
        ...(payload.metadata ?? {}),
        description: nextDescription,
        trigger,
        workspaceId,
      } satisfies JsonObject;
      const item = upsertManaged("skills", {
        cloudItemId: payload.cloudItemId ?? existing?.cloudItemId ?? null,
        config: { content: content.endsWith("\n") ? content : `${content}\n` },
        displayName: payload.name,
        id: existing?.id,
        key: payload.name,
        metadata: nextMetadata,
        source: payload.source ?? existing?.source ?? "openwork_managed",
        workspaceIds: [workspace.id],
      });
      await materializeAssignments("skills", [workspaceId], existing ? "updated" : "added", item.displayName);
      return this.getWorkspaceSkill(workspaceId, payload.name).item;
    },

    async deleteWorkspaceSkill(workspaceId: string, name: string) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const key = normalizeManagedKey(name, "skill");
      const assignment = this.listManaged("skills").find((item) => item.key === key && item.workspaceIds.includes(workspaceId)) ?? null;
      if (!assignment) {
        throw new HTTPException(404, { message: `Skill not found: ${name}` });
      }
      const nextWorkspaceIds = assignment.workspaceIds.filter((candidate) => candidate !== workspaceId);
      if (nextWorkspaceIds.length === 0) {
        await this.deleteManaged("skills", assignment.id);
      } else {
        await updateAssignments("skills", assignment.id, nextWorkspaceIds);
      }
      return { path: workspaceSkillPath(workspace, key).replace(/[/\\]SKILL\.md$/, "") };
    },

    async listHubSkills(repo?: Partial<HubRepo>) {
      const resolvedRepo: HubRepo = {
        owner: normalizeString(repo?.owner) || DEFAULT_HUB_REPO.owner,
        repo: normalizeString(repo?.repo) || DEFAULT_HUB_REPO.repo,
        ref: normalizeString(repo?.ref) || DEFAULT_HUB_REPO.ref,
      };
      const listing = await fetch(`https://api.github.com/repos/${encodeURIComponent(resolvedRepo.owner)}/${encodeURIComponent(resolvedRepo.repo)}/contents/skills?ref=${encodeURIComponent(resolvedRepo.ref)}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "openwork-server-v2" },
      });
      if (!listing.ok) {
        throw new RouteError(502, "bad_gateway", `Failed to fetch hub catalog (${listing.status}).`);
      }
      const items = await listing.json() as Array<Record<string, unknown>>;
      const rawBase = `https://raw.githubusercontent.com/${encodeURIComponent(resolvedRepo.owner)}/${encodeURIComponent(resolvedRepo.repo)}/${encodeURIComponent(resolvedRepo.ref)}`;
      const result: Array<{ description: string; name: string; source: { owner: string; path: string; ref: string; repo: string }; trigger?: string }> = [];
      for (const entry of Array.isArray(items) ? items : []) {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        const type = typeof entry?.type === "string" ? entry.type : "";
        if (!name || type !== "dir") {
          continue;
        }
        try {
          const content = await fetch(`${rawBase}/skills/${encodeURIComponent(name)}/SKILL.md`, {
            headers: { Accept: "text/plain", "User-Agent": "openwork-server-v2" },
          }).then((response) => response.ok ? response.text() : "");
          if (!content) {
            continue;
          }
          const parsed = parseFrontmatter(content);
          const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
          const trigger = typeof parsed.data.trigger === "string" ? parsed.data.trigger : extractTriggerFromBody(parsed.body);
          result.push({
            description,
            name,
            source: { owner: resolvedRepo.owner, path: `skills/${name}`, ref: resolvedRepo.ref, repo: resolvedRepo.repo },
            ...(trigger ? { trigger } : {}),
          });
        } catch {
          // ignore individual skill failures
        }
      }
      result.sort((left, right) => left.name.localeCompare(right.name));
      return { items: result };
    },

    async installHubSkill(workspaceId: string, inputValue: { name: string; overwrite?: boolean; repo?: Partial<HubRepo> }) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      validateSkillName(inputValue.name);
      const repo: HubRepo = {
        owner: normalizeString(inputValue.repo?.owner) || DEFAULT_HUB_REPO.owner,
        repo: normalizeString(inputValue.repo?.repo) || DEFAULT_HUB_REPO.repo,
        ref: normalizeString(inputValue.repo?.ref) || DEFAULT_HUB_REPO.ref,
      };
      const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/${encodeURIComponent(repo.ref)}/skills/${encodeURIComponent(inputValue.name)}/SKILL.md`;
      const response = await fetch(rawUrl, {
        headers: { Accept: "text/plain", "User-Agent": "openwork-server-v2" },
      });
      if (!response.ok) {
        throw new RouteError(404, "not_found", `Hub skill not found: ${inputValue.name}`);
      }
      const content = await response.text();
      const existing = this.listManaged("skills").find((item) => item.key === inputValue.name && item.workspaceIds.includes(workspaceId)) ?? null;
      if (existing && inputValue.overwrite !== true) {
        return { action: "updated" as const, name: inputValue.name, path: workspaceSkillPath(workspace, inputValue.name).replace(/[/\\]SKILL\.md$/, ""), skipped: 1, written: 0 };
      }
      const parsed = parseFrontmatter(content);
      const description = typeof parsed.data.description === "string" ? parsed.data.description : inputValue.name;
      const trigger = typeof parsed.data.trigger === "string" ? parsed.data.trigger : extractTriggerFromBody(parsed.body);
      await this.upsertWorkspaceSkill(workspaceId, {
        content,
        description,
        metadata: {
          description,
          install: {
            kind: "hub",
            owner: repo.owner,
            path: `skills/${inputValue.name}`,
            ref: repo.ref,
            repo: repo.repo,
            url: rawUrl,
          },
          trigger,
          workspaceId,
        },
        name: inputValue.name,
        source: "imported",
        trigger,
      });
      return { action: existing ? "updated" as const : "added" as const, name: inputValue.name, path: workspaceSkillPath(workspace, inputValue.name).replace(/[/\\]SKILL\.md$/, ""), skipped: 0, written: 1 };
    },

    getCloudSignin() {
      return input.repositories.cloudSignin.getPrimary();
    },

    clearCloudSignin() {
      input.repositories.cloudSignin.deletePrimary();
      return null;
    },

    upsertCloudSignin(payload: {
      auth?: JsonObject | null;
      cloudBaseUrl: string;
      metadata?: JsonObject | null;
      orgId?: string | null;
      userId?: string | null;
    }) {
      const cloudBaseUrl = normalizeUrl(payload.cloudBaseUrl);
      if (!cloudBaseUrl) {
        throw new RouteError(400, "invalid_request", "cloudBaseUrl must be a valid http(s) URL.");
      }
      return input.repositories.cloudSignin.upsert({
        auth: payload.auth ?? null,
        cloudBaseUrl,
        id: input.repositories.cloudSignin.getPrimary()?.id ?? `cloud_${input.serverId}`,
        lastValidatedAt: null,
        metadata: payload.metadata ?? null,
        orgId: payload.orgId ?? null,
        serverId: input.serverId,
        userId: payload.userId ?? null,
      });
    },

    async validateCloudSignin() {
      const current = input.repositories.cloudSignin.getPrimary();
      if (!current) {
        throw new RouteError(404, "not_found", "Cloud signin is not configured.");
      }
      const auth = asObject(current.auth);
      const token = typeof auth.authToken === "string" ? auth.authToken.trim() : typeof auth.token === "string" ? auth.token.trim() : "";
      if (!token) {
        throw new RouteError(400, "invalid_request", "Cloud signin does not include an auth token.");
      }
      const response = await fetch(`${current.cloudBaseUrl.replace(/\/+$/, "")}/v1/me`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new RouteError(502, "bad_gateway", `Cloud validation failed (${response.status}).`);
      }
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      const validatedUser = readRecord(payload.user) ?? readRecord(payload.me) ?? null;
      const validated = input.repositories.cloudSignin.upsert({
        ...current,
        lastValidatedAt: nowIso(),
        metadata: {
          ...(current.metadata ?? {}),
          validatedUser,
        },
        userId: typeof validatedUser?.id === "string" && validatedUser.id.trim() ? validatedUser.id.trim() : current.userId,
      });
      return {
        lastValidatedAt: validated.lastValidatedAt,
        ok: true,
        record: validated,
      };
    },

    getWorkspaceShare(workspaceId: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      return input.repositories.workspaceShares.getLatestByWorkspace(workspaceId);
    },

    exposeWorkspaceShare(workspaceId: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const existing = input.repositories.workspaceShares.getLatestByWorkspace(workspaceId);
      const record = input.repositories.workspaceShares.upsert({
        accessKey: randomBytes(24).toString("base64url"),
        audit: {
          exposedAt: nowIso(),
          previousShareId: existing?.id ?? null,
        },
        id: existing?.id ?? `share_${workspaceId}`,
        lastUsedAt: existing?.lastUsedAt ?? null,
        revokedAt: null,
        status: "active",
        workspaceId,
      });
      return record;
    },

    revokeWorkspaceShare(workspaceId: string) {
      ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const existing = input.repositories.workspaceShares.getLatestByWorkspace(workspaceId);
      if (!existing) {
        throw new HTTPException(404, { message: `Workspace share not found: ${workspaceId}` });
      }
      return input.repositories.workspaceShares.upsert({
        ...existing,
        accessKey: null,
        audit: {
          ...(existing.audit ?? {}),
          revokedAt: nowIso(),
        },
        revokedAt: nowIso(),
        status: "revoked",
      });
    },

    async exportWorkspace(workspaceId: string, options?: { sensitiveMode?: WorkspaceExportSensitiveMode }) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const sensitiveMode = options?.sensitiveMode ?? "auto";
      const snapshot = await input.config.getWorkspaceConfigSnapshot(workspaceId);
      let opencode = sanitizePortableOpencodeConfig(snapshot.effective.opencode);
      const openwork = sanitizeOpenworkTemplateConfig(snapshot.stored.openwork);
      const skills = kindConfig.skills.assignmentRepo.listForWorkspace(workspaceId)
        .map((assignment) => input.repositories.skills.getById(assignment.itemId))
        .filter(Boolean)
        .map((item) => ({
          content: typeof asObject(item!.config).content === "string" ? String(asObject(item!.config).content) : "",
          description: typeof asObject(item!.metadata).description === "string" ? String(asObject(item!.metadata).description) : undefined,
          name: item!.key ?? item!.displayName,
          trigger: typeof asObject(item!.metadata).trigger === "string" ? String(asObject(item!.metadata).trigger) : undefined,
        }))
        .filter((item) => item.content);
      const commands = listWorkspaceCommands(workspace);
      let files = listPortableFiles(workspace.dataDir!);
      const warnings = collectWorkspaceExportWarnings({ files, opencode: snapshot.effective.opencode });
      if (warnings.length && sensitiveMode === "auto") {
        return { conflict: true as const, warnings };
      }
      if (sensitiveMode === "exclude") {
        const sanitized = stripSensitiveWorkspaceExportData({ files, opencode });
        files = sanitized.files;
        opencode = sanitized.opencode;
      }
      return {
        commands,
        exportedAt: Date.now(),
        ...(files.length ? { files } : {}),
        openwork,
        opencode,
        skills,
        workspaceId,
      };
    },

    async importWorkspace(workspaceId: string, payload: Record<string, unknown>) {
      const workspace = ensureWorkspaceMutable(getWorkspaceOrThrow(workspaceId));
      const modes = asObject(payload.mode);
      const opencode = readRecord(payload.opencode);
      const openwork = readRecord(payload.openwork);
      const skills = Array.isArray(payload.skills) ? payload.skills : [];
      const commands = Array.isArray(payload.commands) ? payload.commands : [];
      const files = Array.isArray(payload.files) ? payload.files : [];

      if (opencode) {
        const sanitizedOpencode = sanitizePortableOpencodeConfig(opencode);
          await input.config.patchWorkspaceConfig(workspaceId, {
            opencode: modes.opencode === "replace" ? sanitizedOpencode : sanitizedOpencode,
          });
      }

      if (openwork) {
          await input.config.patchWorkspaceConfig(workspaceId, {
            openwork: sanitizeOpenworkTemplateConfig(openwork),
          });
      }

      if (skills.length > 0 && modes.skills === "replace") {
        for (const item of this.listManaged("skills").filter((skill) => skill.workspaceIds.includes(workspaceId))) {
          const nextWorkspaceIds = item.workspaceIds.filter((candidate) => candidate !== workspaceId);
          if (nextWorkspaceIds.length === 0) {
            await this.deleteManaged("skills", item.id);
          } else {
            await updateAssignments("skills", item.id, nextWorkspaceIds);
          }
        }
      }

      for (const item of skills) {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
        if (!record) {
          continue;
        }
        const name = normalizeString(record.name);
        const content = typeof record.content === "string" ? record.content : "";
        const description = normalizeString(record.description) || undefined;
        const trigger = normalizeString(record.trigger) || undefined;
        if (name && content) {
          await this.upsertWorkspaceSkill(workspaceId, {
            content,
            description,
            metadata: {
              description,
              importedVia: "portable_bundle",
              sourceBundleWorkspaceId: normalizeString(payload.workspaceId) || null,
              trigger,
              workspaceId,
            },
            name,
            source: "imported",
            trigger,
          });
        }
      }

      if (commands.length > 0) {
        if (modes.commands === "replace") {
          clearWorkspaceCommands(workspace);
        }
        for (const item of commands) {
          const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
          if (!record) {
            continue;
          }
          const parsedContent = typeof record.content === "string" ? parseFrontmatter(record.content) : null;
          const name = normalizeString(record.name) || normalizeString(parsedContent?.data.name);
          const description = normalizeString(record.description) || normalizeString(parsedContent?.data.description) || undefined;
          const template = typeof record.template === "string"
            ? record.template
            : parsedContent
              ? parsedContent.body.trim()
              : "";
          if (name && template) {
            upsertWorkspaceCommand(workspace, { description, name, template });
          }
        }
      }

      if (files.length > 0) {
        writePortableFiles(workspace.dataDir!, files, { replace: modes.files === "replace" });
      }

      input.config.ensureWorkspaceConfig(workspaceId);
      input.files.emitReloadEvent(workspaceId, "config", {
        action: "updated",
        name: "workspace-import",
        type: "config",
      });
      await input.files.recordWorkspaceAudit(workspaceId, "workspace.import", workspace.dataDir ?? workspaceId, "Imported portable workspace data through Server V2.");
      return { ok: true };
    },

    async publishSharedBundle(inputValue: { bundleType: string; name?: string; payload: unknown; timeoutMs?: number }) {
      const bundleType = normalizeString(inputValue.bundleType);
      if (!ALLOWED_BUNDLE_TYPES.has(bundleType)) {
        throw new RouteError(400, "invalid_request", `Unsupported bundle type: ${bundleType || "unknown"}`);
      }
      const timeoutMs = typeof inputValue.timeoutMs === "number" && Number.isFinite(inputValue.timeoutMs) ? inputValue.timeoutMs : 15_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
      try {
        const response = await fetch(`${resolvePublisherBaseUrl().replace(/\/+$/, "")}/v1/bundles`, {
          body: JSON.stringify(inputValue.payload),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: resolvePublisherOrigin(),
            ...(normalizeString(inputValue.name) ? { "X-OpenWork-Name": normalizeString(inputValue.name) } : {}),
            "X-OpenWork-Bundle-Type": bundleType,
            "X-OpenWork-Schema-Version": "v1",
          },
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          throw new RouteError(502, "bad_gateway", "Publisher redirects are not allowed.");
        }
        if (!response.ok) {
          const details = readErrorMessage(await response.text());
          throw new RouteError(502, "bad_gateway", `Publish failed (${response.status})${details ? `: ${details}` : ""}`);
        }
        const json = await response.json() as Record<string, unknown>;
        const url = normalizeString(json.url);
        if (!url) {
          throw new RouteError(502, "bad_gateway", "Publisher response missing url.");
        }
        return { url };
      } catch (error) {
        if (error instanceof RouteError) {
          throw error;
        }
        throw new RouteError(502, "bad_gateway", `Failed to publish bundle: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    },

    async fetchSharedBundle(bundleUrl: unknown, options?: { timeoutMs?: number }) {
      const url = normalizeBundleFetchUrl(bundleUrl);
      const timeoutMs = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          throw new RouteError(502, "bad_gateway", "Shared bundle redirects are not allowed.");
        }
        if (!response.ok) {
          const details = readErrorMessage(await response.text());
          throw new RouteError(502, "bad_gateway", `Failed to fetch bundle (${response.status})${details ? `: ${details}` : ""}`);
        }
        return await response.json();
      } catch (error) {
        if (error instanceof RouteError) {
          throw error;
        }
        throw new RouteError(502, "bad_gateway", `Failed to fetch bundle: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
