import { isIP } from "node:net";
import type { ServerConfig } from "./types.js";

/**
 * Whether the server answers a request addressed to this Host. Loopback
 * names, IP addresses and the bind host are always allowed; any other name
 * must be listed in `allowedHosts`. A page on another domain that resolves to
 * this machine (DNS rebinding) sends its own name, so it is turned away.
 */
export function isAllowedHost(request: Request, config: Pick<ServerConfig, "host" | "allowedHosts">): boolean {
  const allowed = config.allowedHosts;
  if (!allowed || allowed.includes("*")) return true;
  // Requests dispatched inside this process carry no Host header.
  const hostname = hostnameOf(request.headers.get("host") ?? new URL(request.url).host);
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0) return true;
  return [config.host, ...allowed].some((entry) => hostnameOf(entry) === hostname);
}

function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\s/\\?#@]/.test(trimmed)) return null;
  try {
    return new URL(`http://${trimmed}`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  } catch {
    return null;
  }
}
