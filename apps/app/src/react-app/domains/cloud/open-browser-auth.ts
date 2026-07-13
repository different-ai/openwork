import { openDesktopUrl } from "../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../app/utils";

export async function tryOpenBrowserAuthUrl(url: string): Promise<boolean> {
  if (isDesktopRuntime()) {
    try {
      await openDesktopUrl(url);
      return true;
    } catch (error) {
      console.error("[den-auth] failed to open browser:", error);
      return false;
    }
  }

  return window.open(url, "_blank") !== null;
}
