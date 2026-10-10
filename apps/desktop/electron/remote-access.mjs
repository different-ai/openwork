/** @typedef {import('../../../packages/remote-access/dist/index.js').BridgeRuntime} BridgeRuntime */
/** @typedef {Awaited<ReturnType<BridgeRuntime['controls']['state']>>} ControlState */
/** @typedef {{
 * featureEnabled: () => Promise<boolean>,
 * readEnabled: () => Promise<boolean>,
 * writeEnabled: (enabled: boolean) => Promise<void>,
 * readDevices: () => Promise<ControlState['devices']>,
 * network: {ensure(): Promise<{origin: string}>},
 * start: (origin: string) => Promise<BridgeRuntime>,
 * }} ManagerOptions */

const safeErrors = new Set([
  "TAILSCALE_NOT_INSTALLED",
  "TAILSCALE_SIGN_IN",
  "TAILSCALE_DNS_UNAVAILABLE",
  "TAILSCALE_SETUP_REQUIRED",
  "TAILSCALE_PORTS_OCCUPIED",
  "PUBLIC_ROUTE_CONFIGURED",
  "TAILSCALE_CONFIGURATION_CHANGED",
  "STORE_LOCKED",
  "UNSAFE_PERMISSIONS",
  "INVALID_STORE",
  "UPSTREAM_UNAVAILABLE",
  "ENGINE_V2_REQUIRED",
  "UPSTREAM_AUTH_FAILED",
  "EADDRINUSE",
  "FEATURE_DISABLED",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "PAIRING_EXPIRED",
  "PAIRING_INVALID",
  "REMOTE_ACCESS_OFF",
  "REMOTE_ACCESS_CLOSED",
]);
/** @param {unknown} error */
function errorCode(error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (typeof code === "string" && safeErrors.has(code)) return code;
  return error instanceof Error && safeErrors.has(error.message)
    ? error.message
    : "REMOTE_ACCESS_FAILED";
}

/** @param {import('electron').IpcMainInvokeEvent} event @param {import('electron').BrowserWindow | null} window */
export function assertRemoteAccessSender(event, window) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("UNTRUSTED_REMOTE_ACCESS_SENDER");
  }
}

/** Serializes lifecycle and local administration. The phone never reaches these methods.
 * @param {ManagerOptions} options
 */
export function createRemoteAccessManager(options) {
  /** @type {BridgeRuntime | undefined} */
  let runtime;
  let initialized = false,
    enabled = false,
    available = false,
    closed = false;
  let origin = null,
    failure = null;
  /** @type {ControlState['devices']} */
  let devices = [];
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} action */
  const serial = (action) => {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  };
  const initialize = async () => {
    if (closed) throw new Error("REMOTE_ACCESS_CLOSED");
    if (initialized) return;
    enabled = await options.readEnabled();
    devices = await options.readDevices();
    initialized = true;
  };
  const stop = async () => {
    if (runtime) {
      await runtime.stop();
      runtime = undefined;
    }
    origin = null;
  };
  const checkFeature = async () => {
    available = await options.featureEnabled().catch(() => false);
    if (!available) await stop();
    return available;
  };
  /** @returns {Promise<import('@openwork/types/desktop-ipc').RemoteAccessStatus>} */
  const snapshot = async () => {
    /** @type {ControlState | undefined} */
    const state = runtime ? await runtime.controls.state() : undefined;
    if (state) devices = state.devices;
    return {
      available,
      enabled,
      phase: !available
        ? "unavailable"
        : failure
          ? "error"
          : runtime
            ? "ready"
            : "off",
      errorCode: failure,
      origin,
      devices,
      workspaces: state?.workspaces ?? [],
      pending: state?.pending ?? [],
    };
  };
  /** @returns {Promise<import('@openwork/types/desktop-ipc').RemoteAccessStatus>} */
  const reconcile = async () => {
    failure = null;
    try {
      await initialize();
      await checkFeature();
      if (!available || !enabled) await stop();
      else if (!runtime) {
        const route = await options.network.ensure();
        runtime = await options.start(route.origin);
        origin = route.origin;
      }
      return await snapshot();
    } catch (error) {
      failure = errorCode(error);
      // Reading current workspaces can fail while the engine restarts. Keep the
      // running bridge, but return only our last sanitized device snapshot.
      return {
        available,
        enabled,
        phase: "error",
        errorCode: failure,
        origin,
        devices,
        workspaces: [],
        pending: [],
      };
    }
  };
  /** @template T @param {(controls: BridgeRuntime['controls']) => Promise<T>} action */
  const control = (action) =>
    serial(async () => {
      await initialize();
      if (!(await checkFeature())) throw new Error("FEATURE_DISABLED");
      if (!enabled || !runtime) throw new Error("REMOTE_ACCESS_OFF");
      try {
        return await action(runtime.controls);
      } catch (error) {
        throw new Error(errorCode(error));
      }
    });
  return {
    refresh: () => serial(reconcile),
    status: () => serial(reconcile),
    /** @param {boolean} value */
    setEnabled: (value) =>
      serial(async () => {
        if (typeof value !== "boolean") throw new Error("INVALID_REQUEST");
        await initialize();
        if (value && !(await checkFeature()))
          throw new Error("FEATURE_DISABLED");
        await options.writeEnabled(value);
        enabled = value;
        return reconcile();
      }),
    pair: () => control((controls) => controls.pair()),
    /** @param {string} id @param {unknown} scope */
    approve: (id, scope) => control((controls) => controls.approve(id, scope)),
    /** @param {string} id */
    deny: (id) => control((controls) => controls.deny(id)),
    /** @param {string} id @param {unknown} scope */
    access: (id, scope) => control((controls) => controls.access(id, scope)),
    /** @param {string} id */
    revoke: (id) => control((controls) => controls.revoke(id)),
    dispose: () =>
      serial(async () => {
        closed = true;
        await stop();
      }),
  };
}
