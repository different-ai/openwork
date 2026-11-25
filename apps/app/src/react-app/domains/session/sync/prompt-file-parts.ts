import type { FilePartInput } from "@opencode-ai/sdk/v2/client";

const FIRST_LINE_LOCAL_PATH_RE = /(?:file:\/\/[^\s"'`<>]+|~\/[^\s"'`<>]+|[A-Za-z]:[\\/][^\s"'`<>]+|(?<![:/])\/[A-Za-z0-9._~+%/-]*[\/.][A-Za-z0-9._~+%/-]*)/g;
const TRAILING_PUNCTUATION_RE = /[),.;:]+$/;
const PATH_START_RE = /^(?:file:\/\/|~\/|\/|[A-Za-z]:[\\/])/;

function stripTrailingPunctuation(value: string) {
  return value.replace(TRAILING_PUNCTUATION_RE, "");
}

function hasPathBoundary(line: string, start: number) {
  if (start <= 0) return true;
  return /[\s("'[]/.test(line[start - 1] ?? "");
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFileUri(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") return "";
    const pathname = safeDecodeURIComponent(parsed.pathname);
    if (!pathname) return "";
    if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") {
      return `//${parsed.hostname}${pathname}`;
    }
    return pathname;
  } catch {
    return "";
  }
}

function homeFromWorkspaceRoot(workspaceRoot: string) {
  const normalized = workspaceRoot.trim().replace(/\\/g, "/");
  const macMatch = normalized.match(/^(\/Users\/[^/]+)(?:\/|$)/);
  if (macMatch) return macMatch[1] ?? "";
  const linuxMatch = normalized.match(/^(\/home\/[^/]+)(?:\/|$)/);
  if (linuxMatch) return linuxMatch[1] ?? "";
  return "";
}

function toAbsolutePath(value: string, workspaceRoot: string) {
  if (/^file:\/\//i.test(value)) return normalizeFileUri(value);
  if (value.startsWith("~/")) {
    const home = homeFromWorkspaceRoot(workspaceRoot);
    return home ? `${home}/${value.slice(2)}` : "";
  }
  if (value.startsWith("/")) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replace(/\\/g, "/");
  return "";
}

function filenameFromPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "file";
}

function encodeFilePath(path: string) {
  return path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

export function toFileUrl(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeFilePath(normalized).replace(/^([A-Za-z])%3A/, "$1:")}`;
  return `file://${encodeFilePath(normalized)}`;
}

export function joinWorkspaceRelativePath(workspaceRoot: string, relativePath: string) {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !relative) return "";
  return `${root}/${relative}`;
}

const READ_BINARY_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "mkv", "avi", "webm", "wmv", "flv", "mpg", "mpeg",
  "mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "oga", "opus", "wma",
  "heic", "heif", "tif", "tiff", "bmp", "ico", "psd", "ai", "raw", "sketch",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "key", "numbers", "pages",
  "exe", "dll", "so", "dylib", "bin", "dat", "obj", "o", "a", "lib", "wasm", "class", "jar", "war", "pyc", "pyo",
  "sqlite", "sqlite3", "db",
  "ttf", "otf", "woff", "woff2",
]);

export function isReadInlineablePath(path: string) {
  const basename = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return true;
  return !READ_BINARY_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

function hasFileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && /^[A-Za-z0-9]{1,10}$/.test(name.slice(dot + 1));
}

function looksCutAtWhitespace(line: string, end: number, raw: string) {
  const next = line[end];
  if (next === "\\") return true;
  if (next !== " " && next !== "\t") return false;
  const token = stripTrailingPunctuation(line.slice(end).trimStart().split(/\s/, 1)[0] ?? "");
  if (!token || PATH_START_RE.test(token)) return false;
  if (!hasFileExtension(filenameFromPath(raw))) return true;
  return /[\\/]/.test(token) || hasFileExtension(token);
}

export function firstLineLocalFileParts(text: string, workspaceRoot: string): FilePartInput[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const parts: FilePartInput[] = [];
  const seen = new Set<string>();

  for (const match of firstLine.matchAll(FIRST_LINE_LOCAL_PATH_RE)) {
    const start = match.index ?? 0;
    if (!hasPathBoundary(firstLine, start)) continue;
    const raw = stripTrailingPunctuation(match[0]);
    if (raw === match[0] && looksCutAtWhitespace(firstLine, start + match[0].length, raw)) continue;
    const absolute = toAbsolutePath(raw, workspaceRoot);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    if (!isReadInlineablePath(absolute)) continue;
    parts.push({
      type: "file",
      mime: "text/plain",
      url: toFileUrl(absolute),
      filename: filenameFromPath(raw),
    });
  }

  return parts;
}
