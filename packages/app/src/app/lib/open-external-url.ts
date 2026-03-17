import { isTauriRuntime } from "../utils";

export async function openExternalUrl(url: string): Promise<string> {
  const nextUrl = url.trim();
  if (!nextUrl) return url;

  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(nextUrl);
    return nextUrl;
  }

  if (typeof window !== "undefined") {
    window.open(nextUrl, "_blank", "noopener,noreferrer");
  }

  return nextUrl;
}
