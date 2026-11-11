import { create } from "zustand"

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
