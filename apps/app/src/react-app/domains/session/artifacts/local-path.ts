/**
 * One reader for every file reference a chat can contain: inline code
 * (`~/Downloads/clip.mp4`, `computer-control.test.mjs:813`), Markdown link
 * destinations (`[plan](docs/plan.md)`, `file:///Users/me/a%20b.pdf`), file
 * chips and tool metadata. Each surface used to clean these up on its own, so
 * a home-relative path or a `:line` suffix worked in one place and failed in
 * another. Everything that turns chat text into a file open goes through
 * `parseLocalPathReference` and `resolveLocalPath`.
 *
 * These are string-level helpers. The OpenWork server finds the real file in
 * the workspace (including a bare name anywhere in it) and the desktop makes
 * the final launch-or-reveal decision on disk.
 */

/** How a reference is anchored before it becomes a real location. */
export type LocalPathAnchor = "absolute" | "home" | "relative";

export type LocalPathReference = {
  /**
   * The path the person meant: wrapping quotes, trailing punctuation, a
   * `file://` scheme and any `:line[:column]` suffix removed. A home path keeps
   * its leading `~/`; a relative path drops a leading `./`.
   */
  path: string;
  anchor: LocalPathAnchor;
  /** A single name such as `report.pdf`, which may live anywhere in the workspace. */
  bare: boolean;
  line?: number;
  column?: number;
};

export type ParseLocalPathOptions = {
  /**
   * The value is a link destination, which is URL-encoded: decode it once
   * (`Acme%20Quote.pdf` names `Acme Quote.pdf`). Inline code is literal text
   * and is never decoded.
   */
  decode?: boolean;
};

const MAX_PATH_LENGTH = 1024;
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["\"", "\""],
  ["'", "'"],
  ["`", "`"],
  ["<", ">"],
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
];
const CLOSING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const QUOTE = /["'`\u201c\u201d\u2018\u2019]/;
const TRAILING_PUNCTUATION = /[.,;:!?\u2026]$/;
// `file.ts:12`, `file.ts:12:5`, `file.ts#L12`, `file.ts#L12C5`, `file.ts#L12-L20`, `file.ts(12,5)`.
const LINE_SUFFIX = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|\((\d+)(?:,\s*(\d+))?\))$/i;
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function count(value: string, character: string) {
  let total = 0;
  for (const char of value) if (char === character) total++;
  return total;
}

/** Remove wrapping quotes/brackets and trailing sentence punctuation until stable. */
function stripDecoration(input: string): string {
  let value = input.trim();
  for (;;) {
    const before = value;
    const wrapper = WRAPPERS.find(([open, close]) => value.length >= 2 && value.startsWith(open) && value.endsWith(close));
    if (wrapper) value = value.slice(wrapper[0].length, value.length - wrapper[1].length).trim();
    if (TRAILING_PUNCTUATION.test(value)) value = value.slice(0, -1).trimEnd();
    const last = value.at(-1) ?? "";
    const opener = CLOSING_BRACKETS[last];
    // `(see notes.md)` keeps nothing of its brackets; `chart(1).png` keeps both.
    if (opener && count(value, opener) < count(value, last)) value = value.slice(0, -1).trimEnd();
    const first = value.at(0) ?? "";
    const closer = Object.entries(CLOSING_BRACKETS).find(([, open]) => open === first)?.[0];
    if (closer && count(value, closer) < count(value, first)) value = value.slice(1).trimStart();
    // A lone quote left by a sentence (`"notes.md`, `notes.md'`) is not part of the name.
    if (QUOTE.test(value.at(0) ?? "") && !QUOTE.test(value.slice(1))) value = value.slice(1).trimStart();
    if (QUOTE.test(value.at(-1) ?? "") && !QUOTE.test(value.slice(0, -1))) value = value.slice(0, -1).trimEnd();
    if (value === before) return value;
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** `file:` URLs name a local file only without a host (or `localhost`) and without a query. */
function pathFromFileUrl(value: string): { path: string; line?: number; column?: number } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.hostname && url.hostname.toLowerCase() !== "localhost") || url.search) return null;
  let line: number | undefined;
  let column: number | undefined;
  if (url.hash) {
    const match = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(url.hash);
    if (!match) return null;
    line = positiveInteger(match[1]);
    column = positiveInteger(match[2]);
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return { path, line, column };
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || WINDOWS_DRIVE.test(path);
}

function segmentsOf(path: string) {
  return path.split(/[/\\]/);
}

/**
 * Read a file reference out of chat text. Returns null for anything that is not
 * a local file path (web addresses, `mailto:`, network shares, `~user/…`,
 * `../` escapes from the workspace, control characters), so callers neither
 * linkify it nor try to open it.
 */
