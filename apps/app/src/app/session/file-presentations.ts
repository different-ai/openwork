import type { ArtifactItem } from "../types";

export type FilePresentation = {
  title: string;
  detail?: string;
  typeLabel: string;
  extension: string;
  category: "spreadsheet" | "document" | "image" | "code" | "archive" | "media" | "data" | "file";
};

export type FileReferenceCard = {
  id: string;
  path: string;
  title?: string;
  detail?: string;
  mime?: string;
  source: "artifact" | "file-part" | "text";
};

const EXTENSION_LABELS: Record<string, { typeLabel: string; category: FilePresentation["category"] }> = {
  csv: { typeLabel: "Table · CSV", category: "spreadsheet" },
  tsv: { typeLabel: "Table · TSV", category: "spreadsheet" },
  xlsx: { typeLabel: "Spreadsheet · XLSX", category: "spreadsheet" },
  xls: { typeLabel: "Spreadsheet · XLS", category: "spreadsheet" },
  numbers: { typeLabel: "Spreadsheet · Numbers", category: "spreadsheet" },
  md: { typeLabel: "Document · Markdown", category: "document" },
  txt: { typeLabel: "Document · Text", category: "document" },
  pdf: { typeLabel: "Document · PDF", category: "document" },
  doc: { typeLabel: "Document · Word", category: "document" },
  docx: { typeLabel: "Document · Word", category: "document" },
  html: { typeLabel: "Document · HTML", category: "document" },
  json: { typeLabel: "Data · JSON", category: "data" },
  jsonl: { typeLabel: "Data · JSONL", category: "data" },
  yaml: { typeLabel: "Data · YAML", category: "data" },
  yml: { typeLabel: "Data · YAML", category: "data" },
  xml: { typeLabel: "Data · XML", category: "data" },
  ts: { typeLabel: "Code · TypeScript", category: "code" },
  tsx: { typeLabel: "Code · TSX", category: "code" },
  js: { typeLabel: "Code · JavaScript", category: "code" },
  jsx: { typeLabel: "Code · JSX", category: "code" },
  py: { typeLabel: "Code · Python", category: "code" },
  rs: { typeLabel: "Code · Rust", category: "code" },
  go: { typeLabel: "Code · Go", category: "code" },
  sh: { typeLabel: "Script · Shell", category: "code" },
  bash: { typeLabel: "Script · Bash", category: "code" },
  css: { typeLabel: "Code · CSS", category: "code" },
  png: { typeLabel: "Image · PNG", category: "image" },
  jpg: { typeLabel: "Image · JPEG", category: "image" },
  jpeg: { typeLabel: "Image · JPEG", category: "image" },
  gif: { typeLabel: "Image · GIF", category: "image" },
  webp: { typeLabel: "Image · WebP", category: "image" },
  svg: { typeLabel: "Image · SVG", category: "image" },
  zip: { typeLabel: "Archive · ZIP", category: "archive" },
  tar: { typeLabel: "Archive · TAR", category: "archive" },
  gz: { typeLabel: "Archive · GZip", category: "archive" },
  mp4: { typeLabel: "Media · MP4", category: "media" },
  mov: { typeLabel: "Media · MOV", category: "media" },
  mp3: { typeLabel: "Media · MP3", category: "media" },
  wav: { typeLabel: "Media · WAV", category: "media" },
};

const MIME_PREFIX_PRESENTATIONS: Array<{
  prefix: string;
  typeLabel: string;
  category: FilePresentation["category"];
}> = [
  { prefix: "image/", typeLabel: "Image", category: "image" },
  { prefix: "audio/", typeLabel: "Media · Audio", category: "media" },
  { prefix: "video/", typeLabel: "Media · Video", category: "media" },
  { prefix: "text/", typeLabel: "Document · Text", category: "document" },
];

export const normalizeReferencePath = (value: string) =>
  value.trim().replace(/[\\/]+/g, "/");

export const referenceKey = (value: string) => normalizeReferencePath(value).toLowerCase();

export const filenameFromPath = (value: string) => {
  const normalized = normalizeReferencePath(value);
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
};

export const extensionFromPath = (value: string) => {
  const filename = filenameFromPath(value);
  const extension = filename.split(".").pop() ?? "";
  return extension.toLowerCase();
};

export const filePresentationForReference = (options: {
  path: string;
  title?: string;
  detail?: string;
  mime?: string;
}): FilePresentation => {
  const normalizedPath = normalizeReferencePath(options.path);
  const extension = extensionFromPath(normalizedPath);
  const titled = options.title?.trim();
  const mime = options.mime?.trim().toLowerCase() ?? "";
  const explicit = extension ? EXTENSION_LABELS[extension] : undefined;
  const mimeMatch = MIME_PREFIX_PRESENTATIONS.find((entry) => mime.startsWith(entry.prefix));
  const typeLabel = explicit?.typeLabel ?? mimeMatch?.typeLabel ?? (extension ? `File · ${extension.toUpperCase()}` : "File");
  const category = explicit?.category ?? mimeMatch?.category ?? "file";
  const filename = filenameFromPath(normalizedPath);
  return {
    title: titled || filename,
    detail: options.detail?.trim() || normalizedPath,
    typeLabel,
    extension,
    category,
  };
};

export const fileReferenceCardFromArtifact = (artifact: ArtifactItem): FileReferenceCard | null => {
  const path = artifact.path?.trim();
  if (!path) return null;
  return {
    id: artifact.id,
    path,
    title: artifact.name,
    detail: artifact.path,
    source: "artifact",
  };
};

export const dedupeFileReferenceCards = (items: FileReferenceCard[]) => {
  const next = new Map<string, FileReferenceCard>();
  for (const item of items) {
    const key = referenceKey(item.path);
    if (!key) continue;
    next.set(key, item);
  }
  return Array.from(next.values());
};
