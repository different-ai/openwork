export function installBrowserShortcutFocusTracking(window, reportFocus) {
  const { document } = window;
  const handleFocus = (event) => {
    if (event.isTrusted !== true) return;
    // Native tab closure can return focus to the shell body without new user intent.
    if (event.type === "focusin"
      && (event.target === document.body || event.target === document.documentElement)) return;
    reportFocus(event.target?.closest?.("[data-browser-shortcut-tab]")?.getAttribute("data-browser-shortcut-tab") || null);
  };
  const clearFocus = (event) => {
    if (event.isTrusted === true) reportFocus(null);
  };

  window.addEventListener("pointerdown", handleFocus, { capture: true });
  window.addEventListener("focusin", handleFocus, { capture: true });
  for (const type of ["beforeunload", "hashchange", "popstate"]) {
    window.addEventListener(type, clearFocus, { capture: true });
  }
}
