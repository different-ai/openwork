import { NextRequest, NextResponse } from "next/server";
import { buildAuthSessionCookieClearHeaders } from "../_lib/session-cookie-clear";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  for (const cookie of buildAuthSessionCookieClearHeaders(request.url)) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
