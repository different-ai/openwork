// SSRF-aware URL normalisation for caller-supplied remote-server baseUrls.
// `/system/servers/connect` makes server-side requests to whatever URL the
// caller provides, so we must reject loopback, link-local, RFC 1918 private,
// and other non-routable hosts before the URL is ever fetched.

const BLOCKED_HOSTNAMES = new Set(
  [
    "localhost",
    "ip6-localhost",
    "ip6-loopback",
    "broadcasthost",
  ].map((h) => h.toLowerCase()),
);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class UnsafeBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBaseUrlError";
  }
}

export function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new UnsafeBaseUrlError("baseUrl is required.");
  }
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
    throw new UnsafeBaseUrlError(`baseUrl protocol must be http or https, got ${schemeMatch[1]}:`);
  }
  const withProtocol = schemeMatch ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new UnsafeBaseUrlError(`baseUrl is not a valid URL: ${trimmed}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeBaseUrlError(`baseUrl protocol must be http or https, got ${url.protocol}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new UnsafeBaseUrlError("baseUrl is missing a hostname.");
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeBaseUrlError(`baseUrl points at a blocked hostname: ${hostname}`);
  }
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new UnsafeBaseUrlError(`baseUrl points at a blocked hostname: ${hostname}`);
  }
  if (isBlockedLiteralAddress(hostname)) {
    throw new UnsafeBaseUrlError(`baseUrl points at a non-routable address: ${hostname}`);
  }
  return url.toString().replace(/\/+$/, "");
}

// Returns true when the hostname is an IPv4 or IPv6 literal that resolves into
// a private/loopback/link-local/reserved range. Hostnames that aren't IP
// literals fall through and must be DNS-resolved by the caller before fetch.
export function isBlockedLiteralAddress(hostname: string) {
  const stripped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const ipv4 = parseIPv4(stripped);
  if (ipv4) {
    return isBlockedIPv4(ipv4);
  }
  const ipv6 = parseIPv6(stripped);
  if (ipv6) {
    return isBlockedIPv6(ipv6);
  }
  return false;
}

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return [out[0], out[1], out[2], out[3]];
}

function isBlockedIPv4(octets: [number, number, number, number]) {
  const [a, b] = octets;
  // 0.0.0.0/8 — current network / unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC 1918
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. 169.254.169.254 metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC 1918
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved (incl. 255.255.255.255 broadcast)
  if (a >= 240) return true;
  return false;
}

function parseIPv6(value: string): number[] | null {
  if (!value.includes(":")) return null;
  // Strip scope ID (e.g. "fe80::1%eth0") so it doesn't fail the parser.
  let cleaned = value.split("%")[0];
  // Handle IPv4-in-IPv6 dotted-quad form (e.g. "::ffff:169.254.169.254").
  const lastColon = cleaned.lastIndexOf(":");
  if (lastColon !== -1 && cleaned.slice(lastColon + 1).includes(".")) {
    const ipv4 = parseIPv4(cleaned.slice(lastColon + 1));
    if (!ipv4) return null;
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    cleaned = `${cleaned.slice(0, lastColon)}:${hi}:${lo}`;
  }
  let parts: string[];
  if (cleaned.includes("::")) {
    const [head, tail] = cleaned.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const fillCount = 8 - headParts.length - tailParts.length;
    if (fillCount < 0) return null;
    parts = [...headParts, ...Array(fillCount).fill("0"), ...tailParts];
  } else {
    parts = cleaned.split(":");
  }
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    out.push(parseInt(part, 16));
  }
  return out;
}

function isBlockedIPv6(parts: number[]) {
  // ::  (unspecified)
  if (parts.every((p) => p === 0)) return true;
  // ::1 (loopback)
  if (parts.slice(0, 7).every((p) => p === 0) && parts[7] === 1) return true;
  // fc00::/7 — unique local
  if ((parts[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((parts[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast
  if ((parts[0] & 0xff00) === 0xff00) return true;
  // ::ffff:0:0/96 — IPv4-mapped; check the embedded IPv4.
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0xffff) {
    const a = (parts[6] >> 8) & 0xff;
    const b = parts[6] & 0xff;
    const c = (parts[7] >> 8) & 0xff;
    const d = parts[7] & 0xff;
    return isBlockedIPv4([a, b, c, d]);
  }
  return false;
}
