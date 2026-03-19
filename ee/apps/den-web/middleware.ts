import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const POSTHOG_PROXY_PATH = "/ow";
const POSTHOG_API_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();
  const { pathname } = url;

  if (!pathname.startsWith(POSTHOG_PROXY_PATH)) {
    return NextResponse.next();
  }

  const hostname = pathname.startsWith(`${POSTHOG_PROXY_PATH}/static/`)
    ? POSTHOG_ASSETS_HOST
    : POSTHOG_API_HOST;
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set("host", hostname);
  requestHeaders.delete("cookie");

  url.protocol = "https";
  url.hostname = hostname;
  url.port = "443";
  url.pathname = pathname.replace(/^\/ow/, "") || "/";

  return NextResponse.rewrite(url, {
    request: {
      headers: requestHeaders
    }
  });
}

export const config = {
  matcher: "/ow/:path*"
};
