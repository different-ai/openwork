import { parse as parseYaml } from "yaml";

import type { PreviewItem } from "../../components/share-home-types.ts";
import type {
  BundleCounts,
  BundleUrls,
  Frontmatter,
  NormalizedBundle,
  NormalizedCommandItem,
  NormalizedSkillItem,
  NormalizedPortableFileItem,
  OgImageUrlSet,
  OpenInAppUrls,
  RequestLike,
  ValidationResult,
} from "./types.ts";
import {
  DEFAULT_OG_IMAGE_VARIANT,
  DEFAULT_TWITTER_IMAGE_VARIANT,
  OG_IMAGE_VARIANTS,
  type OgImageVariant,
} from "./og-image-variants.ts";

export const OPENWORK_SITE_URL = "https://openworklabs.com";
export const OPENWORK_DOWNLOAD_URL = "https://openworklabs.com/download";
export const DEFAULT_PUBLIC_BASE_URL = "https://share.openworklabs.com";
export const SHARE_EASE = "cubic-bezier(0.31, 0.325, 0, 0.92)";

export function maybeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function maybeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function maybeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function getEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function normalizeBaseUrl(input: unknown): string {
  return String(input ?? "").trim().replace(/\/+$/, "");
}

export function getPublicBaseUrl(): string {
  return normalizeBaseUrl(getEnv("PUBLIC_BASE_URL")) || DEFAULT_PUBLIC_BASE_URL;
}

export function setCors(
  res: { setHeader(name: string, value: string): void },
  options: { methods?: string; headers?: string } = {},
): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", options.methods ?? "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    options.headers ??
      "Content-Type,Accept,X-OpenWork-Bundle-Type,X-OpenWork-Schema-Version,X-OpenWork-Name",
  );
}

