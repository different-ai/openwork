export function isElectronRuntime() {
  return typeof window !== "undefined" && (window as Window).__OPENWORK_ELECTRON__ != null;
}

export function isDesktopRuntime() {
  return isElectronRuntime();
}
