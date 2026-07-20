import { openDesktopUrl } from "./desktop";
import { isDesktopRuntime } from "../utils";

export type BrowserHandoffResult =
  | { ok: true }
  | { ok: false; error: string };

export type BrowserHandoffOverrides = {
  desktopRuntime?: boolean;
  openDesktop?: (url: string) => Promise<void>;
  openWindow?: (url: string) => Window | null;
};

export const browserHandoffRequiredEvent = "openwork:browser-handoff-required";

export type BrowserHandoffRequiredDetail = {
  url: string;
  error: string;
};

type ClipboardOverrides = {
  writeClipboard?: (text: string) => Promise<void>;
  legacyCopy?: (text: string) => boolean;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/**
 * Best-effort browser launch. Callers must keep the URL visible while the
 * handoff is pending because even a successful OS response cannot prove that
 * a browser became visible to the user.
 */
export async function tryOpenBrowserUrl(
  url: string,
  overrides: BrowserHandoffOverrides = {},
): Promise<BrowserHandoffResult> {
  if (!url.trim()) {
    return { ok: false, error: "The browser link is unavailable." };
  }

  try {
    const desktopRuntime = overrides.desktopRuntime ?? isDesktopRuntime();
    if (desktopRuntime) {
      await (overrides.openDesktop ?? openDesktopUrl)(url);
      return { ok: true };
    }

    const openWindow = overrides.openWindow ?? ((target: string) => {
      if (typeof window === "undefined") return null;
      return window.open(target, "_blank", "noopener,noreferrer");
    });
    if (!openWindow(url)) {
      return { ok: false, error: "The browser blocked the new window." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "The browser could not be opened.") };
  }
}

export function showGlobalBrowserHandoffFallback(detail: BrowserHandoffRequiredDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<BrowserHandoffRequiredDetail>(
    browserHandoffRequiredEvent,
    { detail },
  ));
}

export async function openBrowserUrlWithGlobalFallback(
  url: string,
  overrides: BrowserHandoffOverrides = {},
  showFallback: (detail: BrowserHandoffRequiredDetail) => void = showGlobalBrowserHandoffFallback,
): Promise<BrowserHandoffResult> {
  const result = await tryOpenBrowserUrl(url, overrides);
  if (!result.ok) {
    showFallback({ url, error: result.error });
  }
  return result;
}

function legacyCopyText(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.focus();
  field.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/**
 * Tries both the modern Clipboard API and the older selection-based copy
 * command. The visible field in BrowserHandoffFallback remains the final,
 * dependency-free manual path if both are unavailable.
 */
export async function copyBrowserHandoffUrl(
  url: string,
  overrides: ClipboardOverrides = {},
): Promise<BrowserHandoffResult> {
  const writeClipboard = overrides.writeClipboard ?? (
    typeof navigator !== "undefined" && navigator.clipboard?.writeText
      ? (text: string) => navigator.clipboard.writeText(text)
      : undefined
  );

  if (writeClipboard) {
    try {
      await writeClipboard(url);
      return { ok: true };
    } catch {
      // Fall through to the legacy selection-based copy path.
    }
  }

  try {
    const copied = (overrides.legacyCopy ?? legacyCopyText)(url);
    return copied
      ? { ok: true }
      : { ok: false, error: "Automatic copy was blocked." };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Automatic copy was blocked.") };
  }
}