export function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeJsonForScript(rawJson: string): string {
  return String(rawJson)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function humanizeType(type: unknown): string {
  if (!type) return "Bundle";
  if (String(type).trim().toLowerCase() === "workspace-profile") {
    return "Workspace Template";
  }
  return String(type)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function truncate(value: unknown, maxChars = 3200): string {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n... (truncated for display)`;
}

export function buildRootUrl(_req: RequestLike): string {
  return getPublicBaseUrl();
}

export function buildOgImageUrlFromOrigin(
  origin: string,
  targetId = "root",
  variant: OgImageVariant = DEFAULT_OG_IMAGE_VARIANT,
): string {
  const url = new URL(`${normalizeBaseUrl(origin) || DEFAULT_PUBLIC_BASE_URL}/og/${encodeURIComponent(targetId)}`);
  if (variant !== DEFAULT_OG_IMAGE_VARIANT) {
    url.searchParams.set("variant", variant);
  }
  return url.toString();
}

export function buildOgImageUrl(req: RequestLike, targetId = "root", variant: OgImageVariant = DEFAULT_OG_IMAGE_VARIANT): string {
  const origin = buildRootUrl(req);
  return buildOgImageUrlFromOrigin(origin, targetId, variant);
}

export function buildOgImageUrls(req: RequestLike, targetId = "root"): OgImageUrlSet {
  const origin = buildRootUrl(req);
  return {
    default: buildOgImageUrlFromOrigin(origin, targetId, DEFAULT_OG_IMAGE_VARIANT),
    twitter: buildOgImageUrlFromOrigin(origin, targetId, DEFAULT_TWITTER_IMAGE_VARIANT),
    byVariant: Object.fromEntries(
      Object.keys(OG_IMAGE_VARIANTS).map((variant) => [
        variant,
        buildOgImageUrlFromOrigin(origin, targetId, variant as OgImageVariant),
      ]),
    ) as Record<OgImageVariant, string>,
  };
}

export function buildBundleUrls(req: RequestLike, id: string): BundleUrls {
  const encodedId = encodeURIComponent(id);
  const origin = buildRootUrl(req);
  const path = `/b/${encodedId}`;
  const dataPath = `${path}/data`;

  return {
    shareUrl: `${origin}${path}`,
    jsonUrl: `${origin}${dataPath}`,
    downloadUrl: `${origin}${dataPath}?download=1`,
  };
}

export function buildOpenInAppUrls(shareUrl: string, options: { label?: string } = {}): OpenInAppUrls {
  const query = new URLSearchParams();
  query.set("ow_bundle", shareUrl);
  query.set("ow_intent", "new_worker");
  query.set("ow_source", "share_service");

  const label = String(options.label ?? "").trim();
  if (label) query.set("ow_label", label.slice(0, 120));

  const appScheme = (getEnv("PUBLIC_OPENWORK_APP_SCHEME", "openwork") || "openwork").trim().toLowerCase();
  return {
    openInAppDeepLink: `${appScheme}://import-bundle?${query.toString()}`,
  };
}

export function wantsDownload(req: RequestLike): boolean {
  return String(req.query?.download ?? "").trim() === "1";
}

export function parseFrontmatter(content: unknown): Frontmatter {
  const text = String(content ?? "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: text };
  const raw = match[1] ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = maybeObject(parseYaml(raw)) ?? {};
  } catch {
    data = {};
  }
  return { data, body: text.slice(match[0].length) };
}

function normalizeSkillItem(value: unknown): NormalizedSkillItem | null {
  const record = maybeObject(value);
  if (!record) return null;
  const name = maybeString(record.name).trim();
  const content = maybeString(record.content);
  if (!name || !content.trim()) return null;
  return {
    name,
    description: maybeString(record.description).trim(),
    trigger: maybeString(record.trigger).trim(),
    content,
  };
}

function normalizeCommandItem(value: unknown): NormalizedCommandItem | null {
  const record = maybeObject(value);
  if (!record) return null;
  const name = maybeString(record.name).trim();
  const template = maybeString(record.template);
  const content = maybeString(record.content);
  if (!name || (!template.trim() && !content.trim())) return null;
  return {
    name,
    description: maybeString(record.description).trim(),
    template,
    content,
    agent: maybeString(record.agent).trim(),
    model: maybeString(record.model).trim(),
    subtask: record.subtask === true,
  };
}

function normalizePortableFileItem(value: unknown): NormalizedPortableFileItem | null {
  const record = maybeObject(value);
  if (!record) return null;
  const path = maybeString(record.path).trim();
  if (!path) return null;
  return {
    path,
    content: maybeString(record.content),
  };
}

function workspacePortableFiles(bundle: NormalizedBundle): NormalizedPortableFileItem[] {
  return maybeArray(bundle.workspace?.files)
    .map(normalizePortableFileItem)
    .filter((file): file is NormalizedPortableFileItem => file !== null);
}

function basename(path: string): string {
  const normalized = String(path ?? "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function templateFilePreviewMeta(path: string): { kind: PreviewItem["kind"]; tone: PreviewItem["tone"]; label: string } {
  const normalized = String(path ?? "").toLowerCase();
  if (normalized.startsWith(".opencode/agents/")) {
    return { kind: "Agent", tone: "agent", label: "Agent file" };
  }
  if (normalized.startsWith(".opencode/commands/")) {
    return { kind: "Command", tone: "command", label: "Command file" };
  }
  if (normalized.startsWith(".opencode/skills/")) {
    return { kind: "Skill", tone: "skill", label: "Skill file" };
  }
  return { kind: "Config", tone: "config", label: "Template file" };
}

export function parseBundle(rawJson: string): NormalizedBundle {
  try {
    return normalizeBundleRecord(JSON.parse(rawJson));
  } catch {
    return normalizeBundleRecord(null);
  }
}

function normalizeBundleRecord(parsed: unknown): NormalizedBundle {
  const record = maybeObject(parsed);
  const workspace = maybeObject(record?.workspace);

  return {
    schemaVersion: typeof record?.schemaVersion === "number" ? record.schemaVersion : null,
    type: maybeString(record?.type).trim(),
    name: maybeString(record?.name).trim(),
    description: maybeString(record?.description).trim(),
    trigger: maybeString(record?.trigger).trim(),
    content: maybeString(record?.content),
    workspace,
    skills: maybeArray(record?.skills).map(normalizeSkillItem).filter((s): s is NormalizedSkillItem => s !== null),
    commands: maybeArray(record?.commands).map(normalizeCommandItem).filter((c): c is NormalizedCommandItem => c !== null),
  };
}

export function validateBundlePayload(rawJson: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, message: "Invalid JSON" };
  }

  const bundle = normalizeBundleRecord(parsed);
  if (bundle.schemaVersion !== 1) {
    return { ok: false, message: "Unsupported bundle schema version" };
  }

  if (!["skill", "skills-set", "workspace-profile"].includes(bundle.type)) {
    return { ok: false, message: "Unsupported bundle type" };
  }

  if (bundle.type === "skill") {
    if (!bundle.name || !bundle.content.trim()) {
      return { ok: false, message: "Skill bundles require name and content" };
    }
  }

  if (bundle.type === "skills-set") {
    if (!bundle.skills.length) {
      return { ok: false, message: "Skills set bundle has no importable skills" };
    }
  }

  if (bundle.type === "workspace-profile") {
    if (!bundle.workspace) {
      return { ok: false, message: "Workspace profile bundle is missing workspace payload" };
    }
  }

  return { ok: true, bundle };
}

