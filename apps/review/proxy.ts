import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// One access boundary covers pages, original records, and every image.
// Vercel Deployment Protection can additionally restrict access to team members.
export function proxy(request: NextRequest) {
  const password = process.env.OPENWORK_REVIEW_PASSWORD;
  if (!password && process.env.NODE_ENV === "production")
    return new NextResponse("Review access is not configured.", {
      status: 503,
    });
  if (password) {
    const expected = Buffer.from(`Basic ${Buffer.from(`review:${password}`).toString("base64")}`);
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return new NextResponse("Sign in to review this evidence.", {
        status: 401,
        headers: {
          "www-authenticate": 'Basic realm="OpenWork Review", charset="UTF-8"',
          "cache-control": "private, no-store",
        },
      });
    }
  }
  const response = NextResponse.next();
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  response.headers.set("referrer-policy", "same-origin");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

export const config = { matcher: ["/:path*"] };
