export const OPENWORK_DEPLOYMENT_ENV_VAR = "NEXT_PUBLIC_OPENWORK_DEPLOYMENT";

export type OpenWorkDeployment = "desktop" | "web";

/**
 * Normalizes deployment values from environment variables.
 * Any unknown or empty value falls back to desktop.
 */
function normalizeDeployment(value: string | undefined): OpenWorkDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

/**
 * Returns the runtime deployment mode for the web app.
 *
 * Resolution order:
 * 1) NEXT_PUBLIC_OPENWORK_DEPLOYMENT (client + server)
 * 2) OPENWORK_DEPLOYMENT (server-only override)
 * 3) "desktop" default
 */
export function getOpenWorkDeployment(): OpenWorkDeployment {
  return normalizeDeployment(
    process.env.NEXT_PUBLIC_OPENWORK_DEPLOYMENT ?? process.env.OPENWORK_DEPLOYMENT
  );
}

/** True when deployment mode is explicitly set to "web". */
export function isWebDeployment(): boolean {
  return getOpenWorkDeployment() === "web";
}

/** True when deployment mode resolves to "desktop" (including fallback). */
export function isDesktopDeployment(): boolean {
  return getOpenWorkDeployment() === "desktop";
}