export function getBundleCounts(bundle: NormalizedBundle): BundleCounts {
  const workspaceSkills = maybeArray(bundle.workspace?.skills).map(normalizeSkillItem).filter((s): s is NormalizedSkillItem => s !== null);
  const opencode = maybeObject(bundle.workspace?.opencode);
  const openwork = maybeObject(bundle.workspace?.openwork);
  const genericConfig = maybeObject(bundle.workspace?.config);
  const commands = maybeArray(bundle.workspace?.commands).map(normalizeCommandItem).filter((c): c is NormalizedCommandItem => c !== null);
  const files = workspacePortableFiles(bundle);
  const agentEntries = Object.entries(maybeObject(opencode?.agent) ?? {});
  const mcpEntries = Object.entries(maybeObject(opencode?.mcp) ?? {});
  const opencodeConfigKeys = Object.keys(opencode ?? {}).filter((key) => !["agent", "mcp"].includes(key));

  return {
    skillCount:
      bundle.type === "skill"
        ? bundle.name
          ? 1
          : 0
        : bundle.type === "skills-set"
          ? bundle.skills.length
          : workspaceSkills.length,
    commandCount: commands.length,
    agentCount: agentEntries.length,
    mcpCount: mcpEntries.length,
    configCount: (openwork ? 1 : 0) + (opencodeConfigKeys.length ? 1 : 0) + Object.keys(genericConfig ?? {}).length,
    fileCount: files.length,
    hasConfig: Boolean(openwork || opencodeConfigKeys.length || genericConfig),
  };
}

function readVersionFromContent(content: string): string {
  const { data } = parseFrontmatter(content);
  const version = maybeString(data.version).trim();
  return version || "";
}

export function collectBundleItems(bundle: NormalizedBundle, limit = 8): PreviewItem[] {
  const items: PreviewItem[] = [];

  if (bundle.type === "skill") {
    items.push({
      name: bundle.name || "Untitled skill",
      kind: "Skill",
      meta: bundle.trigger ? `Trigger · ${bundle.trigger}` : readVersionFromContent(bundle.content) || "Skill bundle",
      tone: "skill",
    });
  }

  if (bundle.type === "skills-set") {
    for (const skill of bundle.skills) {
      items.push({
        name: skill.name,
        kind: "Skill",
        meta: skill.trigger ? `Trigger · ${skill.trigger}` : readVersionFromContent(skill.content) || "Skill",
        tone: "skill",
      });
    }
  }

  if (bundle.type === "workspace-profile") {
    const workspaceSkills = maybeArray(bundle.workspace?.skills).map(normalizeSkillItem).filter((s): s is NormalizedSkillItem => s !== null);
    for (const skill of workspaceSkills) {
      items.push({
        name: skill.name,
        kind: "Skill",
        meta: skill.trigger ? `Trigger · ${skill.trigger}` : readVersionFromContent(skill.content) || "Skill",
        tone: "skill",
      });
    }

    const opencode = maybeObject(bundle.workspace?.opencode);
    for (const [name, config] of Object.entries(maybeObject(opencode?.agent) ?? {})) {
      const entry = maybeObject(config) ?? {};
      const version = maybeString(entry.version).trim();
      const model = maybeString(entry.model).trim();
      items.push({
        name,
        kind: "Agent",
        meta: version ? `v${version}` : model ? model : "Agent config",
        tone: "agent",
      });
    }

    for (const [name, config] of Object.entries(maybeObject(opencode?.mcp) ?? {})) {
      const entry = maybeObject(config) ?? {};
      const type = maybeString(entry.type).trim();
      const url = maybeString(entry.url).trim();
      items.push({
        name,
        kind: "MCP",
        meta: type ? `${humanizeType(type)} MCP` : url ? "Remote MCP" : "MCP config",
        tone: "mcp",
      });
    }

    const commands = maybeArray(bundle.workspace?.commands).map(normalizeCommandItem).filter((c): c is NormalizedCommandItem => c !== null);
    for (const command of commands) {
      items.push({
        name: command.name,
        kind: "Command",
        meta: command.agent ? `Agent · ${command.agent}` : "Command",
        tone: "command",
      });
    }

    const opencodeConfigKeys = Object.keys(maybeObject(opencode) ?? {}).filter((key) => !["agent", "mcp"].includes(key));
    if (opencodeConfigKeys.length) {
      items.push({
        name: "opencode.json",
        kind: "Config",
        meta: "OpenCode config",
        tone: "config",
      });
    }

    if (maybeObject(bundle.workspace?.openwork)) {
      items.push({
        name: "openwork.json",
        kind: "Config",
        meta: "OpenWork config",
        tone: "config",
      });
    }

    for (const [name] of Object.entries(maybeObject(bundle.workspace?.config) ?? {})) {
      items.push({
        name,
        kind: "Config",
        meta: "Config file",
        tone: "config",
      });
    }

    for (const file of workspacePortableFiles(bundle)) {
      const preview = templateFilePreviewMeta(file.path);
      items.push({
        name: basename(file.path),
        kind: preview.kind,
        meta: file.path,
        tone: preview.tone,
      });
    }
  }

  return items.slice(0, limit);
}

