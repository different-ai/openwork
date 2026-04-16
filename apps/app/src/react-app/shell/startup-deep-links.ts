import {
  nativeDeepLinkEvent,
  pushPendingDeepLinks,
} from "../../app/lib/deep-link-bridge";
import { isTauriRuntime } from "../../app/utils";

let started = false;

export function startDeepLinkBridge(): void {
  if (typeof window === "undefined" || started) return;
  started = true;

  if (!isTauriRuntime()) {
    pushPendingDeepLinks(window, [window.location.href]);
    return;
  }

  void (async () => {
    try {
      const [{ getCurrent, onOpenUrl }, { listen }] = await Promise.all([
        import("@tauri-apps/plugin-deep-link"),
        import("@tauri-apps/api/event"),
      ]);

      const startUrls = await getCurrent().catch(() => null);
      if (Array.isArray(startUrls)) {
        pushPendingDeepLinks(window, startUrls);
      }

      await onOpenUrl((urls) => {
        pushPendingDeepLinks(window, urls);
      }).catch(() => undefined);

      await listen<string[]>(nativeDeepLinkEvent, (event) => {
        if (Array.isArray(event.payload)) {
          pushPendingDeepLinks(window, event.payload);
        }
      }).catch(() => undefined);
    } catch {
      // ignore startup failures
    }
  })();
}
