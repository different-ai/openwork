import { isIP } from "node:net";
import { CLIENT_IP_SIGNATURE_HEADER, SIGNED_CLIENT_IP_HEADER, signClientIp } from "@openwork-ee/utils/client-ip-signature";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The person's address as the hosting platform saw it, only on a platform that
 * overwrites what the caller sent. Vercel sets `x-vercel-forwarded-for` itself.
 */
export function platformClientIp(headers: Headers, environment: Environment = process.env): string | null {
  if (environment.VERCEL !== "1") return null;
  const value = (headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? "").split(",")[0]?.trim() ?? "";
  return isIP(value) ? value : null;
}

/**
 * Signs the person's address onto a request bound for Den API, which trusts it
 * only with the same DEN_WEB_CLIENT_IP_SECRET. A caller's own copy is always
 * dropped; without a secret or a known address nothing is added.
 */
export function applySignedClientIp(upstream: Headers, incoming: Headers, environment: Environment = process.env, now = Date.now()): void {
  upstream.delete(SIGNED_CLIENT_IP_HEADER);
  upstream.delete(CLIENT_IP_SIGNATURE_HEADER);
  const secret = environment.DEN_WEB_CLIENT_IP_SECRET?.trim();
  const ip = platformClientIp(incoming, environment);
  if (!secret || !ip) return;
  upstream.set(SIGNED_CLIENT_IP_HEADER, ip);
  upstream.set(CLIENT_IP_SIGNATURE_HEADER, signClientIp(secret, ip, now));
}
