import { DEVICE_LOGIN_UNSUPPORTED, type DeviceLoginStartOptions, type createDesktopDeviceLogin } from "./device-login-flow";

/** Local action gate; only an explicitly different destination may discover its own deployment switch. */
export function createDeviceLoginControl(input: {
  flow: ReturnType<typeof createDesktopDeviceLogin>;
  deploymentEnabled(): boolean;
  isConfiguredDestination(options: DeviceLoginStartOptions): boolean;
}) {
  let alternateDestination = false;
  const unsupported = () => ({ state: "unsupported", message: DEVICE_LOGIN_UNSUPPORTED } satisfies ReturnType<typeof input.flow.status>);
  function status() {
    const current = input.flow.status();
    if (!alternateDestination && !input.deploymentEnabled() && current.state !== "signed_in") {
      if (current.state === "pending" || current.state === "approved") input.flow.cancel();
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
    cancel() {
      input.flow.cancel();
      return status();
    },
  };
}
