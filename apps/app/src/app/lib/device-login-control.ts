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

/** Local action gate; only an explicitly different destination may discover its own deployment switch. */
export function createDeviceLoginControl(input: {
  flow: ReturnType<typeof createDesktopDeviceLogin>;
  deploymentEnabled(): boolean;
  isConfiguredDestination(options: DeviceLoginStartOptions): boolean;
}) {
  let alternateDestination = false;
  const unsupported = () => ({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED } satisfies ReturnType<typeof input.flow.status>);
  function status(requestId?: string) {
    const current = input.flow.status(requestId);
    // A scoped failure includes ownership mismatch. Do not turn it into an
    // unscoped read/cancel of whichever newer flow happens to be running.
    if (requestId !== undefined && current.state === "failed") return current;
    if (!alternateDestination && !input.deploymentEnabled() && current.state !== "signed_in") {
      if (current.state === "pending" || current.state === "approved") input.flow.cancel(requestId);
      return unsupported();
    }
    return current;
  }
  return {
    start(options: DeviceLoginStartOptions = {}) {
      const configured = input.isConfiguredDestination(options);
      if (configured && !input.deploymentEnabled()) {
        status();
        return Promise.resolve(unsupported());
      }
      // A cached flag for one server cannot admit or reject another server.
      // The flow performs anonymous discovery for an explicit alternate target;
      // no code/token request is made unless that target's deployment opts in.
      alternateDestination = !configured;
      return input.flow.start(options);
    },
    status,
    cancel(requestId?: string) {
      input.flow.cancel(requestId);
      return status(requestId);
    },
  };
}
