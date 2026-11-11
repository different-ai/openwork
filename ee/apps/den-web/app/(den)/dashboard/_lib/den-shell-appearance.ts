import { orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";

/*
 * The dashboard shell's colours. Today's are the default; with the
 * `denGreySidebar` feature on, the shell marks itself `data-den-shell="grey"`
 * and globals.css swaps the shell tokens (grey sidebar, white pages). Only
 * colours change, so the choice lives in one attribute rather than in classes.
 */
export type DenShellAppearance = "grey";

/** The last appearance this browser saw, so a reload paints it before the organization has loaded. */
export const DEN_SHELL_STORAGE_KEY = "openwork.den.shell";

type ShellOrgContext = Pick<DenOrgContext, "features"> | null | undefined;

/**
 * What the shell marks itself with. Once the organization is known its
 * feature decides, on or off. Until then the last value this browser saw
 * stands in, so an organization with the feature on does not flash the
 * default colours on every load.
 */
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

/** Keeps what a loaded organization uses. Nothing is written while the organization is still unknown. */
export function rememberDenShell(orgContext: ShellOrgContext, storage: ShellStorage | null = browserStorage()): void {
  if (!orgContext || !storage) return;
  try {
    const appearance = denShellAppearance(orgContext);
    if (appearance) storage.setItem(DEN_SHELL_STORAGE_KEY, appearance);
    else storage.removeItem(DEN_SHELL_STORAGE_KEY);
  } catch {
    // A browser that refuses storage only loses the head start on the next load.
  }
}

/** For useSyncExternalStore: another tab switching organization updates this one's head start too. */
export function subscribeToRememberedDenShell(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: StorageEvent) => { if (event.key === DEN_SHELL_STORAGE_KEY) onChange(); };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
