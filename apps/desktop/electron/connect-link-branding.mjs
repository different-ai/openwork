import { desktopBootstrapFromConnectClaims } from "./connect-link.mjs";

/**
 * @param {Partial<import("@openwork/types/desktop-ipc").DesktopBootstrapConfig>} config
 * @param {(iconUrl: string) => Promise<unknown>} applyBrandIconUrl
 */
export async function applyDesktopBootstrapBrandIcon(config, applyBrandIconUrl) {
  const iconUrl = typeof config.brandIconUrl === "string" ? config.brandIconUrl.trim() : "";
  if (!iconUrl) return null;
  return applyBrandIconUrl(iconUrl);
}

/**
 * @param {import("@openwork/types/connect-link").ConnectLinkClaims} claims
 * @param {{
 *   persistBootstrap: (
 *     config: Partial<import("@openwork/types/desktop-ipc").DesktopBootstrapConfig>
 *   ) => Promise<import("@openwork/types/desktop-ipc").DesktopBootstrapConfig>,
 *   applyBrandIconUrl: (iconUrl: string) => Promise<unknown>,
 * }} dependencies
 */
export async function persistConnectLinkBranding(claims, dependencies) {
  const config = await dependencies.persistBootstrap(desktopBootstrapFromConnectClaims(claims));
  await applyDesktopBootstrapBrandIcon(config, dependencies.applyBrandIconUrl);
  return config;
}
