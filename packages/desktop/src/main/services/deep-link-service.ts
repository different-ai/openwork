import { app, ipcMain, type App } from "electron";
import path from "node:path";

import type { DesktopDeepLinkEvent } from "../../../../app/src/app/lib/openwork-desktop";
import { IPC_CHANNELS } from "../ipc/channels";

const DEEP_LINK_PROTOCOLS = new Set(["openwork:", "openwork-dev:"]);
const RECENT_DEEP_LINK_TTL_MS = 1500;

type DeepLinkServiceOptions = {
  app: Pick<App, "on" | "requestSingleInstanceLock" | "setAsDefaultProtocolClient">;
  emitDeepLink: (event: DesktopDeepLinkEvent) => void;
  focusMainWindow: () => void;
};

function parseDeepLink(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (!DEEP_LINK_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractDeepLinks(argv: string[]) {
  return argv.map(parseDeepLink).filter((value): value is string => Boolean(value));
}

function registerProtocolClient(electronApp: Pick<App, "setAsDefaultProtocolClient">) {
  const isDevMode = process.env.OPENWORK_DEV_MODE?.trim() === "1";
  const scheme = isDevMode ? "openwork-dev" : "openwork";

  if (process.defaultApp && process.argv.length >= 2) {
    electronApp.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1] ?? "")]);
    return;
  }

  electronApp.setAsDefaultProtocolClient(scheme);
}

export function createDeepLinkService(options: DeepLinkServiceOptions) {
  const pendingUrls: string[] = [];
  const recentUrls = new Map<string, number>();
  let initialized = false;

  const queueUrls = (urls: string[], source: DesktopDeepLinkEvent["source"]) => {
    const now = Date.now();
    for (const [url, seenAt] of recentUrls) {
      if (now - seenAt > RECENT_DEEP_LINK_TTL_MS) {
        recentUrls.delete(url);
      }
    }

    const accepted: string[] = [];
    for (const url of urls) {
      const seenAt = recentUrls.get(url) ?? 0;
      if (now - seenAt < RECENT_DEEP_LINK_TTL_MS) {
        continue;
      }

      recentUrls.set(url, now);
      pendingUrls.push(url);
      accepted.push(url);
    }

    if (source === "runtime" && accepted.length > 0) {
      options.emitDeepLink({ urls: accepted, source: "runtime" });
      options.focusMainWindow();
    }
  };

  return {
    initializeBeforeReady() {
      if (initialized) {
        return true;
      }

      initialized = true;
      queueUrls(extractDeepLinks(process.argv), "initial");

      if (!options.app.requestSingleInstanceLock()) {
        return false;
      }

      options.app.on("second-instance", (_event, argv) => {
        queueUrls(extractDeepLinks(argv), "runtime");
      });

      options.app.on("open-url", (event, rawUrl) => {
        event.preventDefault();
        const deepLink = parseDeepLink(rawUrl);
        if (!deepLink) {
          return;
        }

        queueUrls([deepLink], "runtime");
      });

      return true;
    },

    onReady() {
      registerProtocolClient(options.app);
    },

    getPending() {
      return pendingUrls.splice(0, pendingUrls.length);
    },
  };
}

export type DeepLinkService = ReturnType<typeof createDeepLinkService>;

export function registerDeepLinkIpc(service: DeepLinkService) {
  ipcMain.handle(IPC_CHANNELS.deepLinks("getPending"), () => service.getPending());
}

export function createDefaultDeepLinkService(options: Omit<DeepLinkServiceOptions, "app">) {
  return createDeepLinkService({ ...options, app });
}
