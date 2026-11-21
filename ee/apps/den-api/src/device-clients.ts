export const DEN_DEVICE_CLIENT_IDS = ["openwork-cli", "openwork-opencode-plugin", "openwork-desktop-device"] as const

export const DEN_DESKTOP_DEVICE_CLIENT_ID = "openwork-desktop-device"

export const DEN_OPENCODE_PLUGIN_DEVICE_CLIENT_ID = "openwork-opencode-plugin"

export function isDenDeviceClientId(clientId: string): boolean {
  return DEN_DEVICE_CLIENT_IDS.some((allowed) => allowed === clientId)
}
