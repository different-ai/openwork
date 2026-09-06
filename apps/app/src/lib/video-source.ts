import type { OpenworkServerClient } from "@/app/lib/openwork-server";

type VideoSourceOptions = {
  href: string;
  mediaType?: string;
  client?: Pick<OpenworkServerClient, "baseUrl" | "downloadWorkspaceFile">;
  workspaceId?: string;
  workspaceRoot?: string;
};

export function videoMimeType(path: string): string | undefined {
  const extension = path.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "mp4":
    case "m4v": return "video/mp4";
    case "webm": return "video/webm";
    case "mov": return "video/quicktime";
    case "ogv": return "video/ogg";
    default: return undefined;
  }
}

/** Resolve only contained paths; a matching filename suffix is never authorization. */
export function workspaceVideoPath(href: string, workspaceRoot?: string): string | null {
  let path = href.trim();
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      if (url.hostname && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
    } catch {
      return null;
    }
  } else {
    path = path.split(/[?#]/)[0] ?? "";
    try { path = decodeURIComponent(path); } catch { /* Preserve literal percent signs. */ }
  }
  path = path.replace(/\\/g, "/");
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.split("/").includes("..")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[A-Za-z]:\//.test(path)) return null;

  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    if (!workspaceRoot) return null;
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = `${root}/`;
    const windows = /^[A-Za-z]:\//.test(prefix) || prefix.startsWith("//");
    if (!(windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return null;
    path = path.slice(prefix.length);
  } else {
    path = path.replace(/^\.\//, "")
      .replace(/^workspaces\/[^/]+\//i, "")
      .replace(/^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i, "")
      .replace(/^workspace\//i, "");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return null;
  return path;
}

export async function resolveVideoSource({ href, mediaType, client, workspaceId, workspaceRoot }: VideoSourceOptions): Promise<string | Blob> {
  const source = href.trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) throw new Error("Invalid video source");
  let path: string | null;
  if (/^https?:/i.test(source)) {
    const url = new URL(source);
    if (url.username || url.password) throw new Error("Invalid video source");
    // Workspace URLs still need the client's authentication, never credentials on an external URL.
    const rawUrl = client && workspaceId
      ? new URL(`${client.baseUrl}/workspace/${encodeURIComponent(workspaceId)}/files/raw`)
      : null;
    if (!rawUrl || url.origin !== rawUrl.origin || url.pathname !== rawUrl.pathname) return url.href;
    path = workspaceVideoPath(url.searchParams.get("path") ?? "", workspaceRoot);
  } else if (/^data:video\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(source)) {
    return source;
  } else if (/^blob:/i.test(source)) {
    const origin = source.slice(5);
    if (!origin.startsWith("null/") && !["http:", "https:", "file:"].includes(new URL(origin).protocol)) {
      throw new Error("Invalid video source");
    }
    return source;
  } else {
    path = workspaceVideoPath(source, workspaceRoot);
  }
  if (!client || !workspaceId || !path) throw new Error("Video is not available in this workspace");
  const result = await client.downloadWorkspaceFile(workspaceId, path);
  const type = result.contentType?.toLowerCase().startsWith("video/")
    ? result.contentType
    : mediaType?.toLowerCase().startsWith("video/") ? mediaType : videoMimeType(path);
  return new Blob([result.data], { type });
}

/** Shared by React attachments and the native players inside rendered Markdown. */
export function attachVideoSource(video: HTMLVideoElement, notice: HTMLElement, options: VideoSourceOptions): () => void {
  let cancelled = false;
  let objectUrl: string | undefined;
  let hasSource = false;
  video.controls = true;
  video.playsInline = true;
  video.autoplay = false;
  video.preload = "metadata";
  if (video.hasAttribute("src")) {
    video.removeAttribute("src");
    video.load();
  }
  notice.setAttribute("role", "status");
  notice.textContent = "Loading video...";
  notice.hidden = false;
  const showError = () => {
    if (cancelled) return;
    notice.textContent = "Video preview unavailable. Open or download the file to play it.";
    notice.hidden = false;
  };
  const onError = () => { if (hasSource) showError(); };
  const onReady = () => { if (!cancelled && hasSource) notice.hidden = true; };
  video.addEventListener("error", onError);
  video.addEventListener("loadedmetadata", onReady);
  void resolveVideoSource(options).then((source) => {
    if (cancelled) return;
    // Allocate only after checking cancellation, so late downloads cannot leak a URL.
    hasSource = true;
    if (typeof source === "string") {
      video.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      video.src = objectUrl;
    }
  }).catch(showError);
  return () => {
    cancelled = true;
    video.removeEventListener("error", onError);
    video.removeEventListener("loadedmetadata", onReady);
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
