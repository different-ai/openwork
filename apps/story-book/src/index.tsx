/* @refresh reload */
import { render } from "solid-js/web";

import "../../app/src/app/index.css";
import { openDesktopUrl, relaunchDesktopApp } from "../../app/src/app/lib/desktop";
import { ConnectionsProvider } from "../../app/src/app/connections/provider";
import { PlatformProvider, type Platform } from "../../app/src/app/context/platform";
import { bootstrapTheme } from "../../app/src/app/theme";
import { isDesktopRuntime } from "../../app/src/app/utils";
import { initLocale } from "../../app/src/i18n";
import NewLayoutApp from "./new-layout";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const platform: Platform = {
  platform: isDesktopRuntime() ? "desktop" : "web",
  openLink(url: string) {
    if (isDesktopRuntime()) {
      void openDesktopUrl(url).catch(() => undefined);
      return;
    }
    window.open(url, "_blank");
  },
  restart: async () => {
    if (isDesktopRuntime()) {
      await relaunchDesktopApp();
      return;
    }
    window.location.reload();
  },
  notify: async () => undefined,
  storage: (name) => {
    const prefix = name ? `${name}:` : "";
    return {
      getItem: (key) => window.localStorage.getItem(prefix + key),
      setItem: (key, value) => window.localStorage.setItem(prefix + key, value),
      removeItem: (key) => window.localStorage.removeItem(prefix + key),
    };
  },
  fetch,
};

const storyConnectionsStore = {
  mcpServers: () => [],
  mcpStatuses: () => ({}),
  mcpStatus: () => null,
} as any;

render(
  () => (
    <PlatformProvider value={platform}>
      <ConnectionsProvider store={storyConnectionsStore}>
        <NewLayoutApp />
      </ConnectionsProvider>
    </PlatformProvider>
  ),
  root,
);
