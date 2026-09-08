import { NextResponse } from "next/server";

// Vercel Authentication protects the entire preview, including JSON and images.
// Standard Protection leaves production domains public, so do not serve there.
export function proxy() {
  if (process.env.VERCEL && process.env.VERCEL_ENV !== "preview")
    return new NextResponse("Open this app through its protected Vercel preview.", {
      status: 503,
      headers: { "cache-control": "private, no-store" },
    });
  const response = NextResponse.next();
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  response.headers.set("referrer-policy", "same-origin");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

export const config = { matcher: ["/:path*"] };
