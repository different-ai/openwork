export type CoworkerArtifactKind =
  | "browser"
  | "document"
  | "sheet"
  | "slides"
  | "image"
  | "pdf"
  | "code"
  | "file";

export type CoworkerArtifact = {
  kind: CoworkerArtifactKind;
  label: string;
  value: string;
  openUrl?: string;
};

type ArtifactToolCall = {
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  metadata: Record<string, unknown>;
};

const FILE_KEY = /(?:artifact|attachment|download|file|filename|output|path|preview)/i;
const URL_KEY = /(?:browser|href|link|page|preview|uri|url)/i;
const BROWSER_TOOL = /(?:browser|navigate|open_page|screenshot|webfetch|web_fetch|webpage)/i;
const FILE_VALUE = /(?:^|[/\\])[^/\\]+\.([a-z0-9]{1,8})$/i;

function fileKind(extension: string): CoworkerArtifactKind {
  if (["doc", "docx", "md", "rtf", "txt"].includes(extension)) return "document";
  if (["csv", "xls", "xlsx", "ods"].includes(extension)) return "sheet";
  if (["key", "ppt", "pptx", "odp"].includes(extension)) return "slides";
  if (["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (["c", "cc", "cpp", "css", "go", "html", "java", "js", "jsx", "json", "mjs", "py", "rb", "rs", "sh", "sql", "ts", "tsx", "vue", "yaml", "yml"].includes(extension)) return "code";
  return "file";
}

function shortFileLabel(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  return withoutQuery.split(/[/\\]/).filter(Boolean).pop() || value;
}

function browserLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname || "Browser preview";
  } catch {
    return "Browser preview";
  }
}

function artifactFromString(value: string, key: string, tool: string): CoworkerArtifact | null {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) && (URL_KEY.test(key) || BROWSER_TOOL.test(tool))) {
    return { kind: "browser", label: browserLabel(trimmed), value: trimmed, openUrl: trimmed };
  }
  if (!FILE_KEY.test(key)) return null;
  const match = trimmed.match(FILE_VALUE);
  if (!match) return null;
  return { kind: fileKind((match[1] ?? "").toLowerCase()), label: shortFileLabel(trimmed), value: trimmed };
}

/**
 * Finds user-facing outputs in heterogeneous tool payloads without assuming a
 * provider-specific schema. Keys provide intent, recursion is bounded, and
 * the result is deliberately small enough to stay secondary to the answer.
 */
export function artifactsForToolCall(call: ArtifactToolCall): CoworkerArtifact[] {
  const artifacts: CoworkerArtifact[] = [];
  const seen = new Set<string>();

  function add(candidate: CoworkerArtifact | null) {
    if (!candidate || artifacts.length >= 3) return;
    const identity = `${candidate.kind}:${candidate.value}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    artifacts.push(candidate);
  }

  function visit(value: unknown, key: string, depth: number) {
    if (depth > 4 || artifacts.length >= 3) return;
    if (typeof value === "string") {
      add(artifactFromString(value, key, call.tool));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, key, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      visit(child, childKey, depth + 1);
      if (artifacts.length >= 3) break;
    }
  }

  // Completed outputs and OpenWork metadata are stronger evidence than input.
  visit(call.output, "output", 0);
  visit(call.metadata, "metadata", 0);
  visit(call.input, BROWSER_TOOL.test(call.tool) ? "url" : "input", 0);
  return artifacts;
}

export function artifactKindLabel(kind: CoworkerArtifactKind): string {
  return {
    browser: "Browser",
    document: "Document",
    sheet: "Spreadsheet",
    slides: "Slides",
    image: "Image",
    pdf: "PDF",
    code: "Code",
    file: "File",
  }[kind];
}
