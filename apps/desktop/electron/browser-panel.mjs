import { fileURLToPath } from "node:url";
import { shell } from "electron";
import { createBrowserPanel as createBrowserHost } from "@openwork/browser-tabs/electron";
import { listInstalledBrowsers } from "./installed-browsers.mjs";
import { runDetachedTask } from "./process-resilience.mjs";
import { BrowserTaskError, createBrowserTaskHost } from "./browser-task.mjs";
import { createWebMcpBroker } from "./webmcp-host.mjs";
import { createWebMcpFramePolicy } from "./webmcp-policy.mjs";

// Desktop supplies its authority and native services; the shared host owns views.
export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, checkPolicy, showNativeContextMenu, closeNativeContextMenu }) {
  return createBrowserHost({
    getWindow, remoteDebugPort, checkPolicy, showNativeContextMenu, closeNativeContextMenu,
    listInstalledBrowsers, createBrowserTaskHost, createWebMcpBroker, createWebMcpFramePolicy, BrowserTaskError,
    partition: "persist:openwork-browser",
    preloadPath: fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload")),
    openExternal: (url) => shell.openExternal(url),
    runDetachedTask,
    handleDeepLink(url) {
      if (!url.startsWith("openwork://") && !url.startsWith("openwork-dev://")) return false;
      if (typeof onDeepLink === "function") onDeepLink([url]);
      return true;
    },
  });
}
