/**
 * Which clients may start a device login (RFC 8628). Kept free of database
 * and environment imports so it can be tested on its own.
 */

/** The only client ids allowed to start a device login. */
export const DEN_DEVICE_CLIENT_IDS = ["openwork-cli", "openwork-opencode-plugin", "openwork-desktop-device"] as const

/** The separately gated remote desktop sign-in client. */
export const DEN_DESKTOP_DEVICE_CLIENT_ID = "openwork-desktop-device"

/** The OpenCode plugin's client, shown as "OpenWork - OpenCode Plugin". */
export const DEN_OPENCODE_PLUGIN_DEVICE_CLIENT_ID = "openwork-opencode-plugin"

export function isDenDeviceClientId(clientId: string): boolean {
  return DEN_DEVICE_CLIENT_IDS.some((allowed) => allowed === clientId)
}
