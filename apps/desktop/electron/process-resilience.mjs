import net from "node:net";

const GUARDED_SOCKET_TYPE_OF_SERVICE = Symbol.for("openwork.socket-type-of-service-guard");

export function isHarmlessSocketTypeOfServiceError(error) {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  const syscall = Reflect.get(error, "syscall");
  const namesSocketOption = syscall === "setTypeOfService" || error.message.includes("setTypeOfService");
  return namesSocketOption && code === "EINVAL";
}

/**
 * Node 24.18's bundled Undici calls setTypeOfService(0) for ordinary HTTP/1.1
 * requests. macOS can reject that best-effort QoS operation with EINVAL while
 * a socket is being reused or torn down, and the synchronous throw escapes the
 * fetch promise boundary. Guard the socket operation itself so request code can
 * continue, while every other socket failure still follows Node's fatal path.
 * @param {{
 *   SocketClass?: { prototype?: object },
 *   warn?: (message: string, error: unknown) => void,
 * }} [options]
 */
export function installSocketTypeOfServiceGuard({
  SocketClass = net.Socket,
  warn = (message, error) => console.warn(message, error),
} = {}) {
  const prototype = SocketClass?.prototype;
  const original = prototype ? Reflect.get(prototype, "setTypeOfService") : undefined;
  if (typeof original !== "function") return false;
  if (Reflect.get(original, GUARDED_SOCKET_TYPE_OF_SERVICE) === true) return false;

  function guardedSetTypeOfService(...args) {
    try {
      return Reflect.apply(original, this, args);
    } catch (error) {
      if (!isHarmlessSocketTypeOfServiceError(error)) throw error;
      warn("[network] ignored unsupported socket traffic-class hint", error);
      return this;
    }
  }
  Reflect.set(guardedSetTypeOfService, GUARDED_SOCKET_TYPE_OF_SERVICE, true);
  Object.defineProperty(prototype, "setTypeOfService", {
    ...Object.getOwnPropertyDescriptor(prototype, "setTypeOfService"),
    value: guardedSetTypeOfService,
  });
  return true;
}

/**
 * @param {string} label
 * @param {() => unknown | Promise<unknown>} task
 * @param {(message: string, error: unknown) => void} [report]
 */
export function runDetachedTask(label, task, report = (message, error) => console.error(message, error)) {
  void Promise.resolve()
    .then(task)
    .catch((error) => report(`[desktop] ${label} failed`, error));
}

/**
 * @param {{
 *   reload: () => unknown | Promise<unknown>,
 *   report?: (message: string, details: object | unknown) => void,
 *   onRepeatedCrash?: (details: object) => void,
 *   now?: () => number,
 *   retryWindowMs?: number,
 * }} options
 */
export function createRendererCrashRecovery({
  reload,
  report = (message, details) => console.error(message, details),
  onRepeatedCrash = () => undefined,
  now = () => Date.now(),
  retryWindowMs = 30_000,
}) {
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  return (details = {}) => {
    const reason = Reflect.get(details, "reason");
    if (reason === "clean-exit") return false;
    const recoveryAt = now();
    report("[desktop] renderer process exited unexpectedly", details);
    if (recoveryAt - lastRecoveryAt < retryWindowMs) {
      onRepeatedCrash(details);
      return false;
    }
    lastRecoveryAt = recoveryAt;
    runDetachedTask("reload crashed renderer", reload, report);
    return true;
  };
}
