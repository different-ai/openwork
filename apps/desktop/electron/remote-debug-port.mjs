import net from "node:net";

const DEVELOPMENT_PORTS = [9223, 9224, 9225, 9226, 9227];

export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * The Chrome DevTools Protocol port for this launch, or 0 to leave it closed.
 * Whatever connects can drive the signed-in app and read its storage, so a
 * packaged app opens it only when the launch asks for a port. A development
 * run picks a free one unless told which.
 */
export async function resolveRemoteDebugPort({ packaged, requested, isFree = portIsFree }) {
  const port = Number.parseInt(requested?.trim() ?? "", 10);
  if (Number.isFinite(port) && port > 0) return port;
  if (packaged) return 0;
  for (const candidate of DEVELOPMENT_PORTS) {
    if (await isFree(candidate)) return candidate;
  }
  return 0;
}

/** The port to restart with debugging on: the first free development port. */
export async function pickRemoteDebugPort(isFree = portIsFree) {
  for (const candidate of DEVELOPMENT_PORTS) {
    if (await isFree(candidate)) return candidate;
  }
  return DEVELOPMENT_PORTS[0];
}

/**
 * The launch arguments for restarting with debugging on `port`, or off when it
 * is 0. The port travels as Chromium's own switch, which the next launch reads
 * as its request.
 */
export function remoteDebugRelaunchArgs(args, port) {
  const kept = args.filter((arg) => !/^--remote-debugging-(port|address)(=|$)/.test(arg));
  return port > 0 ? [...kept, `--remote-debugging-port=${port}`] : kept;
}

/**
 * Help menu entries that let a person turn debugging on for a packaged app
 * without a terminal, for a support session. A development run always has a
 * port, so it gets none. `restart(true)` restarts with debugging, `restart(false)` without.
 */
export function remoteDebugMenuItems({ packaged, port, restart }) {
  if (!packaged) return [];
  if (port > 0) {
    return [
      { type: "separator" },
      { label: `Debugging Is On (Port ${port})`, enabled: false },
      { label: "Restart without Debugging", click: () => restart(false) },
    ];
  }
  return [
    { type: "separator" },
    { label: "Restart with Debugging...", click: () => restart(true) },
  ];
}
