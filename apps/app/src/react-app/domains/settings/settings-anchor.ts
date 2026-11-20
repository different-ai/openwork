import { createContext, use, useCallback } from "react";

const FOUND_OUTLINE_MS = 1600;

const ANCHOR_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSettingAnchor(value: string | undefined): value is string {
  return value !== undefined && ANCHOR_PATTERN.test(value);
}

export type RequestedSetting = { anchor: string; navigationKey: string };

export const RequestedSettingContext = createContext<RequestedSetting | null>(null);

export function useRevealWhenRequested(anchor: string | undefined) {
  const requested = use(RequestedSettingContext);
  const requestedNavigation = anchor !== undefined && requested?.anchor === anchor ? requested.navigationKey : null;
  return useCallback((row: HTMLElement | null) => {
    if (!row || requestedNavigation === null) return;
    let outlineTimer = 0;
    const frame = requestAnimationFrame(() => {
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
      row.setAttribute("data-setting-found", "");
      outlineTimer = window.setTimeout(() => row.removeAttribute("data-setting-found"), FOUND_OUTLINE_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(outlineTimer);
      row.removeAttribute("data-setting-found");
    };
  }, [requestedNavigation]);
}
