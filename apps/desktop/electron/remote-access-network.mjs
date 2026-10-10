import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";

const execute = promisify(execFile);
const target = "http://127.0.0.1:9288";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value */
function record(value) {
  return isRecord(value) ? value : {};
}
/** @param {unknown} value */
function targetsBridge(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === target &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Plan only: never rewrites an existing service, nor accepts an origin from the renderer.
 * @param {unknown} rawStatus
 * @param {unknown} rawServe
 */
export function planRemoteRoute(rawStatus, rawServe) {
  const status = record(rawStatus),
    self = record(status.Self),
    serve = record(rawServe);
  if (status.BackendState !== "Running" || self.Online === false)
    throw new Error("TAILSCALE_SIGN_IN");
  const dns =
    typeof self.DNSName === "string"
      ? self.DNSName.replace(/\.$/, "").toLowerCase()
      : "";
  if (
    dns.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+\.ts\.net$/.test(dns)
  ) {
    throw new Error("TAILSCALE_DNS_UNAVAILABLE");
  }
  const web = record(serve.Web),
    tcp = record(serve.TCP),
    funnel = record(serve.AllowFunnel);
  for (const [hostPort, enabled] of Object.entries(funnel)) {
    const port = hostPort.slice(hostPort.lastIndexOf(":") + 1);
    const forward = record(tcp[port]).TCPForward;
    if (
      enabled === true &&
      typeof forward === "string" &&
      targetsBridge(`http://${forward}`)
    ) {
      throw new Error("PUBLIC_ROUTE_CONFIGURED");
    }
  }
  for (const [hostPort, rawConfig] of Object.entries(web)) {
    const handlers = record(record(rawConfig).Handlers);
    if (
      Object.values(handlers).some((handler) =>
        targetsBridge(record(handler).Proxy),
      ) &&
      funnel[hostPort] === true
    ) {
      throw new Error("PUBLIC_ROUTE_CONFIGURED");
    }
  }
  for (const [hostPort, rawConfig] of Object.entries(web)) {
    if (!hostPort.startsWith(`${dns}:`)) continue;
    const port = Number(hostPort.slice(dns.length + 1));
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      record(tcp[String(port)]).HTTPS !== true
    )
      continue;
    if (targetsBridge(record(record(record(rawConfig).Handlers)["/"]).Proxy)) {
      return {
        origin: `https://${dns}${port === 443 ? "" : `:${port}`}`,
        port,
        create: false,
      };
    }
  }
  for (let port = 9443; port <= 9453; port++) {
    if (
      Object.hasOwn(tcp, String(port)) ||
      Object.keys(web).some((key) => key.endsWith(`:${port}`)) ||
      Object.keys(funnel).some((key) => key.endsWith(`:${port}`))
    )
      continue;
    return { origin: `https://${dns}:${port}`, port, create: true };
  }
  throw new Error("TAILSCALE_PORTS_OCCUPIED");
}

/** @param {string[]} args @returns {Promise<unknown>} */
async function runTailscale(args) {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
        ]
      : process.platform === "linux"
        ? ["/usr/bin/tailscale", "/usr/local/bin/tailscale"]
        : [];
  let executable;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      executable = candidate;
      break;
    } catch {
      /* Next known installation. */
    }
  }
  if (!executable) throw new Error("TAILSCALE_NOT_INSTALLED");
  try {
    const { stdout } = await execute(executable, args, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return args.includes("--json") ? JSON.parse(stdout) : null;
  } catch {
    // CLI errors may contain sign-in URLs or host details. Do not forward them to the renderer or logs.
    throw new Error("TAILSCALE_SETUP_REQUIRED");
  }
}

/** @param {{run?: (args: string[]) => Promise<unknown>}} [options] */
export function createRemoteNetwork({ run = runTailscale } = {}) {
  return {
    async ensure() {
      const status = await run(["status", "--json", "--peers=false"]);
      let before = await run(["serve", "status", "--json"]);
      let route = planRemoteRoute(status, before);
      if (!route.create) return route;
      // Re-read immediately before adding a route. Never pass --yes: an unexpected
      // replacement prompt must fail instead of accepting a concurrent overwrite.
      before = await run(["serve", "status", "--json"]);
      route = planRemoteRoute(status, before);
      if (!route.create) return route;
      await run(["serve", "--bg", `--https=${route.port}`, target]);
      const after = await run(["serve", "status", "--json"]);
      for (const group of ["TCP", "Web", "AllowFunnel"]) {
        for (const [key, value] of Object.entries(
          record(record(before)[group]),
        )) {
          if (!isDeepStrictEqual(value, record(record(after)[group])[key]))
            throw new Error("TAILSCALE_CONFIGURATION_CHANGED");
        }
      }
      const verified = planRemoteRoute(status, after);
      if (verified.create || verified.origin !== route.origin)
        throw new Error("TAILSCALE_SETUP_REQUIRED");
      return verified;
    },
  };
}
