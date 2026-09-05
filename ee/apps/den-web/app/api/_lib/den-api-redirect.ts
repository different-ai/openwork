import { NextRequest, NextResponse } from "next/server";

import { denApiOriginForWebOrigin } from "../../(den)/_lib/den-api-origin";
import { readPublicWebOrigin } from "../../_lib/public-web-origin";

function requestOrigin(request: NextRequest): string {
  const configuredOrigin = readPublicWebOrigin();
  if (configuredOrigin) {
    return configuredOrigin;
  }

  return new URL(request.url).origin;
}

function forwardedPath(request: NextRequest, routePrefix: string): string {
  const incoming = new URL(request.url);
  const normalizedPrefix = routePrefix.endsWith("/") ? routePrefix.slice(0, -1) : routePrefix;

  if (incoming.pathname === normalizedPrefix) {
    return "/";
  }

  const prefixed = `${normalizedPrefix}/`;
  if (incoming.pathname.startsWith(prefixed)) {
    return `/${incoming.pathname.slice(prefixed.length)}`;
  }

  return incoming.pathname;
}

export function redirectToDenApi(request: NextRequest, routePrefix: string): NextResponse {
  const apiOrigin = denApiOriginForWebOrigin(requestOrigin(request));
  if (!apiOrigin) {
    return NextResponse.json({ error: "Could not resolve Den API origin." }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const redirectUrl = new URL(apiOrigin);
  redirectUrl.pathname = forwardedPath(request, routePrefix);
  redirectUrl.search = incoming.search;
  return NextResponse.redirect(redirectUrl, 307);
}
