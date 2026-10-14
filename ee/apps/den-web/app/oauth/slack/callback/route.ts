import { NextRequest } from "next/server";
import { proxyUpstream, SLACK_OAUTH_CALLBACK_ROUTE_PREFIX } from "../../../api/_lib/upstream-proxy";

export const dynamic = "force-dynamic";

function secureCallbackResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-frame-options", "DENY");
  // Add framing protection without weakening any upstream CSP directives.
  response.headers.append("content-security-policy", "frame-ancestors 'none'");
  for (const name of Array.from(response.headers.keys())) {
    if (name.startsWith("access-control-")) response.headers.delete(name);
  }
  return response;
}

export async function GET(request: NextRequest) {
  return secureCallbackResponse(await proxyUpstream(request, [], {
    routePrefix: SLACK_OAUTH_CALLBACK_ROUTE_PREFIX,
  }));
}

function methodNotAllowed() {
  return secureCallbackResponse(new Response(null, {
    status: 405,
    headers: { allow: "GET" },
  }));
}

// Override Next's automatic HEAD/OPTIONS handling: only a GET may complete OAuth.
export {
  methodNotAllowed as HEAD,
  methodNotAllowed as OPTIONS,
  methodNotAllowed as POST,
  methodNotAllowed as PUT,
  methodNotAllowed as PATCH,
  methodNotAllowed as DELETE,
};
