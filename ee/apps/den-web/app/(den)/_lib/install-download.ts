export type InstallPlatform = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64" | "linux-arm64";

export function buildInstallDownloadHref(apiUrl: string, platform: InstallPlatform, token: string) {
  const url = new URL(apiUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/v1/install/${platform}`;
  url.search = `?token=${encodeURIComponent(token)}`;
  url.hash = "";
  return url.toString();
}
