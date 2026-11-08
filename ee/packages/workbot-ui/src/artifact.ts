import type { WorkbotAttachment } from "./data";
import { isImage } from "./images";

/**
 * What a file Workbot made (or the person sent) is, for its card and the panel it opens in: which reader shows it,
 * the name it goes by, and its type in plain words.
 */
export type ArtifactKind = "image" | "pdf" | "video" | "audio" | "markdown" | "text" | "csv" | "sheet" | "slides" | "document" | "html" | "other";

/** The page address names an open file with `?artifact=<id>` (Copy link), so the link opens it again. */
export const ARTIFACT_PARAM = "artifact";

/** This page with the file named, so the link opens it here again (for whoever is signed in to this chat). */
export function artifactLink(fileId: string, href = window.location.href) {
  const url = new URL(href);
  url.searchParams.set(ARTIFACT_PARAM, fileId);
  return url.toString();
}

export const extensionOf = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

export function artifactKind(file: Pick<WorkbotAttachment, "name" | "mediaType">): ArtifactKind {
  const extension = extensionOf(file.name);
  const type = file.mediaType.toLowerCase();
  if (isImage(type) || ["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("video/") || ["mp4", "mov", "webm", "m4v"].includes(extension)) return "video";
  if (type.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg"].includes(extension)) return "audio";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["csv", "tsv"].includes(extension)) return "csv";
  if (extension === "xlsx") return "sheet";
  if (extension === "pptx") return "slides";
  if (extension === "docx") return "document";
  if (["html", "htm"].includes(extension)) return "html";
  if (type.startsWith("text/") || ["txt", "json", "yaml", "yml", "xml", "log", "py", "js", "ts", "sql"].includes(extension)) return "text";
  return "other";
}

const LABELS: Record<ArtifactKind, string> = {
  html: "App", image: "Image", pdf: "PDF", video: "Video", audio: "Audio", markdown: "Note", text: "Text",
  csv: "Spreadsheet", sheet: "Spreadsheet", slides: "Presentation", document: "Document", other: "File",
};

/** The type under a card's title: "App", "PDF", "Spreadsheet". */
export function artifactLabel(file: Pick<WorkbotAttachment, "name" | "mediaType">): string {
  return LABELS[artifactKind(file)];
}

/** The type's color (PDF red, sheets green, …) for its icon and placeholder. */
export function artifactColor(kind: ArtifactKind): string {
  if (kind === "pdf") return "var(--wb-type-pdf)";
  if (kind === "document") return "var(--wb-type-doc)";
  if (kind === "csv" || kind === "sheet") return "var(--wb-type-sheet)";
  if (kind === "slides") return "var(--wb-type-slides)";
  if (kind === "image" || kind === "video") return "var(--wb-type-image)";
  if (kind === "html") return "var(--wb-browser-working)";
  return "var(--wb-muted)";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** An app's own <title>, the name people see it by; null when it has none. */
export function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 65_536));
  const title = match?.[1]
    ?.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 120) : null;
}

/** The name a card and the panel show: an app's <title> when known, otherwise the file name without its extension. */
export function artifactTitle(file: Pick<WorkbotAttachment, "name">, html?: string | null): string {
  const fromHtml = html ? htmlTitle(html) : null;
  if (fromHtml) return fromHtml;
  const extension = extensionOf(file.name);
  const base = extension ? file.name.slice(0, -(extension.length + 1)) : file.name;
  return base.trim() || file.name;
}