function slugifyPreviewFilename(value: string, fallback: string, extension: string): string {
  const stem = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${stem || fallback}.${extension}`;
}

function buildTextPreview(content: string, fallback: string): string {
  const normalized = String(content ?? "").trim();
  return normalized || fallback;
}

function buildJsonPreview(value: unknown, fallback: string): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized || fallback;
  } catch {
    return fallback;
  }
}

function buildBundlePreviewSelection(input: {
  filename: string;
  text: string;
  tone: PreviewItem["tone"];
  label: string;
}): {
  filename: string;
  text: string;
  tone: PreviewItem["tone"];
  label: string;
} {
  return input;
}

export function buildBundlePreview(bundle: NormalizedBundle): {
  filename: string;
  text: string;
  tone: PreviewItem["tone"];
  label: string;
} {
  if (bundle.type === "skill") {
    return buildBundlePreviewSelection({
      filename: slugifyPreviewFilename(bundle.name || "skill", "skill", "md"),
      text: buildTextPreview(bundle.content, `# ${bundle.name || "OpenWork skill"}`),
      tone: "skill",
      label: bundle.trigger ? `Trigger: ${bundle.trigger}` : "Skill preview",
    });
  }

  if (bundle.type === "skills-set" && bundle.skills.length) {
    const firstSkill = bundle.skills[0]!;
    return buildBundlePreviewSelection({
      filename: slugifyPreviewFilename(firstSkill.name || "skill", "skill", "md"),
      text: buildTextPreview(firstSkill.content, `# ${firstSkill.name || "Shared skill"}`),
      tone: "skill",
      label: bundle.skills.length > 1 ? `First of ${bundle.skills.length} skills` : "Skill preview",
    });
  }

  const workspaceSkills = maybeArray(bundle.workspace?.skills).map(normalizeSkillItem).filter((skill): skill is NormalizedSkillItem => skill !== null);
  if (workspaceSkills.length) {
    const firstSkill = workspaceSkills[0]!;
    return buildBundlePreviewSelection({
      filename: slugifyPreviewFilename(firstSkill.name || "skill", "skill", "md"),
      text: buildTextPreview(firstSkill.content, `# ${firstSkill.name || "Workspace skill"}`),
      tone: "skill",
      label: workspaceSkills.length > 1 ? `Lead skill of ${workspaceSkills.length}` : "Skill preview",
    });
  }

  const commands = maybeArray(bundle.workspace?.commands).map(normalizeCommandItem).filter((command): command is NormalizedCommandItem => command !== null);
  if (commands.length) {
    const firstCommand = commands[0]!;
    return buildBundlePreviewSelection({
      filename: slugifyPreviewFilename(firstCommand.name || "command", "command", "md"),
      text: buildTextPreview(firstCommand.template || firstCommand.content, `# ${firstCommand.name || "OpenWork command"}`),
      tone: "command",
      label: firstCommand.agent ? `Command for ${firstCommand.agent}` : "Command preview",
    });
  }

  const opencode = maybeObject(bundle.workspace?.opencode);
  const agentEntries = Object.entries(maybeObject(opencode?.agent) ?? {});
  if (agentEntries.length) {
    const [name, config] = agentEntries[0]!;
    return buildBundlePreviewSelection({
      filename: slugifyPreviewFilename(name, "agent", "json"),
      text: buildJsonPreview({ agent: { [name]: config } }, '{\n  "agent": {}\n}'),
      tone: "agent",
      label: "Agent config",
    });
  }

  const mcpEntries = Object.entries(maybeObject(opencode?.mcp) ?? {});
  if (mcpEntries.length) {
    const [name, config] = mcpEntries[0]!;
    return buildBundlePreviewSelection({
      filename: slugifyPreviewFilename(name, "mcp", "json"),
      text: buildJsonPreview({ mcp: { [name]: config } }, '{\n  "mcp": {}\n}'),
      tone: "mcp",
      label: "MCP config",
    });
  }

  if (maybeObject(bundle.workspace?.openwork)) {
    return buildBundlePreviewSelection({
      filename: "openwork.json",
      text: buildJsonPreview(bundle.workspace?.openwork, '{\n  "openwork": {}\n}'),
      tone: "config",
      label: "OpenWork config",
    });
  }

  if (opencode) {
    return buildBundlePreviewSelection({
      filename: "opencode.json",
      text: buildJsonPreview(opencode, '{\n  "opencode": {}\n}'),
      tone: "config",
      label: "OpenCode config",
    });
  }

  const configEntries = Object.entries(maybeObject(bundle.workspace?.config) ?? {});
  if (configEntries.length) {
    const [name, value] = configEntries[0]!;
    const extension = name.includes(".") ? name.split(".").pop() || "json" : "json";
    return buildBundlePreviewSelection({
      filename: name,
      text: buildJsonPreview(value, `{\n  "${name}": {}\n}`),
      tone: "config",
      label: `Config preview · ${extension}`,
    });
  }

  const files = workspacePortableFiles(bundle);
  if (files.length) {
    const firstFile = files[0]!;
    const preview = templateFilePreviewMeta(firstFile.path);
    return buildBundlePreviewSelection({
      filename: basename(firstFile.path),
      text: buildTextPreview(firstFile.content, `# ${basename(firstFile.path) || "OpenWork portable file"}`),
      tone: preview.tone,
      label: `${preview.label} · ${firstFile.path}`,
    });
  }

  return buildBundlePreviewSelection({
    filename: "bundle.json",
    text: buildJsonPreview(bundle, '{\n  "bundle": true\n}'),
    tone: "config",
    label: "Bundle JSON",
  });
}

