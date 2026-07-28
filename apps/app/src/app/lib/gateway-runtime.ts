// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type OpenworkGatewayMarker = {
  version?: number;
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

export function readOpenworkGatewayDenToken() {
  if (!isOpenworkGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
