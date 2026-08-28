export function resolveElectronUpdaterInstallError(reason?: string) {
  return {
    state: "error" as const,
    message: reason ?? "Update install failed.",
    failedAction: "install" as const,
  };
}
