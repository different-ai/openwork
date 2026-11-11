import { DEVICE_LOGIN_UNSUPPORTED, type DeviceLoginStartOptions, type createDesktopDeviceLogin } from "./device-login-flow";

/** Reject malformed provided IDs rather than silently turning an owned request into an unowned one. */
export function readDeviceLoginRequestId(args: unknown): { ok: true; requestId?: string } | { ok: false; error: string } {
  if (!args || typeof args !== "object" || !("requestId" in args) || args.requestId === undefined) return { ok: true };
  const requestId = args.requestId;
  if (typeof requestId !== "string" || !requestId.length || requestId.length > 128 || requestId.trim() !== requestId) {
    return { ok: false, error: "requestId must be a non-empty string of at most 128 characters without surrounding whitespace." };
  }
  return { ok: true, requestId };
}

/** Cached deployment observations can kill work, but admission always uses live discovery. */
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
    // A scoped failure includes ownership mismatch. Do not turn it into an
    // unscoped read/cancel of whichever newer flow happens to be running.
    if (requestId !== undefined && current.state === "failed") return current;
    // Before admission no code exists: let awaited live discovery report OFF
    // itself, rather than turning its unsupported result into cancellation.
    if (current.state === "pending" && input.flow.admittedAt() === null) return current;
    const feature = input.deploymentFeature();
    // An OFF cached before this start/live admission cannot overrule its newer
    // anonymous ON response. Unknown (including errors with stale data) cannot kill.
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
      // All destinations await the same anonymous discovery inside the flow.
      return input.flow.start(options);
    },
    status,
    cancel(requestId?: string) {
      input.flow.cancel(requestId);
      return status(requestId);
    },
  };
}
