import { eq } from "@openwork-ee/den-db/drizzle"
import { SsoProviderTable } from "@openwork-ee/den-db/schema"
import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import { db } from "./db.js"
import { validateSamlResponsePolicy } from "./sso-saml-response-policy.js"

const samlProviderConfigSchema = z.object({
  audience: z.string().min(1),
  callbackUrl: z.string().url(),
})

export const samlResponsePolicyMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") {
    await next()
    return
  }

  const providerId = providerIdFromPath(new URL(c.req.url).pathname)
  if (!providerId) {
    await next()
    return
  }

  const samlResponse = await readSamlResponse(c.req.raw)
  if (!samlResponse) {
    await next()
    return
  }

  const rows = await db
    .select({ samlConfig: SsoProviderTable.samlConfig })
    .from(SsoProviderTable)
    .where(eq(SsoProviderTable.providerId, providerId))
    .limit(1)
  const provider = rows[0]
  if (!provider?.samlConfig) {
    await next()
    return
  }

  const config = parseProviderConfig(provider.samlConfig)
  if (!config) {
    return c.json({ error: "invalid_saml_configuration" }, 400)
  }

  const result = validateSamlResponsePolicy({
    samlResponse,
    expectedAudience: config.audience,
    expectedRecipient: config.callbackUrl,
    expectedDestination: config.callbackUrl,
  })
  if (!result.ok) {
    return c.json({ error: result.code, message: result.message }, 400)
  }

  await next()
}

function parseProviderConfig(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    const result = samlProviderConfigSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function providerIdFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).at(-1)
  if (!segment) {
    return null
  }

  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

async function readSamlResponse(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("application/json")) {
    const body: unknown = await request.clone().json().catch(() => null)
    if (!isRecord(body)) {
      return null
    }
    const value = body.SAMLResponse
    return typeof value === "string" && value.length > 0 ? value : null
  }

  const formData = await request.clone().formData().catch(() => null)
  const value = formData?.get("SAMLResponse")
  return typeof value === "string" && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
