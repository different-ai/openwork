import { parse as parseJsonc } from "jsonc-parser";

import type { PreviewItem } from "../../components/share-home-types.ts";
import { humanizeType, maybeArray, maybeString, parseFrontmatter } from "./share-utils.ts";
import type { Frontmatter, NormalizedFile, PackageInput, PackageResult, PackageSummary } from "./types.ts";

const MAX_FILES = 200;
const SECRET_KEY_RE = /(token|secret|password|api[-_]?key|authorization|bearer|private[-_]?key|client[-_]?secret)/i;
const SAFE_SECRET_VALUE_RE = /^(\$\{|\{env:|env\.|process\.env\.|<|YOUR_|REPLACE_ME|example|changeme)/i;
const AGENT_FRONTMATTER_KEYS = new Set(["mode", "model", "tools", "permission", "temperature", "color", "prompt"]);
const OPENCODE_CONFIG_KEYS = new Set(["model", "autoupdate", "server", "provider", "plugin", "mcp", "agent", "permission"]);
const SKILL_NAME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "identity",
  "into",
  "my",
  "of",
  "or",
  "parameters",
  "scope",
  "skill",
  "skills",
  "that",
  "the",
  "this",
  "to",
  "trigger",
  "when",
  "with",
  "your",
]);

function normalizePath(input: unknown): string {
  return String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  return normalized.split("/").pop() ?? normalized;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized || !normalized.includes("/")) return "";
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function stem(path: string): string {
  const name = basename(path);
  return name.replace(/\.[^.]+$/, "");
}

function slugify(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeFile(input: { path?: string; webkitRelativePath?: string; name?: string; content?: string }, index: number): NormalizedFile {
  const path = normalizePath(input.path || input.webkitRelativePath || input.name || `file-${index + 1}`);
  const name = basename(path) || `file-${index + 1}`;
  const content = String(input.content ?? "").replace(/^\uFEFF/, "");
  return { path, name, content };
}

function isMarkdownFile(file: NormalizedFile): boolean {
  return /\.md$/i.test(file.name);
}

function isJsonFile(file: NormalizedFile): boolean {
  return /\.jsonc?$/i.test(file.name);
}

function isSkillFile(file: NormalizedFile): boolean {
  const lowerPath = file.path.toLowerCase();
  return /^(skills?|skill)\.md$/i.test(basename(lowerPath)) || /(^|\/)\.opencode\/skills\//.test(lowerPath) || /(^|\/)skills\//.test(lowerPath);
}

function isCommandFile(file: NormalizedFile): boolean {
  return /(^|\/)\.opencode\/commands\//.test(file.path.toLowerCase()) || /(^|\/)commands\//.test(file.path.toLowerCase());
}

function isAgentFile(file: NormalizedFile, frontmatterData: Record<string, unknown>): boolean {
  const lowerPath = file.path.toLowerCase();
  if (/(^|\/)\.opencode\/agents\//.test(lowerPath) || /(^|\/)agents\//.test(lowerPath) || /(^|\/)agents?\.md$/i.test(lowerPath)) {
    return true;
  }
  return Object.keys(frontmatterData).some((key) => AGENT_FRONTMATTER_KEYS.has(key));
}

function isOpenworkConfigFile(file: NormalizedFile): boolean {
  return /(^|\/)(?:\.opencode\/)?openwork\.jsonc?$/i.test(file.path);
}

function isOpencodeConfigFile(file: NormalizedFile): boolean {
  return /(^|\/)opencode\.jsonc?$/i.test(file.path);
}

function looksLikeNamedMcpFile(file: NormalizedFile): boolean {
  return /(^|\/)mcp\//i.test(file.path) || /\.mcp\.jsonc?$/i.test(file.name) || /(^|[._-])mcp(?:[_-]?config)?\.jsonc?$/i.test(file.name);
}

function looksLikeNamedAgentJsonFile(file: NormalizedFile): boolean {
  return /(^|\/)agents\//i.test(file.path) || /\.agent\.jsonc?$/i.test(file.name);
}

function resolveName(preferred: unknown, fallback: unknown): string {
  const fromPreferred = slugify(preferred);
  if (fromPreferred) return fromPreferred;
  const fromFallback = slugify(fallback);
  if (fromFallback) return fromFallback;
  return `item-${Date.now()}`;
}

function normalizeNameTokens(value: string): string[] {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token && token.length > 2 && !SKILL_NAME_STOPWORDS.has(token));
}

