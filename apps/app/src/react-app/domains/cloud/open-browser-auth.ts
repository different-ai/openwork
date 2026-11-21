import { openDesktopUrlWithStatus } from "../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../app/utils";

export type BrowserAuthOpenStatus = "opened" | "opening" | "failed";

export async function openBrowserAuthUrl(url: string): Promise<BrowserAuthOpenStatus> {
  if (isDesktopRuntime()) {
    try {
      return await openDesktopUrlWithStatus(url);
    } catch (error) {
      console.error("[den-auth] failed to open browser:", error);
      return "failed";
    }
  }

  return window.open(url, "_blank") !== null ? "opened" : "failed";
}

export async function tryOpenBrowserAuthUrl(url: string): Promise<boolean> {
  return (await openBrowserAuthUrl(url)) !== "failed";
}
