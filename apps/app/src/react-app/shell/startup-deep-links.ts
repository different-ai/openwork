import {
  pushPendingDeepLinks,
} from "../../app/lib/deep-link-bridge";
import { subscribeDesktopDeepLinks } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

let started = false;

export function startDeepLinkBridge(): void {
  if (typeof window === "undefined" || started) return;
  started = true;

  if (!isDesktopRuntime()) {
    pushPendingDeepLinks(window, [window.location.href]);
    return;
  }

  void (async () => {
    try {
      await subscribeDesktopDeepLinks((urls) => {
        pushPendingDeepLinks(window, urls);
      });
    } catch {
      // ignore startup failures
    }
  })();
}
