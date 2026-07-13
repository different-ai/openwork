import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { diagnosticsConfig, validateProductionConfig } from "./src/config"

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function credentials(request: NextRequest): { password: string; username: string } | null {
  const authorization = request.headers.get("authorization") ?? ""
  if (!authorization.startsWith("Basic ")) return null
  try {
    const decoded = atob(authorization.slice(6))
    const separator = decoded.indexOf(":")
    return separator < 0 ? null : { password: decoded.slice(separator + 1), username: decoded.slice(0, separator) }
  } catch {
    return null
  }
}

export function proxy(request: NextRequest): NextResponse {
  const missing = validateProductionConfig()
  if (missing.length > 0) {
    return NextResponse.json({ error: "diagnostics_not_configured", missing }, { status: 503 })
  }
  const supplied = credentials(request)
  const expected = diagnosticsConfig()
  if (!supplied || !constantTimeEqual(supplied.username, expected.adminUsername) || !constantTimeEqual(supplied.password, expected.adminPassword)) {
    return new NextResponse("Diagnostics administrator authentication is required.", {
      headers: { "cache-control": "no-store", "www-authenticate": 'Basic realm="OpenWork Diagnostics", charset="UTF-8"' },
      status: 401,
    })
  }
  return NextResponse.next()
}

export const config = { matcher: ["/", "/api/history/:path*"] }
