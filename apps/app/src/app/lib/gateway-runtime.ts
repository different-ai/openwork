// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type MicxGatewayMarker = {
  version?: number;
  build?: string;
};

declare global {
  interface Window {
    __MICX_GATEWAY__?: MicxGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "micx.den.authToken";

export function isMicxGatewayRuntime() {
  return typeof window !== "undefined" && window.__MICX_GATEWAY__?.version === 1;
}

export function getMicxGatewayBuild(): string | null {
  if (!isMicxGatewayRuntime()) return null;
  const build = window.__MICX_GATEWAY__?.build?.trim() ?? "";
  return build || null;
}

export function getMicxGatewayOrigin() {
  if (!isMicxGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readMicxGatewayDenToken() {
  if (!isMicxGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