export function buildBundlePreviewSelections(bundle: NormalizedBundle): {
  id: string;
  name: string;
  filename: string;
  text: string;
  tone: PreviewItem["tone"];
  label: string;
}[] {
  if (bundle.type === "skill") {
    return [
      {
        id: "skill-0",
        name: bundle.name || "Untitled skill",
        filename: slugifyPreviewFilename(bundle.name || "skill", "skill", "md"),
        text: buildTextPreview(bundle.content, `# ${bundle.name || "OpenWork skill"}`),
        tone: "skill",
        label: bundle.trigger ? `Trigger · ${bundle.trigger}` : "Skill",
      },
    ];
  }

  if (bundle.type === "skills-set" && bundle.skills.length) {
    return bundle.skills.map((skill, index) => ({
      id: `skill-${index}`,
      name: skill.name || `Skill ${index + 1}`,
      filename: slugifyPreviewFilename(skill.name || `skill-${index + 1}`, "skill", "md"),
      text: buildTextPreview(skill.content, `# ${skill.name || `Skill ${index + 1}`}`),
      tone: "skill",
      label: skill.trigger ? `Trigger · ${skill.trigger}` : "Skill",
    }));
  }

  const workspaceSkills = maybeArray(bundle.workspace?.skills).map(normalizeSkillItem).filter((skill): skill is NormalizedSkillItem => skill !== null);
  const selections: {
    id: string;
    name: string;
    filename: string;
    text: string;
    tone: PreviewItem["tone"];
    label: string;
  }[] = [];

  if (workspaceSkills.length) {
    selections.push(...workspaceSkills.map((skill, index) => ({
      id: `workspace-skill-${index}`,
      name: skill.name || `Skill ${index + 1}`,
      filename: slugifyPreviewFilename(skill.name || `skill-${index + 1}`, "skill", "md"),
      text: buildTextPreview(skill.content, `# ${skill.name || `Skill ${index + 1}`}`),
      tone: "skill" as const,
      label: skill.trigger ? `Trigger · ${skill.trigger}` : "Skill",
    })));
  }

  const commands = maybeArray(bundle.workspace?.commands).map(normalizeCommandItem).filter((command): command is NormalizedCommandItem => command !== null);
  if (commands.length) {
    selections.push(...commands.map((command, index) => ({
      id: `workspace-command-${index}`,
      name: command.name || `Command ${index + 1}`,
      filename: slugifyPreviewFilename(command.name || `command-${index + 1}`, "command", "md"),
      text: buildTextPreview(command.template || command.content, `# ${command.name || `Command ${index + 1}`}`),
      tone: "command" as const,
      label: command.agent ? `Agent · ${command.agent}` : "Command",
    })));
  }

  const opencode = maybeObject(bundle.workspace?.opencode);
  const agentEntries = Object.entries(maybeObject(opencode?.agent) ?? {});
  if (agentEntries.length) {
    selections.push(...agentEntries.map(([name, config], index) => {
      const entry = maybeObject(config) ?? {};
      const version = maybeString(entry.version).trim();
      const model = maybeString(entry.model).trim();

      return {
        id: `workspace-agent-${index}`,
        name,
        filename: slugifyPreviewFilename(name, "agent", "json"),
        text: buildJsonPreview({ agent: { [name]: config } }, '{\n  "agent": {}\n}'),
        tone: "agent" as const,
        label: version ? `v${version}` : model ? model : "Agent config",
      };
    }));
  }

  const mcpEntries = Object.entries(maybeObject(opencode?.mcp) ?? {});
  if (mcpEntries.length) {
    selections.push(...mcpEntries.map(([name, config], index) => {
      const entry = maybeObject(config) ?? {};
      const type = maybeString(entry.type).trim();
      const url = maybeString(entry.url).trim();

      return {
        id: `workspace-mcp-${index}`,
        name,
        filename: slugifyPreviewFilename(name, "mcp", "json"),
        text: buildJsonPreview({ mcp: { [name]: config } }, '{\n  "mcp": {}\n}'),
        tone: "mcp" as const,
        label: type ? `${humanizeType(type)} MCP` : url ? "Remote MCP" : "MCP config",
      };
    }));
  }

  const opencodeConfigKeys = Object.keys(opencode ?? {}).filter((key) => !["agent", "mcp"].includes(key));
  if (opencodeConfigKeys.length) {
    selections.push({
      id: "workspace-opencode-config",
      name: "OpenCode config",
      filename: "opencode.json",
      text: buildJsonPreview(opencode, '{\n  "opencode": {}\n}'),
      tone: "config" as const,
      label: "OpenCode settings",
    });
  }

  if (maybeObject(bundle.workspace?.openwork)) {
    selections.push({
      id: "workspace-openwork-config",
      name: "OpenWork config",
      filename: "openwork.json",
      text: buildJsonPreview(bundle.workspace?.openwork, '{\n  "openwork": {}\n}'),
      tone: "config" as const,
      label: "Workspace settings",
    });
  }

  const configEntries = Object.entries(maybeObject(bundle.workspace?.config) ?? {});
  if (configEntries.length) {
    selections.push(...configEntries.map(([name, value], index) => {
      const extension = name.includes(".") ? name.split(".").pop() || "json" : "json";

      return {
        id: `workspace-config-${index}`,
        name,
        filename: name,
        text: buildJsonPreview(value, `{
  "${name}": {}
}`),
        tone: "config" as const,
        label: `Config file · ${extension}`,
      };
    }));
  }

  const files = workspacePortableFiles(bundle);
  if (files.length) {
    selections.push(...files.map((file, index) => {
      const preview = templateFilePreviewMeta(file.path);
      return {
        id: `workspace-file-${index}`,
        name: basename(file.path),
        filename: basename(file.path),
        text: buildTextPreview(file.content, `# ${basename(file.path) || `File ${index + 1}`}`),
        tone: preview.tone,
        label: `${preview.label} · ${file.path}`,
      };
    }));
  }

  if (selections.length) return selections;

  const preview = buildBundlePreview(bundle);
  return [
    {
      id: "preview-0",
      name: bundle.name || "OpenWork bundle",
      filename: preview.filename,
      text: preview.text,
      tone: preview.tone,
      label: preview.label,
    },
  ];
}

