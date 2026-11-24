import { DEVICE_LOGIN_UNSUPPORTED, type DeviceLoginStartOptions, type createDesktopDeviceLogin } from "./device-login-flow";

export function readDeviceLoginRequestId(args: unknown): { ok: true; requestId?: string } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || !("requestId" in args) || args.requestId === undefined) return { ok: true };
  const requestId = args.requestId;
  if (typeof requestId !== "string" || !requestId.length || requestId.length > 128 || requestId.trim() !== requestId) {
    return { ok: false, error: "requestId must be a non-empty string of at most 128 characters without surrounding whitespace." };
  }
  return { ok: true, requestId };
}

export function createDeviceLoginControl(input: {
  flow: ReturnType<typeof createDesktopDeviceLogin>;
  deploymentFeature(): { enabled: boolean | undefined; updatedAt: number };
  isConfiguredDestination(options: DeviceLoginStartOptions): boolean;
}) {
  let alternateDestination = false;
  let startingObservation = 0;
  const unsupported = () => ({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED } satisfies ReturnType<typeof input.flow.status>);
  function status(requestId?: string) {
    const current = input.flow.status(requestId);
    if (requestId !== undefined && current.state === "failed") return current;
    if (current.state === "pending" && input.flow.admittedAt() === null) return current;
    const feature = input.deploymentFeature();
    const observationFloor = Math.max(startingObservation, input.flow.admittedAt() ?? 0);
    if (!alternateDestination && feature.enabled === false && feature.updatedAt > observationFloor && current.state !== "signed_in") {
      if (current.state === "pending" || current.state === "approved") input.flow.cancel(requestId);
      return unsupported();
    }
    return current;
  }
  return {
    start(options: DeviceLoginStartOptions = {}) {
      alternateDestination = !input.isConfiguredDestination(options);
      startingObservation = input.deploymentFeature().updatedAt;
      return input.flow.start(options);
    },
    status,
    cancel(requestId?: string) {
      input.flow.cancel(requestId);
      return status(requestId);
    },
  };
}
