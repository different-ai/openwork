import * as React from "react";

import { useOpenTargets } from "@/lib/target-provider";
import type { OpenTarget, OpenTargetPreview } from "@/react-app/domains/session/artifacts/open-target";

export type ArtifactType = "website" | "markdown" | "sheet" | "slides" | "document" | "image" | "video" | "audio" | "pdf" | "html" | "text" | "unknown";

export function getArtifactType(filename: string): ArtifactType {
  const extension = getFileExtension(filename);

  if (!extension) {
    return "unknown";
  }

  if (["md", "markdown", "mdx", "mmd", "rmd", "rst"].includes(extension)) {
    return "markdown";
  }

  if (["csv", "tsv", "xlsx", "xls", "xlsm", "xlsb", "ods", "numbers"].includes(extension)) {
    return "sheet";
  }

  if (["ppt", "pptx", "pptm", "pot", "potx", "odp", "key", "sxi"].includes(extension)) {
    return "slides";
  }

  if (["doc", "docx", "odt", "rtf", "pages"].includes(extension)) {
    return "document";
  }

  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif", "tif", "tiff"].includes(extension)) {
    return "image";
  }

  if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v", "ogv", "mpeg", "mpg", "3gp"].includes(extension)) {
    return "video";
  }

  if (["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "aif", "mid", "midi"].includes(extension)) {
    return "audio";
  }

  if (["pdf"].includes(extension)) {
    return "pdf";
  }

  if (["html", "htm", "xhtml"].includes(extension)) {
    return "html";
  }

  if (["txt", "log", "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "ini", "env", "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "css", "scss", "sass", "less", "py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "cpp", "h", "cs", "sql", "sh", "bash", "zsh"].includes(extension)) {
    return "text";
  }

  return "unknown";
}

function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase();
}

function getArtifactName(path: string) {
  const segments = path.split(/[/\\]/);
  
  return segments[segments.length - 1] ?? path;
}

function artifactTypeToPreview(type: ArtifactType): OpenTargetPreview {
  if (type === "markdown") return "markdown";
  if (type === "sheet") return "sheet";
  if (type === "slides") return "slides";
  if (type === "document") return "document";
  if (type === "image") return "image";
  if (type === "pdf") return "pdf";
  if (type === "html") return "html";
  if (type === "text") return "text";
  if (type === "website") return "browser";
  return "external";
}

/** Open any file path in the artifact preview panel (markdown, code, images…). */
export function useOpenArtifactPath() {
  const { onOpenTarget } = useOpenTargets();

  return React.useCallback((path: string, options?: { external?: boolean }) => {
    // Explicit file actions must not strip path prefixes or reuse suffix matches.
    const target: OpenTarget = {
      id: `file:${path}`,
      kind: "file",
      value: path,
      name: getArtifactName(path),
      preview: artifactTypeToPreview(getArtifactType(path)),
      confidence: 95,
      reason: "artifact",
    };
    onOpenTarget?.(target, options);
  }, [onOpenTarget]);
}
