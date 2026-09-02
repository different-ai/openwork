import { NextRequest } from "next/server";
import { proxyUpstream } from "../../_lib/upstream-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return proxyUpstream(request, [], {
    routePrefix: "/api/auth/desktop-handoff",
    upstreamPathPrefix: "v1/auth/desktop-handoff",
  });
}
