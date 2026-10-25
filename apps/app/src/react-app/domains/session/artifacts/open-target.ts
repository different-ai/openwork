import type { UIMessage } from "ai";
import { codeModeToolCalls } from "@/lib/code-mode-tools";

type OpenTargetKind = "url" | "file";
export type OpenTargetPreview = "browser" | "markdown" | "code" | "sheet" | "slides" | "document" | "image" | "pdf" | "html" | "text" | "external";

export interface TextData {
  kind: "text";
  data: string;
}

export interface BinaryData {
  kind: "binary";
  data: ArrayBuffer;
}

export type Data = TextData | BinaryData;

export type OpenTarget = {
  id: string;
  kind: OpenTargetKind;
  value: string;
  name: string;
  preview: OpenTargetPreview;
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
  /** The assistant message whose observed tool result produced this file. */
  sourceMessageId?: string;
};

/** Explicit links preserve the full address, unlike URLs extracted from prose. */
export function openTargetFromUrl(href: string): OpenTarget | null {
  const value = href.trim();
  try {
    if (!["http:", "https:"].includes(new URL(value).protocol)) return null;
  } catch {
    return null;
  }
  return {
    id: `url:${value}`, kind: "url", value, name: value,
    preview: "browser", confidence: 100, reason: "explicit link",
  };
}

export function sameOpenTargets(left: OpenTarget[], right: OpenTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index];
    return other !== undefined
      && target.id === other.id
      && target.kind === other.kind
      && target.value === other.value
      && target.name === other.name
      && target.preview === other.preview
      && target.confidence === other.confidence
      && target.reason === other.reason
      && target.exists === other.exists
      && target.size === other.size
      && target.updatedAt === other.updatedAt
      && target.sourceMessageId === other.sourceMessageId;
  });
}

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;

const FILE_PATTERN = /(?:^|[\s"'`([{])((?:\.{1,2}[/\\]|~[/\\]|[/\\])?[\w.\-]+(?:[/\\][\w.\-]+)+\.[a-z][a-z0-9]{0,9}|[\w.\-]+\.[a-z][a-z0-9]{0,9})/gi;
const URL_PATTERN = /https?:\/\/[^\s)\]}>"'`]+/gi;
const SOCKET_PATTERN = /(?:ws|wss):\/\/[^\s)\]}>"'`]+/gi;
const SIDEBAR_ARTIFACT_FILE_PREVIEWS = new Set<OpenTargetPreview>(["markdown", "code", "sheet", "slides", "document", "image", "pdf", "html"]);
const CODE_EXTENSIONS = new Set([
  ".astro", ".bash", ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".graphql",
  ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".cjs", ".php", ".prisma",
  ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue", ".zig",
  ".json", ".jsonc", ".toml", ".xml", ".yaml", ".yml",
]);
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const DISCOVERY_TOOL_NAMES = new Set(["glob", "grep", "search", "find"]);
const ARTIFACT_METADATA_TOOL_NAMES = new Set(["openwork_extension_call"]);
const PRODUCED_FILE_TOOL_NAMES = new Set(["spreadsheet_write", "openwork_extension_call", "openwork_execute"]);
const WRITE_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "edit_file",
  "multi_edit",
  "multiedit",
  "patch",
  "str_replace_editor",
  "write",
  "write_file",
]);
const FILE_METADATA_KEYS = ["path", "file", "filePath", "filepath"];
const PATCH_FILE_PATTERN = /^\*\*\* (?:Add File|Update File):\s*(.+)$/gmi;
const PATCH_MOVE_TO_PATTERN = /^\*\*\* Move to:\s*(.+)$/gmi;
const URI_PATTERN = /^(?:https?|wss?|file):\/\//i;

type DeriveOpenTargetsOptions = {
  includeFileMentions?: boolean;
};

function normalizePath(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "");
}

