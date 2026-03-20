/* @refresh reload */
import { render } from "solid-js/web";

import "../../app/src/app/index.css";
import { PlatformProvider, type Platform } from "../../app/src/app/context/platform";
import { bootstrapTheme } from "../../app/src/app/theme";
import { isTauriRuntime } from "../../app/src/app/utils";
import { initLocale } from "../../app/src/i18n";
import StoryBookApp from "./story-book";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const platform: Platform = {
  platform: isTauriRuntime() ? "desktop" : "web",
  openLink(url: string) {
    if (isTauriRuntime()) {
      void import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(url))
        .catch(() => undefined);
      return;
    }
    window.open(url, "_blank");
  },
  restart: async () => {
    if (isTauriRuntime()) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
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

render(
  () => (
    <PlatformProvider value={platform}>
      <StoryBookApp />
    </PlatformProvider>
  ),
  root,
);
