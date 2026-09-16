import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const POSTHOG_PROXY_PATH = "/ow";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname !== POSTHOG_PROXY_PATH && !pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
    return NextResponse.next();
  }

  const requestHeaders = new Headers(request.headers);

  requestHeaders.delete("cookie");
  requestHeaders.delete("authorization");
  requestHeaders.delete("referer");

  return NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });
}

export const config = {
  matcher: "/ow/:path*"
};
