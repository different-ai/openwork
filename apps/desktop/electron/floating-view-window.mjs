// A popped-out browser is a real window of the app that stays in view: the
// person moves, resizes, minimizes and full-screens it like any other, and it
// stays above other windows, so bringing OpenWork forward never buries it. The
// renderer opens an empty same-origin window by name and draws the tabs and
// toolbar into it; the browser panel moves the live page in below them. This
// module decides which window.open requests get that treatment.
// (The computer view's pop-out window has its own name and handler in main.mjs.)

export const FLOATING_VIEW_PREFIX = "openwork-floating-";

/**
 * BrowserWindow options for a popped-out browser, or null when the request is
 * not one. Only an empty page under the reserved name qualifies: the renderer
 * draws its toolbar itself, so no page ever loads in the window's own document.
 * @returns {import("electron").BrowserWindowConstructorOptions | null}
 */
export function floatingViewWindowOptions({ url, frameName, dark = false, platform = process.platform }) {
  if (url !== "about:blank" || typeof frameName !== "string" || !frameName.startsWith(FLOATING_VIEW_PREFIX)) return null;
  return {
    show: false,
    // The tab strip sits in the title bar, with the same controls as the app window.
    ...(platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 18 } }
      : { titleBarStyle: "hidden", titleBarOverlay: { height: 40 } }),
    minWidth: 480,
    minHeight: 320,
    // The app's --background, so the window never flashes before styles arrive.
    backgroundColor: dark ? "#111113" : "#fcfcfd",
    webPreferences: {
      // No preload: the window has no bridge of its own; the opener owns it.
      preload: undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  };
}

/**
 * Shows a new window above other apps and on every Space, without taking focus:
 * reopening one with its conversation must not steal the keyboard.
 */
export function attachFloatingViewWindow(child) {
  child.setAlwaysOnTop(true, "floating");
  // Without skipTransformProcessType, Electron hides the app's Dock icon to float over full screen.
  child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  child.webContents.on("will-navigate", (event) => event.preventDefault());
  child.showInactive();
}
