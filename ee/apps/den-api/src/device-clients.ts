/**
 * Which clients may start a device login (RFC 8628). Kept free of database
 * and environment imports so it can be tested on its own.
 */

/** The only client ids allowed to start a device login. */
export const DEN_DEVICE_CLIENT_IDS = ["openwork-cli", "openwork-opencode-plugin"] as const

/**
 * The OpenCode plugin's client, shown as "OpenWork - OpenCode Plugin". It is
 * accepted only while the `opencodePlugin` feature is on for the deployment;
 * the plugin falls back to `openwork-cli` when Den rejects it.
 */
export const DEN_OPENCODE_PLUGIN_DEVICE_CLIENT_ID = "openwork-opencode-plugin"

export function isDenDeviceClientId(clientId: string): boolean {
  return DEN_DEVICE_CLIENT_IDS.some((allowed) => allowed === clientId)
}

/** Better Auth's `validateClient`: a known client id whose rollout, if it has one, is on. */
export async function isEnabledDenDeviceClientId(
  clientId: string,
  featureEnabled: (key: "opencodePlugin") => Promise<boolean>,
): Promise<boolean> {
  if (!isDenDeviceClientId(clientId)) return false
  if (clientId === DEN_OPENCODE_PLUGIN_DEVICE_CLIENT_ID) return featureEnabled("opencodePlugin")
  return true
}
