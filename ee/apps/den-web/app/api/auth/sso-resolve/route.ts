import { NextRequest } from "next/server";
import { proxyUpstream } from "../../_lib/upstream-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  return proxyUpstream(request, [], {
    routePrefix: "/api/auth/sso-resolve",
    upstreamPathPrefix: "v1/orgs/sso/resolve",
  });
}
