import { hashConnectionIncidentIdentity } from "../../../../src/connection-incident-query"
import { readBoundedBody } from "../../../../src/recorded-route"

export const dynamic = "force-dynamic"

const maximumRequestBytes = 4 * 1_024

function identityValue(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized && normalized.length <= 128 ? normalized : null
}

function hashOrPreserve(kind: "organization" | "client", value: string | null): string | null {
  if (!value) return null
  return /^[a-f0-9]{64}$/iu.test(value)
    ? value.toLowerCase()
    : hashConnectionIncidentIdentity(kind, value)
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "cross_origin_request" }, { status: 403 })
  }
  const bounded = await readBoundedBody(request, maximumRequestBytes)
  if (bounded.tooLarge) {
    return Response.json({ error: "request_too_large" }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(bounded.body)
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 })
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "invalid_identity_lookup" }, { status: 400 })
  }
  const record = body as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => key !== "organization" && key !== "client")
  if (unexpected.length > 0) {
    return Response.json({ error: "invalid_identity_lookup" }, { status: 400 })
  }
  const organization = identityValue(record.organization)
  const client = identityValue(record.client)
  if ((record.organization !== undefined && !organization)
    || (record.client !== undefined && !client)) {
    return Response.json({ error: "invalid_identity_lookup" }, { status: 400 })
  }
  return Response.json({
    organizationHash: hashOrPreserve("organization", organization),
    clientHash: hashOrPreserve("client", client),
  }, { headers: { "cache-control": "private, no-store" } })
}
