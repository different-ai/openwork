import { orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";

export type DenShellAppearance = "grey";

export const DEN_SHELL_STORAGE_KEY = "openwork.den.shell";

type ShellOrgContext = Pick<DenOrgContext, "features"> | null | undefined;

export function denShellAppearance(orgContext: ShellOrgContext, remembered: string | null = null): DenShellAppearance | undefined {
  if (orgContext) return orgFeatureEnabled(orgContext, "denGreySidebar") ? "grey" : undefined;
  return remembered === "grey" ? "grey" : undefined;
}

type ShellStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): ShellStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRememberedDenShell(storage: ShellStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(DEN_SHELL_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberDenShell(orgContext: ShellOrgContext, storage: ShellStorage | null = browserStorage()): void {
  if (!orgContext || !storage) return;
  try {
    const appearance = denShellAppearance(orgContext);
    if (appearance) storage.setItem(DEN_SHELL_STORAGE_KEY, appearance);
    else storage.removeItem(DEN_SHELL_STORAGE_KEY);
  } catch {
  }
}

export function subscribeToRememberedDenShell(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: StorageEvent) => { if (event.key === DEN_SHELL_STORAGE_KEY) onChange(); };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
