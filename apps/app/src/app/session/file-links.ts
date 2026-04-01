type LinkType = "url" | "file";

export type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string; type: LinkType };

export type LinkDetectionOptions = {
  allowFilePaths?: boolean;
};

const WEB_LINK_RE = /^(?:https?:\/\/|www\.)/i;
const FILE_URI_RE = /^file:\/\//i;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/][^\s"'`\)\]\}>]+$/;
const POSIX_PATH_RE = /^\/(?!\/)[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;
const TILDE_PATH_RE = /^~\/[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;
const BARE_FILENAME_RE = /^(?!\.)(?!.*\.\.)(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)$/;
const SAFE_PATH_CHAR_RE = /[^\s"'`\)\]\}>]/;
const LEADING_PUNCTU = /["'`\(\[\{<]/;
const TRAILING_PUNCTU = /["'`\)\]}>.,:;!?]/;

export const stripFileReferenceSuffix = (value: string) => {
  const withoutQueryOrFragment = value.replace(/[?#].*$/, "").trim();
  if (!withoutQueryOrFragment) return "";
  return withoutQueryOrFragment.replace(/:(\d+)(?::\d+)?$/, "");
};

export const isWorkspaceRelativeFilePath = (value: string) => {
  const stripped = stripFileReferenceSuffix(value);
  if (!stripped) return false;

  const normalized = stripped.replace(/\\/g, "/");
  if (!normalized.includes("/")) return false;
  if (normalized.startsWith("/") || normalized.startsWith("~/") || normalized.startsWith("//")) {
    return false;
  }
  if (URI_SCHEME_RE.test(normalized)) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;

  const segments = normalized.split("/");
  if (!segments.length) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

export const isRelativeFilePath = (value: string) => {
  if (value === "." || value === "..") return false;

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const hasNonTraversalSegment = segments.some((segment) => segment && segment !== "." && segment !== "..");

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return hasNonTraversalSegment;
  }

  const [firstSegment, secondSegment] = normalized.split("/");
  if (!secondSegment || firstSegment.length <= 1) return false;
  if (secondSegment === "." || secondSegment === "..") return false;
  return firstSegment.startsWith(".") && SAFE_PATH_CHAR_RE.test(secondSegment);
};

export const isBareRelativeFilePath = (value: string) => {
  if (value.includes("/") || value.includes("\\") || value.includes(":")) return false;
  if (!BARE_FILENAME_RE.test(value)) return false;

  const extension = value.split(".").pop() ?? "";
  if (!/[A-Za-z]/.test(extension)) return false;

  const dotCount = (value.match(/\./g) ?? []).length;
  if (dotCount === 1 && !value.includes("_") && !value.includes("-")) {
    const [name, tld] = value.split(".");
    if (/^[A-Za-z]{2,24}$/.test(name ?? "") && /^[A-Za-z]{2,10}$/.test(tld ?? "")) {
      return false;
    }
  }

  return true;
};

export const isLikelyWebLink = (value: string) => WEB_LINK_RE.test(value);

export const isLikelyFilePath = (value: string) => {
  if (FILE_URI_RE.test(value)) return true;
  if (WINDOWS_PATH_RE.test(value)) return true;
  if (POSIX_PATH_RE.test(value)) return true;
  if (TILDE_PATH_RE.test(value)) return true;
  if (isRelativeFilePath(value)) return true;
  if (isBareRelativeFilePath(value)) return true;
  if (isWorkspaceRelativeFilePath(value)) return true;

  return false;
};

export const parseLinkFromToken = (
  token: string,
  options: LinkDetectionOptions = {},
): { href: string; type: LinkType; value: string } | null => {
  let start = 0;
  let end = token.length;

  while (start < end && LEADING_PUNCTU.test(token[start] ?? "")) {
    start += 1;
  }

  while (end > start && TRAILING_PUNCTU.test(token[end - 1] ?? "")) {
    end -= 1;
  }

  const value = token.slice(start, end);
  if (!value) return null;

  if (isLikelyWebLink(value)) {
    return {
      value,
      type: "url",
      href: value.toLowerCase().startsWith("www.") ? `https://${value}` : value,
    };
  }

  if ((options.allowFilePaths ?? true) && isLikelyFilePath(value)) {
    return {
      value,
      type: "file",
      href: value,
    };
  }

  return null;
};

export const splitTextTokens = (text: string, options: LinkDetectionOptions = {}): TextSegment[] => {
  const tokens: TextSegment[] = [];
  const matches = text.matchAll(/\S+/g);
  let position = 0;

  for (const match of matches) {
    const token = match[0] ?? "";
    const index = match.index ?? 0;

    if (index > position) {
      tokens.push({ kind: "text", value: text.slice(position, index) });
    }

    const link = parseLinkFromToken(token, options);
    if (!link) {
      tokens.push({ kind: "text", value: token });
    } else {
      const start = token.indexOf(link.value);
      if (start > 0) {
        tokens.push({ kind: "text", value: token.slice(0, start) });
      }
      tokens.push({ kind: "link", value: link.value, href: link.href, type: link.type });
      const end = start + link.value.length;
      if (end < token.length) {
        tokens.push({ kind: "text", value: token.slice(end) });
      }
    }

    position = index + token.length;
  }

  if (position < text.length) {
    tokens.push({ kind: "text", value: text.slice(position) });
  }

  return tokens;
};

export const normalizeRelativePath = (relativePath: string, workspaceRoot: string) => {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!root) return null;

  const relative = relativePath.trim().replace(/\\/g, "/");
  if (!relative) return null;

  const isPosixRoot = root.startsWith("/");
  const rootValue = isPosixRoot ? root.slice(1) : root;
  const rootParts = rootValue.split("/").filter((value) => value.length > 0);
  const isWindowsDrive = /^[A-Za-z]:$/.test(rootParts[0] ?? "");
  const resolved: string[] = [...rootParts];
  const segments = relative.split("/");

  for (const segment of segments) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      if (!(isWindowsDrive && resolved.length === 1)) {
        resolved.pop();
      }
      continue;
    }

    resolved.push(segment);
  }

  const normalized = resolved.join("/");
  if (isPosixRoot) return `/${normalized || ""}` || "/";
  return normalized;
};

export const normalizeFilePath = (href: string, workspaceRoot: string): string | null => {
  const strippedHref = stripFileReferenceSuffix(href);
  if (!strippedHref) return null;

  if (FILE_URI_RE.test(href)) {
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "file:") return null;
      const raw = decodeURIComponent(parsed.pathname || "");
      if (!raw) return null;
      if (/^\/[A-Za-z]:\//.test(raw)) {
        return raw.slice(1);
      }
      if (parsed.hostname && !parsed.pathname.startsWith(`/${parsed.hostname}`) && !raw.startsWith("/")) {
        return `/${parsed.hostname}${raw}`;
      }
      return raw;
    } catch {
      const raw = decodeURIComponent(href.replace(/^file:\/\//, ""));
      if (!raw) return null;
      return raw;
    }
  }

  const trimmed = strippedHref.trim();
  if (isRelativeFilePath(trimmed) || isBareRelativeFilePath(trimmed) || isWorkspaceRelativeFilePath(trimmed)) {
    if (!workspaceRoot) return null;
    return normalizeRelativePath(trimmed, workspaceRoot);
  }

  return trimmed || null;
};

export type DetectedLocalFileReference = {
  path: string;
  label?: string;
};

export const detectStandaloneFileReference = (raw: string): DetectedLocalFileReference | null => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\n\n")) return null;

  const markdownLink = trimmed.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (markdownLink) {
    const [, label, href] = markdownLink;
    const cleanHref = href.trim();
    if (isLikelyFilePath(cleanHref)) {
      return { path: cleanHref, label: label.trim() || undefined };
    }
    return null;
  }

  const stripped = trimmed.replace(/^`([^`]+)`$/, "$1").replace(/^\*\*([^*]+)\*\*$/, "$1");
  if (!stripped.includes(" ") && isLikelyFilePath(stripped)) {
    return { path: stripped };
  }

  return null;
};
