import { type NextRequest, NextResponse } from "next/server";

export function proxy(_request: NextRequest): NextResponse {
  return NextResponse.next();
}