export function prettyJson(rawJson: string): string {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2);
  } catch {
    return rawJson;
  }
}

export function buildBundleNarrative(bundle: NormalizedBundle): string {
  const counts = getBundleCounts(bundle);
  if (bundle.type === "skill") {
    return "One reusable skill, wrapped in a share link that can be added to an existing worker or imported into a new one.";
  }
  if (bundle.type === "skills-set") {
    return `${counts.skillCount} skills packaged together so they can land in an existing worker or start a new worker with the full set in one import.`;
  }

  const parts: string[] = [];
  if (counts.skillCount) parts.push(`${counts.skillCount} skill${counts.skillCount === 1 ? "" : "s"}`);
  if (counts.agentCount) parts.push(`${counts.agentCount} agent${counts.agentCount === 1 ? "" : "s"}`);
  if (counts.mcpCount) parts.push(`${counts.mcpCount} MCP${counts.mcpCount === 1 ? "" : "s"}`);
  if (counts.commandCount) parts.push(`${counts.commandCount} command${counts.commandCount === 1 ? "" : "s"}`);
  if (counts.configCount) parts.push(`${counts.configCount} config${counts.configCount === 1 ? "" : "s"}`);
  if (counts.fileCount) parts.push(`${counts.fileCount} portable file${counts.fileCount === 1 ? "" : "s"}`);
  return parts.length
    ? `${parts.join(", ")} bundled into a worker package that imports through OpenWork with one step.`
    : "Worker configuration bundle prepared for OpenWork import.";
}