function basename(value: string) {
  const clean = value.split(/[?#]/)[0] ?? value;
  return clean.split("/").filter(Boolean).pop() ?? value;
}

function extname(value: string) {
  const name = basename(value).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

export function classifyOpenTarget(value: string, kind: OpenTargetKind): OpenTargetPreview {
  if (kind === "url") return "browser";
  const ext = extname(value);
  if ([".md", ".markdown", ".mdx", ".mmd"].includes(ext)) return "markdown";
  if ([".csv", ".tsv", ".xlsx"].includes(ext)) return "sheet";
  if ([".ppt", ".pptx", ".pptm", ".pot", ".potx", ".odp", ".key", ".sxi"].includes(ext)) return "slides";
  if (ext === ".docx") return "document";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".html", ".htm"].includes(ext)) return "html";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if ([".txt", ".log"].includes(ext)) return "text";
  return "external";
}

export function openTargetFromWorkspaceFile(
  path: string,
  metadata: { size?: number; updatedAt?: number } = {},
): OpenTarget | null {
  const target = targetFromFile(path, 100, "workspace tree");
  return target ? { ...target, exists: true, ...metadata } : null;
}

function textWithoutRedundantMarkdownLinkLabels(text: string) {
  return text.replace(MARKDOWN_LINK_PATTERN, (match, label: string, href: string) => {
    const cleanLabel = label.trim();
    const cleanHref = href.trim();
    return cleanLabel === basename(filePathFromLinkHref(cleanHref)) ? `[](${cleanHref})` : match;
  });
}

/**
 * Markdown link destinations are URLs, so a reply that links `Acme%20Quote.pdf`
 * or `file:///…/Acme%20Quote.pdf` names the file `Acme Quote.pdf`. Decode the
 * destination once so it matches the file on disk. A `file://` URL with a host
 * stays as written (network shares are never opened), and a name that is not
 * valid percent-encoding stays literal.
 */
export function filePathFromLinkHref(href: string): string {
  const value = href.trim();
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) return value;
    } catch {
      return value;
    }
    return filePathFromFileUrl(value) ?? value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Chat attachments are uploaded into the workspace inbox and referenced by
 * `file://` URLs on message file parts. Decoding the URL here lets those
 * attachments resolve as openable artifacts (regex path scanning cannot,
 * because attachment filenames often contain spaces).
 */
