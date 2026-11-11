import { create } from "zustand"
import type { RemoteDevice } from "@openwork/types/den/remote-devices"

import { isElectronRuntime } from "@/app/lib/runtime-env"
import { desktopRunnerId, organizationRunnerId } from "@/react-app/domains/automations/automation-runner-identity"

type ThisDeviceStore = {
  /** Per organization: the id its devices list gives this desktop, once it has reported itself. */
  deviceIds: Record<string, string>
  setDeviceId: (organizationId: string, deviceId: string) => void
}

export const useThisDeviceStore = create<ThisDeviceStore>((set) => ({
  deviceIds: {},
  setDeviceId: (organizationId, deviceId) => set((state) =>
    state.deviceIds[organizationId] === deviceId ? state : { deviceIds: { ...state.deviceIds, [organizationId]: deviceId } }),
}))

/** Which listed device is the computer this window runs on; null in the web app and before the first report. */
export const useThisDeviceId = (organizationId: string | null) =>
  useThisDeviceStore((state) => organizationId ? state.deviceIds[organizationId] ?? null : null)

/**
 * Whether a listed device is the computer this window runs on. Until this
 * desktop's first report is answered, the id its runner registers with names it.
 */
export function isThisComputer(device: Pick<RemoteDevice, "id" | "computerId">, organizationId: string | null, thisDeviceId: string | null): boolean {
  if (thisDeviceId !== null) return device.id === thisDeviceId
  if (device.computerId === null || !isElectronRuntime()) return false
  const installId = desktopRunnerId()
  return device.computerId === installId
    || (organizationId !== null && device.computerId === organizationRunnerId(installId, organizationId))
}
