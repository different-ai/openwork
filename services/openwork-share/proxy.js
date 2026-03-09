import { NextResponse } from "next/server";

function wantsJsonResponse(request) {
  const format = String(request.nextUrl.searchParams.get("format") ?? "").trim().toLowerCase();
  if (format === "json") return true;
  if (format === "html") return false;

  const accept = String(request.headers.get("accept") ?? "").toLowerCase();
  if (!accept) return true;
  if (accept.includes("application/json")) return true;
  if (accept.includes("text/html") || accept.includes("application/xhtml+xml")) return false;
  return true;
}

export function proxy(request) {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/b/") || pathname.endsWith("/data")) {
    return NextResponse.next();
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "b") {
    return NextResponse.next();
  }

  if (!wantsJsonResponse(request)) {
    return NextResponse.next();
  }

  const rewriteUrl = request.nextUrl.clone();
  rewriteUrl.pathname = `/b/${segments[1]}/data`;
  return NextResponse.rewrite(rewriteUrl);
}

export const config = {
  matcher: ["/b/:path*"]
};
