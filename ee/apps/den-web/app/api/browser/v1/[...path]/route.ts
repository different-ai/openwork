import { NextRequest } from "next/server";
import { proxyUpstream } from "../../../_lib/upstream-proxy";

export const dynamic = "force-dynamic";
// Existing browser workflow/tool calls can wait up to 170 seconds.
export const maxDuration = 180;

async function proxy(request: NextRequest) {
  const response = await proxyUpstream(request, [], {
    routePrefix: "/api/browser/v1",
    upstreamPathPrefix: "v1",
    upstreamDeadlineMs: 175_000,
  });
  response.headers.set("cache-control", "private, no-store");
  response.headers.delete("access-control-allow-origin");
  response.headers.delete("access-control-allow-credentials");
  return response;
}

export { proxy as GET, proxy as HEAD, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as OPTIONS };
