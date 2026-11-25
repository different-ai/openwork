import type { LookupAddress, LookupAllOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";

export class LocalManagedMcpPrivateUrlError extends Error {
  constructor(url: string, detail: string) {
    super(`URL "${url}" is not allowed: ${detail}`);
    this.name = "LocalManagedMcpPrivateUrlError";
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ? null : octets;
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes("%")) return null;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) return null;
    const octets = parseIpv4(normalized.slice(lastColon + 1));
    if (!octets) return null;
    normalized = `${normalized.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (value: string): number[] | null => {
    if (!value) return [];
    const parts = value.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const head = parseHalf(halves[0]);
  const tail = parseHalf(halves[1] ?? "");
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const omitted = 8 - head.length - tail.length;
  return omitted < 1 ? null : [...head, ...Array.from({ length: omitted }, () => 0), ...tail];
}

function embeddedIpv4(words: number[], offset: number): string {
  return [words[offset] >> 8, words[offset] & 0xff, words[offset + 1] >> 8, words[offset + 1] & 0xff].join(".");
}

function isPrivateIpv6(address: string): boolean {
  const words = parseIpv6Words(address);
  if (!words) return true;
  const [first, second, third] = words;
  const fifth = words[4];
  const sixth = words[5];
  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 0 || words[7] === 1)) return true;
  if (words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff) return isPrivateIpv4(embeddedIpv4(words, 6));
  if (words.slice(0, 4).every((word) => word === 0) && fifth === 0xffff && sixth === 0) return isPrivateIpv4(embeddedIpv4(words, 6));
  if (words.slice(0, 6).every((word) => word === 0)) return true;
  if (first === 0x0064 && second === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return isPrivateIpv4(embeddedIpv4(words, 6));
  }
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return true;
  if (first === 0x2001 && (second === 0x0db8 || (second === 0x0002 && third === 0))) return true;
  if (first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) return true;
  return first === 0x2002 && isPrivateIpv4(embeddedIpv4(words, 1));
}

export function isLocalManagedMcpPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LocalManagedMcpPrivateUrlError(rawUrl, "not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalManagedMcpPrivateUrlError(rawUrl, `protocol "${url.protocol}" is not allowed`);
  }
  if (url.username || url.password) {
    throw new LocalManagedMcpPrivateUrlError(rawUrl, "embedded URL credentials are not allowed");
  }
  return url;
}

function allowPrivateUrls(): boolean {
  return process.env.OPENWORK_DEV_MODE === "1" || process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS === "1";
}

type ResolveAddresses = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

const resolveAddresses: ResolveAddresses = (hostname, options) => lookup(hostname, options);

function validateResolvedAddresses(hostname: string, addresses: LookupAddress[]): void {
  if (addresses.length === 0) {
    throw new LocalManagedMcpPrivateUrlError(`https://${hostname}/`, "the hostname does not resolve");
  }
  if (allowPrivateUrls()) return;
  for (const { address } of addresses) {
    if (isLocalManagedMcpPrivateAddress(address)) {
      throw new LocalManagedMcpPrivateUrlError(
        `https://${hostname}/`,
        `the hostname resolves to a private or reserved address (${address})`,
      );
    }
  }
}

export function createLocalManagedMcpPublicLookup(
  resolver: ResolveAddresses = resolveAddresses,
): LookupFunction {
  return (hostname, options, callback) => {
    const lookupOptions: LookupAllOptions = { ...options, all: true, verbatim: true };
    void resolver(hostname, lookupOptions).then((addresses) => {
      try {
        validateResolvedAddresses(hostname, addresses);
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Managed MCP hostname lookup failed."), []);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0];
      callback(null, first.address, first.family);
    }, (error: unknown) => {
      callback(error instanceof Error ? error : new Error("Managed MCP hostname lookup failed."), []);
    });
  };
}

export async function assertLocalManagedMcpUrl(rawUrl: string): Promise<void> {
  const url = parseHttpUrl(rawUrl);
  if (allowPrivateUrls()) return;
  if (url.protocol !== "https:") {
    throw new LocalManagedMcpPrivateUrlError(rawUrl, "managed MCP egress requires HTTPS");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isLocalManagedMcpPrivateAddress(hostname)) {
      throw new LocalManagedMcpPrivateUrlError(rawUrl, "the address is private or reserved");
    }
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolveAddresses(hostname, { all: true, verbatim: true });
  } catch {
    throw new LocalManagedMcpPrivateUrlError(rawUrl, "the hostname does not resolve");
  }
  validateResolvedAddresses(hostname, addresses);
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const guardedDispatcher = new Agent({
  connect: {
    lookup: createLocalManagedMcpPublicLookup(),
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 1_000,
  },
});

function redirectedRequestInit(init: RequestInit | undefined, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init?.headers);
  if (from.protocol === "https:" && to.protocol !== "https:") {
    throw new LocalManagedMcpPrivateUrlError(to.toString(), "an HTTPS request cannot redirect to a less secure protocol");
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (from.origin !== to.origin) {
    if ((method !== "GET" && method !== "HEAD") || init?.body != null) {
      throw new LocalManagedMcpPrivateUrlError(to.toString(), "a request body cannot be redirected to another origin");
    }
    for (const name of ["authorization", "cookie", "proxy-authorization", "mcp-session-id", "last-event-id", "x-api-key", "x-auth-token"]) {
      headers.delete(name);
    }
  }
  const switchToGet = (status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST");
  if (switchToGet) {
    headers.delete("content-length");
    headers.delete("content-type");
    return { ...init, method: "GET", body: undefined, headers, redirect: "manual" };
  }
  return { ...init, headers, redirect: "manual" };
}

async function guardedTransportFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const requestInit = { ...init, dispatcher: guardedDispatcher } as unknown as UndiciRequestInit;
  return await undiciFetch(input, requestInit) as unknown as Response;
}

export function createLocalManagedMcpGuardedFetch(): FetchLike {
  return async (input, init) => {
    let current = new URL(String(input));
    let currentInit: RequestInit = { ...init, redirect: "manual" };
    for (let redirectCount = 0; ; redirectCount += 1) {
      const parsed = parseHttpUrl(current.toString());
      if (!allowPrivateUrls() && parsed.protocol !== "https:") {
        throw new LocalManagedMcpPrivateUrlError(current.toString(), "managed MCP egress requires HTTPS");
      }
      const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
      if (!allowPrivateUrls() && isIP(hostname) && isLocalManagedMcpPrivateAddress(hostname)) {
        throw new LocalManagedMcpPrivateUrlError(current.toString(), "the address is private or reserved");
      }
      const response = await guardedTransportFetch(current, currentInit);
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
      if (redirectCount >= 5) {
        await response.body?.cancel();
        throw new Error("Managed MCP outbound request exceeded the guarded redirect limit.");
      }
      const next = new URL(location, current);
      try {
        currentInit = redirectedRequestInit(currentInit, response.status, current, next);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      current = next;
      await response.body?.cancel();
    }
  };
}
