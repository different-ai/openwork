export type DetectedOs = "mac" | "windows" | "linux";

export function detectOsFromUserAgent(userAgent: string): DetectedOs | null {
  const ua = userAgent.toLowerCase();
  const isMobile = /iphone|ipad|ipod|android|mobile/.test(ua);
  if (isMobile) return null;
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "mac";
  if (ua.includes("linux")) return "linux";
  return null;
}

export function osDownloadLabel(os: DetectedOs | null): string {
  if (os === "windows") return "Download for Windows";
  if (os === "linux") return "Download for Linux";
  if (os === "mac") return "Download for Mac";
  return "Download OpenWork";
}
