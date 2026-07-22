import type { NextRequest } from "next/server";
import { proxyUpstream } from "../../api/_lib/upstream-proxy";
import { AUTH_DISCOVERY_PROXY_OPTIONS, type AuthDiscoveryAlias } from "./auth-discovery-proxy-options";

export function proxyAuthDiscoveryAlias(request: NextRequest, alias: AuthDiscoveryAlias): Promise<Response> {
  return proxyUpstream(request, [], AUTH_DISCOVERY_PROXY_OPTIONS[alias]);
}
