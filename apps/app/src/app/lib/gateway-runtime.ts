export type OpenworkGatewayMarker = {
  version?: number;
  build?: string;
  denBaseUrl?: string;
};

declare global {
  interface Window {
    __OPENWORK_GATEWAY__?: OpenworkGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "openwork.den.authToken";

export function isOpenworkGatewayRuntime() {
  return typeof window !== "undefined" && window.__OPENWORK_GATEWAY__?.version === 1;
}

export function getOpenworkGatewayOrigin() {
  if (!isOpenworkGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readOpenworkGatewayDenBaseUrl() {
  if (!isOpenworkGatewayRuntime()) return null;
  const value = window.__OPENWORK_GATEWAY__?.denBaseUrl;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readOpenworkGatewayDenToken() {
  if (!isOpenworkGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
