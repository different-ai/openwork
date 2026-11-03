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
