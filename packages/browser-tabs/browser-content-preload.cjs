const { ipcRenderer } = require("electron");

function dismissMenuOverlay() {
  ipcRenderer.send("openwork:menu-overlay:dismiss");
}

function installDismissListeners() {
  window.addEventListener("pointerdown", dismissMenuOverlay, { capture: true });
  window.addEventListener("wheel", dismissMenuOverlay, { capture: true, passive: true });
  window.addEventListener("keydown", dismissMenuOverlay, { capture: true });
  // Browser-native and CDP key delivery take different paths in Chromium.
  // This isolated-world fallback requests only a presentation exit, never
  // task permission or Resume. The host checks the exact foreground view.
  window.addEventListener("keydown", (event) => {
    if (event.isTrusted && event.key === "Escape") ipcRenderer.send("openwork:browser:escape");
  }, { capture: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installDismissListeners, { once: true });
} else {
  installDismissListeners();
}
