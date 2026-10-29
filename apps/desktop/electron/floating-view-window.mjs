// The floating browser card lives in its own borderless window so it floats
// over every app, not just inside OpenWork. The renderer opens an empty
// same-origin window by name and draws into it; this module decides which
// window.open requests get that treatment. (The computer view's pop-out window
// has its own name and handler in main.mjs.)

export const FLOATING_VIEW_PREFIX = "openwork-floating-";

/**
 * BrowserWindow options for a floating view, or null when the request is not
 * one. Only an empty page under the reserved name qualifies: the renderer
 * draws every pixel itself, so no page ever loads there.
 */
export function floatingViewWindowOptions({ url, frameName }) {
  if (url !== "about:blank" || typeof frameName !== "string" || !frameName.startsWith(FLOATING_VIEW_PREFIX)) return null;
  return {
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    roundedCorners: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    minWidth: 220,
    minHeight: 44,
    backgroundColor: "#00000000",
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

/** Shows a new floating view without taking focus from the chat, above other apps. */
export function attachFloatingViewWindow(child) {
  child.setAlwaysOnTop(true, "floating");
  child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  child.webContents.on("will-navigate", (event) => event.preventDefault());
  child.showInactive();
}