export function buildStatusMarkup({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - OpenWork Share</title>
  <style>
    @font-face {
      font-family: "FK Raster Roman Compact Smooth";
      src: url("https://openworklabs.com/fonts/FKRasterRomanCompact-Smooth.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    :root {
      color-scheme: light;
      --ow-bg: #f6f9fc;
      --ow-ink: #011627;
      --ow-card: rgba(255, 255, 255, 0.8);
      --ow-border: rgba(255, 255, 255, 0.8);
      --ow-shadow: 0 20px 60px -15px rgba(0, 0, 0, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: Inter, "Segoe UI", sans-serif;
      color: var(--ow-ink);
      background:
        radial-gradient(circle at top left, rgba(251, 191, 36, 0.34), transparent 36%),
        radial-gradient(circle at right, rgba(96, 165, 250, 0.28), transparent 30%),
        radial-gradient(circle at bottom right, rgba(244, 114, 182, 0.14), transparent 28%),
        linear-gradient(180deg, #fbfdff 0%, var(--ow-bg) 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        radial-gradient(rgba(1, 22, 39, 0.055) 0.75px, transparent 0.75px),
        radial-gradient(rgba(1, 22, 39, 0.03) 0.6px, transparent 0.6px);
      background-position: 0 0, 18px 18px;
      background-size: 36px 36px;
      opacity: 0.34;
      mix-blend-mode: multiply;
    }
    .card {
      position: relative;
      z-index: 1;
      width: min(100%, 540px);
      border-radius: 2rem;
      padding: 32px;
      border: 1px solid var(--ow-border);
      background: var(--ow-card);
      box-shadow: var(--ow-shadow);
      backdrop-filter: blur(16px);
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2rem, 5vw, 2.8rem);
      line-height: 0.96;
      letter-spacing: -0.06em;
    }
    p {
      margin: 0;
      color: #5f6b7a;
      line-height: 1.6;
    }
    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 24px;
      min-height: 48px;
      padding: 0 20px;
      border-radius: 999px;
      text-decoration: none;
      color: white;
      background: #011627;
      transition: transform 300ms ${SHARE_EASE}, background-color 300ms ${SHARE_EASE}, box-shadow 300ms ${SHARE_EASE};
      box-shadow: 0 14px 32px -16px rgba(1, 22, 39, 0.55);
      font-weight: 500;
    }
    a:hover {
      background: rgb(110, 110, 110);
      transform: translateY(-1px);
      box-shadow:
        rgba(0, 0, 0, 0.06) 0px 0px 0px 1px,
        rgba(0, 0, 0, 0.04) 0px 1px 2px 0px,
        rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
    ${actionHref && actionLabel ? `<a href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>` : ""}
  </main>
</body>
</html>`;
}
