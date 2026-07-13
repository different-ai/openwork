import type { NextRequest } from "next/server";
import { proxyAuthDiscoveryAlias } from "../../../_lib/auth-discovery-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return proxyAuthDiscoveryAlias(request, "oauthAuthorizationServer");
}