export function parseLocalPathReference(input: string, options: ParseLocalPathOptions = {}): LocalPathReference | null {
  let value = stripDecoration(String(input ?? ""));
  if (!value || value.length > MAX_PATH_LENGTH) return null;

  let line: number | undefined;
  let column: number | undefined;
  if (/^file:/i.test(value)) {
    const fromUrl = pathFromFileUrl(value);
    if (!fromUrl) return null;
    value = fromUrl.path;
    line = fromUrl.line;
    column = fromUrl.column;
  } else if (options.decode) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // A literal percent sign is part of the name (`50% off.pdf`).
    }
  }

  const suffix = LINE_SUFFIX.exec(value);
  if (suffix && suffix.index > 0) {
    line ??= positiveInteger(suffix[1] ?? suffix[3] ?? suffix[5]);
    column ??= positiveInteger(suffix[2] ?? suffix[4] ?? suffix[6]);
    value = stripDecoration(value.slice(0, suffix.index));
  }

  if (!value || CONTROL_CHARACTERS.test(value) || /^[/\\]{2}/.test(value)) return null;
  if (URL_SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) return null;

  let anchor: LocalPathAnchor;
  if (isAbsolutePath(value)) {
    anchor = "absolute";
  } else if (/^~[/\\]/.test(value)) {
    anchor = "home";
  } else if (value.startsWith("~")) {
    // `~` alone is a folder; `~someone/…` is another account's home.
    return null;
  } else {
    anchor = "relative";
    value = value.replace(/^(?:\.[/\\])+/, "");
  }

  const segments = segmentsOf(anchor === "home" ? value.slice(2) : value);
  const name = segments.at(-1) ?? "";
  if (!name || /^\.{1,2}$/.test(name)) return null;
  // Home and workspace paths must stay where they point; an absolute path is
  // taken as written and the opener decides whether it is inside the workspace.
  if (anchor !== "absolute" && segments.some((segment) => !segment || /^\.{1,2}\s*$/.test(segment))) return null;

  return {
    path: value,
    anchor,
    bare: anchor === "relative" && segments.length === 1,
    ...(line ? { line } : {}),
    ...(line && column ? { column } : {}),
  };
}

export type LocalPathContext = {
  /** Absolute folder of the workspace the conversation belongs to. */
  workspaceRoot?: string | null;
  /** The person's home folder, when the desktop has told us. */
  homeDir?: string | null;
};

function usableRoot(root: string | null | undefined): string | null {
  const value = root?.trim();
  if (!value || !isAbsolutePath(value) || CONTROL_CHARACTERS.test(value) || /^[/\\]{2}/.test(value)) return null;
  return value.replace(/[/\\]+$/, "") || value;
}

function joinPath(base: string, rest: string) {
  return base === "/" ? `/${rest}` : `${base}/${rest}`;
}

/**
 * The absolute location a reference names, or null when it cannot be known
 * here (a home path without the home folder, a relative path without a
 * workspace). A relative path is joined to the workspace root as written;
 * callers that can search the workspace should do that first for bare names.
 */
export function resolveLocalPath(reference: LocalPathReference, context: LocalPathContext): string | null {
  if (reference.anchor === "absolute") return reference.path;
  if (reference.anchor === "home") {
    const home = usableRoot(context.homeDir);
    return home ? joinPath(home, reference.path.slice(2)) : null;
  }
  const root = usableRoot(context.workspaceRoot);
  return root ? joinPath(root, reference.path) : null;
}

function comparablePath(path: string) {
  return path
    .replace(/[\\]+/g, "/")
    .replace(/\/+$/, "")
    .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
}

/** `path` relative to the workspace root, or null when it is not inside it. */
export function workspaceRelativePath(root: string | null | undefined, path: string): string | null {
  const base = usableRoot(root);
  if (!base) return null;
  const container = comparablePath(base);
  const candidate = comparablePath(path);
  // A dot segment can leave the workspace after the prefix matches; never treat it as inside.
  if (candidate.split("/").some((segment) => /^\.{1,2}\s*$/.test(segment))) return null;
  if (!container) return null;
  if (!candidate.startsWith(`${container}/`)) return null;
  return candidate.slice(container.length + 1) || null;
}

/**
 * The value to ask the workspace about: workspace-relative when the reference
 * points inside the workspace (including a home path that does), otherwise the
 * absolute location, or the path as written when it cannot be resolved here.
 */
export function workspaceLookupValue(reference: LocalPathReference, context: LocalPathContext): string {
  if (reference.anchor === "relative") return reference.path;
  const absolute = resolveLocalPath(reference, context);
  if (!absolute) return reference.path;
  return workspaceRelativePath(context.workspaceRoot, absolute) ?? absolute;
}

/** The last path segment, for labels and toasts. */
export function localPathName(path: string): string {
  return segmentsOf(path).filter(Boolean).at(-1) ?? path;
}
