import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, shell } from "electron";
import { createBrowserPanel as createBrowserHost } from "@openwork/browser-tabs/electron";
import { listInstalledBrowsers } from "./installed-browsers.mjs";
import { runDetachedTask } from "./process-resilience.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Desktop compatibility: IPC, schemes, menu rendering and browser profile stay
// the same; the shared host owns every native browser view.
export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, checkPolicy }) {
  return createBrowserHost({
    getWindow,
    remoteDebugPort,
    checkPolicy,
    partition: "persist:openwork-browser",
    preloadPath: fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload")),
    openExternal: (url) => shell.openExternal(url),
    runDetachedTask,
    handleDeepLink(url) {
      if (!url.startsWith("openwork://") && !url.startsWith("openwork-dev://")) return false;
      if (typeof onDeepLink === "function") onDeepLink([url]);
      return true;
    },
    menuOverlay: {
      preloadPath: path.join(__dirname, "menu-overlay-preload.mjs"),
      openBuiltinLabel: "Open in OpenWork",
      listInstalledBrowsers,
      async loadRenderer(view) {
        const currentUrl = getWindow()?.webContents?.getURL?.();
        if (currentUrl && /^https?:\/\//i.test(currentUrl)) {
          await view.webContents.loadURL(new URL("overlay.html", currentUrl).toString());
          return;
        }
        const overlayPath = app.isPackaged
          ? path.join(process.resourcesPath, "app-dist", "overlay.html")
          : path.resolve(__dirname, "../../app/dist", "overlay.html");
        await view.webContents.loadFile(overlayPath);
      },
    },
  });
}
