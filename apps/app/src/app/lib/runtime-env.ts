// Runtime detection primitives. Leaf module by design: keep it import-free so
// low-level clients (opencode, openwork-server, den) can use it without
// dragging in the utils barrel (which pulls i18n and app constants).
export function isElectronRuntime() {
  return typeof window !== "undefined" && (window as Window).__OPENWORK_ELECTRON__ != null;
}

export function isDesktopRuntime() {
  return isElectronRuntime();
}

// True when the desktop was launched with OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY=1.
// Bridged synchronously via the preload meta so first-render code (e.g. the
// first-run loader arming) can treat the profile as fresh even when stale
// renderer localStorage still remembers a previous workspace.
export function isDesktopWorkspaceRecoveryDisabled() {
  return (
    typeof window !== "undefined" &&
    (window as Window).__OPENWORK_ELECTRON__?.meta?.disableWorkspaceRecovery === true
  );
}
