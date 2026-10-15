import { openDesktopUrl } from "../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../app/utils";

export async function tryOpenBrowserAuthUrl(url: string, sameTab = false): Promise<boolean> {
  if (isDesktopRuntime()) {
    try {
      await openDesktopUrl(url);
      return true;
    } catch (error) {
      console.error("[den-auth] failed to open browser:", error);
      return false;
    }
  }

  if (sameTab) {
    try {
      window.location.assign(url);
      return true;
    } catch {
      return false;
    }
  }
  return window.open(url, "_blank") !== null;
}
