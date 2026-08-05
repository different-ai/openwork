import { desktopBootstrapFromConnectClaims } from "./connect-link.mjs";

/**
 * @param {Partial<import("@micx/types/desktop-ipc").DesktopBootstrapConfig>} config
 * @param {(iconUrl: string) => Promise<unknown>} applyBrandIconUrl
 */
export async function applyDesktopBootstrapBrandIcon(config, applyBrandIconUrl) {
  const iconUrl = typeof config.brandIconUrl === "string" ? config.brandIconUrl.trim() : "";
  if (!iconUrl) return null;
  return applyBrandIconUrl(iconUrl);
}

/**
 * @param {import("@micx/types/connect-link").ConnectLinkClaims} claims
 * @param {{
 *   persistBootstrap: (
 *     config: Partial<import("@micx/types/desktop-ipc").DesktopBootstrapConfig>
 *   ) => Promise<import("@micx/types/desktop-ipc").DesktopBootstrapConfig>,
 *   applyBrandIconUrl: (iconUrl: string) => Promise<unknown>,
 *   enterpriseActivation?: { activatedAt: string, denBaseUrl: string } | null,
 * }} dependencies
 */
export async function persistConnectLinkBranding(claims, dependencies) {
  const config = await dependencies.persistBootstrap({
    ...desktopBootstrapFromConnectClaims(claims),
    ...(dependencies.enterpriseActivation
      ? { enterpriseActivation: dependencies.enterpriseActivation }
      : {}),
  });
  await applyDesktopBootstrapBrandIcon(config, dependencies.applyBrandIconUrl);
  return config;
}