function inferSkillName(file: NormalizedFile, frontmatter: Frontmatter): string {
  const candidateLines = [
    ...Array.from(frontmatter.body.matchAll(/^#{1,6}\s+(.+)$/gm)).map((match) => match[1] ?? ""),
    ...frontmatter.body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12),
  ];

  for (const line of candidateLines) {
    const tokens = normalizeNameTokens(line);
    if (tokens.length >= 2) {
      return `${tokens[0]}-${tokens[1]}`;
    }
    if (tokens.length === 1) {
      return tokens[0];
    }
  }

  const stemName = slugify(stem(file.path));
  if (stemName && stemName !== "skill" && stemName !== "clipboard") {
    return stemName;
  }

  return "shared-skill";
}

function buildPreviewItem(name: string, kind: PreviewItem["kind"], meta: string, tone: PreviewItem["tone"]): PreviewItem {
  return { name, kind, meta, tone };
}

function countMatches(text: string, token: string): number {
  if (!text) return 0;
  return (text.match(new RegExp(`\\b${token}\\b`, "gi")) || []).length;
}

function collectHeadings(content: string): string {
  return Array.from(content.matchAll(/^#{1,3}\s+(.+)$/gm))
    .map((match) => match[1])
    .join("\n");
}

function inferMarkdownKind(file: NormalizedFile, frontmatterData: Record<string, unknown>): "agent" | "skill" {
  const lowerPath = file.path.toLowerCase();
  const lowerContent = file.content.toLowerCase();
  const headings = collectHeadings(file.content).toLowerCase();
  let agentScore = 0;
  let skillScore = 0;

  if (/^agents?\.md$/i.test(basename(lowerPath))) {
    agentScore += 4;
  }
  if (/^skills?\.md$/i.test(basename(lowerPath))) {
    skillScore += 4;
  }

  agentScore += countMatches(lowerContent, "agent");
  skillScore += countMatches(lowerContent, "skill");
  agentScore += countMatches(headings, "agent") * 2;
  skillScore += countMatches(headings, "skill") * 2;

  if ("trigger" in frontmatterData) {
    skillScore += 3;
  }

  return agentScore > skillScore ? "agent" : "skill";
}

interface SkillRecord {
  name: string;
  description: string;
  trigger: string;
  content: string;
  preview: PreviewItem;
}

function buildSkillRecord(file: NormalizedFile, warnings: string[], frontmatter: Frontmatter): SkillRecord | null {
  const { data } = frontmatter;
  const name = maybeString(data.name).trim();
  const description = maybeString(data.description).trim();
  const trigger = typeof data.trigger === "string" ? data.trigger.trim() : "";
  const version = typeof data.version === "string" ? data.version.trim() : "";
  if (!name || !description) {
    warnings.push(`Skill files need frontmatter with both name and description: ${file.path}`);
    return null;
  }
  if (!frontmatter.body.trim()) {
    warnings.push(`Ignored empty skill file: ${file.path}`);
    return null;
  }
  return {
    name: resolveName(name, name),
    description,
    trigger,
    content: file.content,
    preview: buildPreviewItem(name, "Skill", version ? `v${version}` : trigger ? `Trigger · ${trigger}` : "Skill", "skill"),
  };
}

interface AgentRecord {
  name: string;
  config: Record<string, unknown>;
  preview: PreviewItem;
}

function buildAgentRecord(file: NormalizedFile, warnings: string[], frontmatter: Frontmatter): AgentRecord | null {
  const { data, body } = frontmatter;
  const name = resolveName(data.name, stem(file.path));
  if (!name) {
    warnings.push(`Ignored agent without a valid name: ${file.path}`);
    return null;
  }

  const config: Record<string, unknown> = { ...data };
  delete config.name;
  const promptBody = body.trim();
  if (promptBody && typeof config.prompt !== "string") {
    config.prompt = promptBody;
  }

  const version = typeof config.version === "string" ? config.version.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";

  return {
    name,
    config,
    preview: buildPreviewItem(name, "Agent", version ? `v${version}` : model || "Agent config", "agent"),
  };
}

interface CommandRecord {
  name: string;
  description: string;
  template: string;
  agent: string;
  model: string;
  subtask: boolean;
  preview: PreviewItem;
}

function buildCommandRecord(file: NormalizedFile, warnings: string[], frontmatter: Frontmatter): CommandRecord | null {
  const { data, body } = frontmatter;
  const name = resolveName(data.name, stem(file.path));
  const template = body.trim();
  if (!name || !template) {
    warnings.push(`Ignored command without template: ${file.path}`);
    return null;
  }

  return {
    name,
    description: typeof data.description === "string" ? data.description.trim() : "",
    template,
    agent: typeof data.agent === "string" ? data.agent.trim() : "",
    model: typeof data.model === "string" ? data.model.trim() : "",
    subtask: data.subtask === true,
    preview: buildPreviewItem(name, "Command", data.agent ? `Agent · ${data.agent}` : "Command", "command"),
  };
}

function parseJsonConfig(file: NormalizedFile): unknown {
  try {
    return parseJsonc(file.content);
  } catch {
    throw new Error(`Could not parse ${file.path} as JSON/JSONC`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfigSections(target: Record<string, unknown> | null, source: Record<string, unknown> | null): Record<string, unknown> {
  if (!source) return target ?? {};
  const output: Record<string, unknown> = isRecord(target) ? cloneRecord(target) : {};

  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = mergeConfigSections(output[key] as Record<string, unknown>, value);
      continue;
    }

    output[key] = cloneRecord(value);
  }

  return output;
}

function buildConfigPreview(file: NormalizedFile, meta: string): PreviewItem {
  return buildPreviewItem(basename(file.path) || stem(file.path), "Config", meta, "config");
}

function collectOpencodePreviewItems(parsed: Record<string, unknown>): PreviewItem[] {
  const preview: PreviewItem[] = [];

  if (isRecord(parsed?.mcp) && Object.keys(parsed.mcp as Record<string, unknown>).length) {
    for (const [name, entry] of Object.entries(parsed.mcp as Record<string, unknown>)) {
      const meta = isRecord(entry) && typeof entry.type === "string" ? `${humanizeType(entry.type)} MCP` : "MCP config";
      preview.push(buildPreviewItem(name, "MCP", meta, "mcp"));
    }
  }

  if (isRecord(parsed?.agent) && Object.keys(parsed.agent as Record<string, unknown>).length) {
    for (const [name, entry] of Object.entries(parsed.agent as Record<string, unknown>)) {
      const meta = isRecord(entry) && typeof entry.model === "string" ? entry.model : "Agent config";
      preview.push(buildPreviewItem(name, "Agent", meta, "agent"));
    }
  }

  return preview;
}

function looksLikeMcpShape(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;

  const schema = maybeString(parsed.$schema).toLowerCase();
  if (schema.includes("modelcontextprotocol") || schema.includes("mcp")) {
    return true;
  }

  if (maybeArray(parsed.packages).length || maybeArray(parsed.remotes).length) {
    return true;
  }

  const hasTransport = typeof parsed.type === "string" && (typeof parsed.url === "string" || typeof parsed.command === "string");
  const hasCommandRuntime = typeof parsed.command === "string" || maybeArray(parsed.args).length > 0;
  return hasTransport || hasCommandRuntime;
}

function looksLikeOpencodeShape(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;

  const schema = maybeString(parsed.$schema).toLowerCase();
  if (schema.includes("opencode") && schema.includes("config")) {
    return true;
  }

  let matchedKeys = 0;
  for (const key of Object.keys(parsed)) {
    if (OPENCODE_CONFIG_KEYS.has(key)) matchedKeys += 1;
  }
  return matchedKeys >= 2;
}

function looksLikeOpenworkShape(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;

  const schema = maybeString(parsed.$schema).toLowerCase();
  return schema.includes("openwork") && schema.includes("config");
}

function redactSecrets(value: unknown, prefix: string[] = [], hits: string[] = []): string[] {
  if (!value || typeof value !== "object") return hits;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPrefix = [...prefix, key];
    if (SECRET_KEY_RE.test(key) && typeof child === "string" && child.trim() && !SAFE_SECRET_VALUE_RE.test(child.trim())) {
      hits.push(nextPrefix.join("."));
      (value as Record<string, unknown>)[key] = "********";
    }
    if (typeof child === "object") {
      redactSecrets(child, nextPrefix, hits);
    }
  }

  return hits;
}

interface ConfigSection {
  opencode: Record<string, unknown> | null;
  openwork: Record<string, unknown> | null;
  config: Record<string, unknown>;
  preview: PreviewItem[];
  configCount: number;
}

function readConfigSection(file: NormalizedFile, warnings: string[]): ConfigSection | null {
  const parsed = parseJsonConfig(file);
  if (!isRecord(parsed)) {
    throw new Error(`Expected ${file.path} to contain an object`);
  }

  let opencode: Record<string, unknown> | null = null;
  let openwork: Record<string, unknown> | null = null;
  const config: Record<string, unknown> = {};
  const preview: PreviewItem[] = [];
  let configCount = 0;

  if (isOpenworkConfigFile(file)) {
    openwork = cloneRecord(parsed);
    preview.push(buildConfigPreview(file, "OpenWork config"));
    configCount += 1;
  }

  if (isOpencodeConfigFile(file)) {
    opencode = cloneRecord(parsed);
    preview.push(buildConfigPreview(file, "OpenCode config"));
    preview.push(...collectOpencodePreviewItems(parsed));
    configCount += 1;
  }

  if (!opencode && !openwork) {
    if (looksLikeNamedMcpFile(file)) {
      const name = resolveName("", stem(file.path));
      opencode = { mcp: { [name]: cloneRecord(parsed) } };
      const meta = typeof parsed.type === "string" ? `${humanizeType(parsed.type)} MCP` : "MCP config";
      preview.push(buildPreviewItem(name, "MCP", meta, "mcp"));
    } else if (looksLikeOpencodeShape(parsed)) {
      opencode = cloneRecord(parsed);
      preview.push(buildConfigPreview(file, "OpenCode config"));
      preview.push(...collectOpencodePreviewItems(parsed));
      configCount += 1;
    } else if (looksLikeOpenworkShape(parsed)) {
      openwork = cloneRecord(parsed);
      preview.push(buildConfigPreview(file, "OpenWork config"));
      configCount += 1;
    } else if (looksLikeMcpShape(parsed)) {
      const name = resolveName(parsed.name, stem(file.path));
      opencode = { mcp: { [name]: cloneRecord(parsed) } };
      preview.push(buildPreviewItem(maybeString(parsed.title).trim() || name, "MCP", "MCP config", "mcp"));
    } else if (looksLikeNamedAgentJsonFile(file)) {
      const name = resolveName(parsed.name, stem(file.path));
      opencode = { agent: { [name]: cloneRecord(parsed) } };
      const meta = typeof parsed.model === "string" ? parsed.model : "Agent config";
      preview.push(buildPreviewItem(name, "Agent", meta, "agent"));
    } else {
      const name = resolveName("", stem(file.path));
      config[name] = cloneRecord(parsed);
      preview.push(buildPreviewItem(basename(file.path) || name, "Config", "Config file", "config"));
      configCount += 1;
    }
  }

  const secretHits = [
    ...redactSecrets(opencode ?? {}, ["opencode"]),
    ...redactSecrets(openwork ?? {}, ["openwork"]),
    ...redactSecrets(config, ["config"]),
  ];

  if (secretHits.length) {
    warnings.push(`Redacted ${secretHits.length} potential secret${secretHits.length === 1 ? "" : "s"} in ${file.path}: ${secretHits.slice(0, 3).join(", ")}`);
  }

  if (!opencode && !openwork && !Object.keys(config).length) {
    warnings.push(`Ignored unsupported config file: ${file.path}`);
    return null;
  }

  return { opencode, openwork, config, preview, configCount };
}

function mergeNamedObjects(target: Record<string, unknown>, source: Record<string, unknown> | undefined): void {
  for (const [name, value] of Object.entries(source ?? {})) {
    target[name] = value;
  }
}

function buildSummary(
  skills: Record<string, unknown>[],
  agents: Record<string, unknown>,
  mcp: Record<string, unknown>,
  commands: Record<string, unknown>[],
  warnings: string[],
  configCount: number,
): PackageSummary {
  return {
    skills: skills.length,
    agents: Object.keys(agents).length,
    mcpServers: Object.keys(mcp).length,
    commands: commands.length,
    configs: configCount,
    warnings: warnings.length,
  };
}

function buildBundleName(
  inputName: unknown,
  skills: { name: string }[],
  agentCount: number,
  mcpCount: number,
  commandCount: number,
  configCount: number,
): string {
  const explicit = String(inputName ?? "").trim();
  if (explicit) return explicit;
  if (skills.length === 1 && !agentCount && !mcpCount && !commandCount && !configCount) return skills[0].name;
  if (skills.length > 1 && !agentCount && !mcpCount && !commandCount && !configCount) return "Shared skills set";
  if (skills.length === 1) return `${skills[0].name} worker package`;
  return "Packaged worker";
}

function buildBundleDescription(bundleType: string, summary: PackageSummary): string {
  if (bundleType === "skill") return "Single skill bundle generated from dropped markdown.";
  if (bundleType === "skills-set") return `${summary.skills} skills packaged together.`;
  const parts: string[] = [];
  if (summary.skills) parts.push(`${summary.skills} skill${summary.skills === 1 ? "" : "s"}`);
  if (summary.agents) parts.push(`${summary.agents} agent${summary.agents === 1 ? "" : "s"}`);
  if (summary.mcpServers) parts.push(`${summary.mcpServers} MCP${summary.mcpServers === 1 ? "" : "s"}`);
  if (summary.commands) parts.push(`${summary.commands} command${summary.commands === 1 ? "" : "s"}`);
  if (summary.configs) parts.push(`${summary.configs} config${summary.configs === 1 ? "" : "s"}`);
  return parts.length ? `${parts.join(", ")} bundled into a worker package.` : "Worker package generated from shareable files.";
}

export function packageOpenworkFiles(input: PackageInput): PackageResult {
  const rawFiles = Array.isArray(input?.files) ? input.files : [];
  if (!rawFiles.length) {
    throw new Error("Upload or paste a single skill to continue.");
  }
  if (rawFiles.length > MAX_FILES) {
    throw new Error(`Too many files. Package up to ${MAX_FILES} files at once.`);
  }
  if (rawFiles.length !== 1) {
    throw new Error("Upload or paste a single skill to continue.");
  }

  const warnings: string[] = [];
  const skills: SkillRecord[] = [];
  const commands: CommandRecord[] = [];
  const previewItems: PreviewItem[] = [];
  const opencodeAgent: Record<string, unknown> = {};
  const opencodeMcp: Record<string, unknown> = {};
  let opencodeConfig: Record<string, unknown> | null = null;
  const genericConfig: Record<string, unknown> = {};
  let openwork: Record<string, unknown> | null = null;
  let configCount = 0;

  for (let index = 0; index < rawFiles.length; index += 1) {
    const file = normalizeFile(rawFiles[index], index);
    if (!file.content.trim()) {
      throw new Error("Skills need frontmatter with name and description.");
    }

    const frontmatter = parseFrontmatter(file.content);
    const record = buildSkillRecord(file, warnings, frontmatter);
    if (!record) {
      throw new Error("Skills need frontmatter with name and description.");
    }
    skills.push(record);
    previewItems.push(record.preview);
  }

  const cleanSkills = skills.map(({ preview: _preview, ...skill }) => skill);
  const cleanCommands = commands.map(({ preview: _preview, ...command }) => command);

  const summary = buildSummary(cleanSkills, opencodeAgent, opencodeMcp, cleanCommands, warnings, configCount);
  if (!summary.skills && !summary.agents && !summary.mcpServers && !summary.commands && !summary.configs && !openwork) {
    throw new Error("No shareable files found. Drop markdown or JSON/JSONC config files to package them.");
  }

  const hasWorkspaceConfig =
    Boolean(openwork) ||
    Boolean(opencodeConfig) ||
    Object.keys(opencodeAgent).length ||
    Object.keys(opencodeMcp).length ||
    Object.keys(genericConfig).length ||
    cleanCommands.length;
  const name = buildBundleName(input?.bundleName, cleanSkills, summary.agents, summary.mcpServers, summary.commands, summary.configs);

  let bundleType = "workspace-profile";
  let bundle: Record<string, unknown>;
  if (cleanSkills.length === 1 && !hasWorkspaceConfig) {
    bundleType = "skill";
    const skill = cleanSkills[0];
    bundle = {
      schemaVersion: 1,
      type: "skill",
      name: skill.name,
      description: skill.description || undefined,
      trigger: skill.trigger || undefined,
      content: skill.content,
    };
  } else if (cleanSkills.length > 0 && !hasWorkspaceConfig) {
    bundleType = "skills-set";
    bundle = {
      schemaVersion: 1,
      type: "skills-set",
      name,
      description: buildBundleDescription("skills-set", summary),
      skills: cleanSkills,
    };
  } else {
    const workspace: Record<string, unknown> = {
      workspaceId: "share-service-package",
      exportedAt: Date.now(),
      ...(cleanSkills.length ? { skills: cleanSkills } : null),
      ...(cleanCommands.length ? { commands: cleanCommands } : null),
      ...(Object.keys(genericConfig).length ? { config: genericConfig } : null),
      ...(openwork ? { openwork } : null),
      ...((opencodeConfig || Object.keys(opencodeAgent).length || Object.keys(opencodeMcp).length)
        ? {
            opencode: mergeConfigSections(opencodeConfig, {
              ...(Object.keys(opencodeAgent).length ? { agent: opencodeAgent } : null),
              ...(Object.keys(opencodeMcp).length ? { mcp: opencodeMcp } : null),
            }),
          }
        : null),
    };

    bundle = {
      schemaVersion: 1,
      type: "workspace-profile",
      name,
      description: buildBundleDescription("workspace-profile", summary),
      workspace,
    };
  }

  return {
    bundle,
    bundleType,
    name: bundle.name as string,
    summary,
    warnings,
    items: previewItems.slice(0, 12),
  };
}