export function filePathFromFileUrl(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    if (!pathname) return null;
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

function targetFromFile(path: string, confidence: number, reason: string): OpenTarget | null {
  const normalized = normalizePath(path).replace(/[.,;:]+$/, "");
  if (!normalized || normalized.length > 500 || !normalized.includes(".")) return null;
  return {
    id: `file:${normalized.toLowerCase()}`,
    kind: "file",
    value: normalized,
    name: basename(normalized),
    preview: classifyOpenTarget(normalized, "file"),
    confidence,
    reason,
  };
}

function targetFromUrl(url: string, confidence: number, reason: string): OpenTarget | null {
  const stripped = url.trim().replace(/[.,;:`\\]+$/, "");
  let clean = stripped;
  try {
    const parsed = new URL(stripped);
    if (/^\/+$/i.test(parsed.pathname) && !parsed.search && !parsed.hash) {
      clean = parsed.origin;
    }
  } catch {
    // Keep the stripped value; regex extraction already validated the shape.
  }
  if (!clean) return null;
  return {
    id: `url:${clean}`,
    kind: "url",
    value: clean,
    name: basename(clean) || clean,
    preview: "browser",
    confidence,
    reason,
  };
}

function addTarget(map: Map<string, OpenTarget>, target: OpenTarget | null) {
  if (!target) return;
  const existing = map.get(target.id);
  if (!existing || target.confidence >= existing.confidence) map.set(target.id, target);
}

function isArtifactTarget(target: OpenTarget) {
  return target.kind === "url" || target.kind === "file";
}

export function isCollectibleArtifactTarget(target: OpenTarget) {
  return target.kind === "file" && target.exists === true && SIDEBAR_ARTIFACT_FILE_PREVIEWS.has(target.preview);
}

export function isOpenableFileTarget(target: OpenTarget) {
  return target.kind === "file" && target.exists === true;
}

export function isLocalhostBrowserTarget(target: OpenTarget) {
  return target.kind === "url" && /(?:https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(target.value);
}

function scanText(
  map: Map<string, OpenTarget>,
  text: string,
  confidence: number,
  reason: string,
  options: { includeFiles: boolean },
) {
  if (!text) {
    return;
  }

  let scanValue = text;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const href = match[2];
    if (!href) continue;
    if (/^(?:https?|wss?):\/\//i.test(href)) {
      addTarget(map, targetFromUrl(href, confidence, reason));
    } else if (options.includeFiles) {
      addTarget(map, targetFromFile(filePathFromLinkHref(href), confidence, reason));
    }
  }

  if (options.includeFiles) {
    scanValue = textWithoutRedundantMarkdownLinkLabels(text);
  }

  URL_PATTERN.lastIndex = 0;

  for (const match of scanValue.matchAll(URL_PATTERN)) {
    if (match[0]) addTarget(map, targetFromUrl(match[0], confidence, reason));
  }

  SOCKET_PATTERN.lastIndex = 0;

  for (const match of scanValue.matchAll(SOCKET_PATTERN)) {
    if (match[0]) addTarget(map, targetFromUrl(match[0], confidence, reason));
  }

  if (!options.includeFiles) return;

  FILE_PATTERN.lastIndex = 0;
  for (const match of scanValue.matchAll(FILE_PATTERN)) {
    if (match[1]) addTarget(map, targetFromFile(match[1], confidence, reason));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizedToolName(toolName: string) {
  return toolName.trim().toLowerCase().replace(/^functions[._-]/, "");
}

function isDiscoveryTool(toolName: string) {
  return DISCOVERY_TOOL_NAMES.has(normalizedToolName(toolName));
}

function isWriteTool(toolName: string) {
  return WRITE_TOOL_NAMES.has(normalizedToolName(toolName));
}

function isArtifactMetadataTool(toolName: string) {
  return ARTIFACT_METADATA_TOOL_NAMES.has(normalizedToolName(toolName));
}

function collectFileMetadataValues(value: unknown) {
  if (!isObject(value)) return [];
  const values: string[] = [];
  for (const key of FILE_METADATA_KEYS) {
    const file = value[key];
    if (typeof file === "string") values.push(file);
  }
  const files = value.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file === "string") values.push(file);
    }
  }
  return values;
}

function resultObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    if (value.length > 1_048_576) return null;
    try { return resultObject(JSON.parse(value)); } catch { return null; }
  }
  return isObject(value) && !Array.isArray(value) ? value : null;
}

function collectNestedFileMetadataValues(value: unknown) {
  const result = resultObject(value);
  if (!result || result.ok !== true) return [];
  return [result, result.result].flatMap(collectFileMetadataValues);
}

/** Only shipping server file writers define this signal, after a successful write.
 * It is a candidate, never an existence claim: resolveArtifacts still verifies it.
 * Never treat arbitrary output paths, shell text, or script source as write evidence. */
function collectProducedFileValues(toolName: string, output: unknown, input: unknown) {
  const tool = normalizedToolName(toolName);
  if (!PRODUCED_FILE_TOOL_NAMES.has(tool)) return [];
  let result = resultObject(output);
  if (!result || result.ok !== true) return [];
  if (tool === "openwork_execute") {
    // The registered image action is an affordance result around the extension
    // response. Validate both envelopes against the actual submitted action;
    // never interpret an arbitrary OpenWork command's nested paths as outputs.
    const request = resultObject(input);
    const args = request && resultObject(request.args);
    const extension = resultObject(result.result);
    if (request?.id !== "extension.call" || result.id !== "extension.call"
      || args?.extensionId !== "openai-image-generation" || args.action !== "image_generate"
      || extension?.ok !== true || extension.extensionId !== args.extensionId || extension.action !== args.action) return [];
    result = extension;
  }
  const files = [result, result.result].flatMap(value => {
    if (!isObject(value) || !Array.isArray(value.producedFiles)) return [];
    return value.producedFiles.slice(0, 100).flatMap(file => isObject(file)
      && typeof file.path === "string" && typeof file.bytes === "number" && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      ? [file.path] : []);
  });
  // Older workers already return this atomic-write receipt, without the new
  // explicit list. Accept only that writer's complete receipt, not a bare path.
  if (tool === "spreadsheet_write" && typeof result.path === "string"
    && typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256)
    && typeof result.bytes === "number" && Number.isSafeInteger(result.bytes) && result.bytes >= 0) files.push(result.path);
  return files;
}

function collectPatchFileValues(value: unknown) {
  if (!isObject(value)) return [];
  const patchText = value.patchText ?? value.patch ?? value.diff;
  if (typeof patchText !== "string") return [];
  const values: string[] = [];
  PATCH_FILE_PATTERN.lastIndex = 0;
  for (const match of patchText.matchAll(PATCH_FILE_PATTERN)) {
    if (match[1]) values.push(match[1]);
  }
  PATCH_MOVE_TO_PATTERN.lastIndex = 0;
  for (const match of patchText.matchAll(PATCH_MOVE_TO_PATTERN)) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

function addFileValues(map: Map<string, OpenTarget>, values: string[], confidence: number, reason: string) {
  for (const value of values) {
    addTarget(map, targetFromFile(value, confidence, reason));
  }
}

// Session sync replaces changed parts; unchanged tools survive text-only deltas.
const partOpenTargets = new WeakMap<UIMessage["parts"][number], Map<string, OpenTarget[]>>();

function extractPartOpenTargets(part: UIMessage["parts"][number], confidence: number, includeFileMentions: boolean) {
  // Only text extraction depends on message role or file-mention options.
  const key = part.type === "text" ? `${confidence}:${includeFileMentions}` : "default";
  let variants = partOpenTargets.get(part);
  const cached = variants?.get(key);
  if (cached) return cached;

  const targets = new Map<string, OpenTarget>();
  if (part.type === "text" && typeof part.text === "string") {
    scanText(targets, part.text, confidence, "message", {
      // Literal assistant references are language-independent candidates, not
      // production evidence. The server must still verify every file on disk;
      // observed changes/receipts outrank prose and retain their producing turn.
      includeFiles: includeFileMentions || confidence === 65,
    });
  } else if (part.type === "file") {
    const path = filePathFromFileUrl(part.url);
    if (path) {
      const target = targetFromFile(path, 95, "chat attachment");
      addTarget(targets, target && part.filename ? { ...target, name: part.filename } : target);
    }
  } else if (part.type === "source-document") {
    addTarget(
      targets,
      part.filename
        ? targetFromFile(part.filename, 95, "attachment source")
        : URI_PATTERN.test(part.title)
          ? targetFromUrl(part.title, 95, "attachment source")
          : targetFromFile(part.title, 95, "attachment source"),
    );
  } else if (part.type === "data-openwork-file-change" && isObject(part.data) && Array.isArray(part.data.files)) {
    addFileValues(targets, part.data.files.filter((file): file is string => typeof file === "string"), 100, "workspace change");
  } else if (part.type === "dynamic-tool") {
    const discoveryTool = isDiscoveryTool(part.toolName);
    const writeTool = isWriteTool(part.toolName);
    const artifactMetadataTool = isArtifactMetadataTool(part.toolName);

    const completed = part.state === "output-available";
    if (completed) {
      addFileValues(targets, collectProducedFileValues(part.toolName, part.output, part.input), 100, "server-produced file");
    }
    // Code Mode's server-captured calls retain their own success/error and result.
    // Reuse the same extraction for each delivery route, including partial success
    // when the surrounding script later fails. No source-code path inference.
    for (const call of codeModeToolCalls(part) ?? []) {
      for (const target of extractPartOpenTargets(call, confidence, includeFileMentions)) addTarget(targets, target);
    }

    if (writeTool && completed) {
      addFileValues(
        targets,
        [part.input, part.output].flatMap(collectFileMetadataValues),
        95,
        "write tool metadata",
      );
      addFileValues(targets, collectPatchFileValues(part.input), 95, "patch metadata");
      if (typeof part.output === "string") {
        scanText(targets, part.output, 90, "write tool output", { includeFiles: true });
      }
    }

    if (artifactMetadataTool && completed) {
      addFileValues(
        targets,
        collectNestedFileMetadataValues(part.output),
        95,
        "artifact tool metadata",
      );
    }

    if (!discoveryTool) {
      scanText(targets, JSON.stringify(part.output ?? part.input ?? ""), 75, "tool output", { includeFiles: false });
    }
  }

  const extracted = Array.from(targets.values());
  if (!variants) {
    variants = new Map();
    partOpenTargets.set(part, variants);
  }
  variants.set(key, extracted);
  return extracted;
}

export function deriveOpenTargets(messages: UIMessage[], options: DeriveOpenTargetsOptions = {}): OpenTarget[] {
  const targets = new Map<string, OpenTarget>();
  const includeFileMentions = options.includeFileMentions === true;

  for (const message of messages) {
    const confidence = message.role === "assistant" ? 65 : 40;
    for (const part of message.parts) {
      for (const target of extractPartOpenTargets(part, confidence, includeFileMentions)) {
        const observedFile = target.reason === "server-produced file" || target.reason === "workspace change";
        if (observedFile && message.role !== "assistant") continue;
        addTarget(targets, observedFile ? { ...target, sourceMessageId: message.id } : target);
      }
    }
  }

  return Array.from(targets.values())
    .filter(isArtifactTarget)
    .sort((left, right) => right.confidence - left.confidence)
    // Callers may attach verification metadata or otherwise mutate their targets.
    .map((target) => ({ ...target }));
}
