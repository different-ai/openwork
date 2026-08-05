export const MICX_DEPLOYMENT_ENV_VAR = "VITE_MICX_DEPLOYMENT";

export type MicxDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): MicxDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getMicxDeployment(): MicxDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_MICX_DEPLOYMENT === "string"
      ? import.meta.env.VITE_MICX_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getMicxDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getMicxDeployment() === "desktop";
}
