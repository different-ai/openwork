import { isIP } from "node:net";
import { CLIENT_IP_SIGNATURE_HEADER, SIGNED_CLIENT_IP_HEADER, signClientIp } from "@openwork-ee/utils/client-ip-signature";

type Environment = Readonly<Record<string, string | undefined>>;

export function platformClientIp(headers: Headers, environment: Environment = process.env): string | null {
  if (environment.VERCEL !== "1") return null;
  const value = (headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? "").split(",")[0]?.trim() ?? "";
  return isIP(value) ? value : null;
}

export function applySignedClientIp(upstream: Headers, incoming: Headers, environment: Environment = process.env, now = Date.now()): void {
  upstream.delete(SIGNED_CLIENT_IP_HEADER);
  upstream.delete(CLIENT_IP_SIGNATURE_HEADER);
  const secret = environment.DEN_WEB_CLIENT_IP_SECRET?.trim();
  const ip = platformClientIp(incoming, environment);
  if (!secret || !ip) return;
  upstream.set(SIGNED_CLIENT_IP_HEADER, ip);
  upstream.set(CLIENT_IP_SIGNATURE_HEADER, signClientIp(secret, ip, now));
}
