import type { Hono } from "hono"
import { describeRoute, validator, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayLocalKeyShareEligibility, GatewayLocalKeyShareInput, GatewayLocalKeyShareReceipt } from "@openwork/types/den/gateway"
import { orgMemberRoute, userSessionRoute } from "../../middleware/index.js"
import { denTypeIdSchema, jsonResponse, unauthorizedSchema, forbiddenSchema } from "../../openapi.js"
import { LocalKeyShareError, LOCAL_KEY_SHARE_UNSUPPORTED, localKeyShareEligibility, requireLocalKeyShareAdministrator, shareLocalProviderKey, type LocalKeySharePrincipal } from "../../llm/gateway-local-key-share.js"
import { GatewayWriteError } from "../../llm/gateway-matrix.js"
import type { OrgRouteVariables } from "./shared.js"

const eligibilitySchema: z.ZodType<GatewayLocalKeyShareEligibility> = z.object({
  organizationId: denTypeIdSchema("organization"), memberId: denTypeIdSchema("member"), organizationName: z.string().min(1),
  teams: z.array(z.object({ id: denTypeIdSchema("team"), name: z.string().min(1) })), eligible: z.boolean(), reason: z.string().nullable(),
})
const receiptSchema: z.ZodType<GatewayLocalKeyShareReceipt> = z.object({ requestId: z.string().uuid(), organizationId: denTypeIdSchema("organization"), providerId: z.string(), inferenceProviderId: denTypeIdSchema("inferenceProvider") })
export const localKeyShareInputSchema: z.ZodType<GatewayLocalKeyShareInput> = z.strictObject({
  requestId: z.string().uuid(), providerId: z.string().min(1).max(255), name: z.string().trim().min(1).max(255),
  credential: z.strictObject({ kind: z.literal("api_key"), secret: z.string().min(1).max(65535).refine((secret) => secret.trim().length > 0) }),
  allMembers: z.boolean(), teamIds: z.array(denTypeIdSchema("team")).max(100),
}).refine((input) => input.allMembers ? input.teamIds.length === 0 : input.teamIds.length > 0, "Choose everyone or selected teams.")
const errorSchema = z.object({ error: z.string(), message: z.string() })
const invalidMessage = `${LOCAL_KEY_SHARE_UNSUPPORTED} Provide a transfer UUID and choose everyone or selected teams.`
type ShareContext = { get: <K extends "organizationContext" | "user" | "session" | "apiKey">(key: K) => OrgRouteVariables[K] }
function principal(c: ShareContext): LocalKeySharePrincipal {
  const actor = c.get("organizationContext"), user = c.get("user"), session = c.get("session")
  if (!actor || !user || !session?.id || !session.token || c.get("apiKey")) throw new LocalKeyShareError(403, "share_identity_unverified", "Use a freshly verified signed-in user session for this operation.")
  return { organizationId: actor.organization.id, memberId: actor.currentMember.id, userId: normalizeDenTypeId("user", user.id),
    sessionId: normalizeDenTypeId("session", session.id), sessionToken: session.token }
}
function failure(c: { json: (body: unknown, status: 400 | 403 | 409 | 503) => Response }, error: unknown) {
  if (error instanceof LocalKeyShareError) return c.json({ error: error.code, message: error.message }, error.status)
  if (error instanceof GatewayWriteError) return c.json({ error: "share_not_committed", message: "The provider could not be created safely. Verify provider settings and the audience in Den. Your local key is unchanged." }, error.status === 404 ? 400 : error.status)
  return c.json({ error: "share_unverified", message: "Sharing could not be confirmed. Your local key is unchanged; retry uses the same transfer." }, 503)
}
function shareRoute(summary: string, description: string, response: z.ZodType) {
  const metadata: DescribeRouteOptions & { "x-mcp": false } = { "x-mcp": false, tags: ["Inference Providers"], summary, description,
    security: [{ bearerAuth: [] }], responses: { 200: jsonResponse(summary, response), 400: jsonResponse("Invalid sharing request.", errorSchema),
      401: jsonResponse("Sign in required.", unauthorizedSchema), 403: jsonResponse("Fresh session and current owner/admin membership required.", forbiddenSchema),
      409: jsonResponse("Transfer conflicts with an earlier request or provider configuration.", errorSchema), 503: jsonResponse("Sharing unavailable or outcome unconfirmed.", errorSchema) } }
  return describeRoute(metadata)
}

export function registerLocalKeyShareRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/inference-providers/share-local-key/eligibility", shareRoute("Check device API-key sharing eligibility",
    "Secret-free preflight for a genuine current user session and joined organization membership. Fresh owners/admins receive eligible=true and organization-scoped teams. Other current members, stale sessions, unsupported providers or disabled Gateway management receive the same direct object with eligible=false, an explicit reason and no teams. API keys are not user sessions.", eligibilitySchema),
  userSessionRoute(), orgMemberRoute(), validator("query", z.strictObject({ providerId: z.string().min(1).max(255) }), (result, c) => {
    if (!result.success) return c.json({ error: "invalid_share", message: LOCAL_KEY_SHARE_UNSUPPORTED }, 400)
  }), async (c) => {
    c.header("Cache-Control", "no-store")
    try { return c.json(await localKeyShareEligibility(principal(c), c.req.valid("query").providerId)) }
    catch (error) { return failure(c, error) }
  })

  app.post("/v1/inference-providers/share-local-key", shareRoute("Share a device API key with an organization",
    "Requires a genuine fresh owner/admin user session; authorization, membership and team scope are re-read from storage. Stores the encrypted API key, provider, default model group, chosen grants and durable receipt in one transaction. Organization/member/requestId retries with matching contents return the same receipt; different contents return 409. Only trusted catalog metadata is read; no upstream credential probe or inference call is made. The receipt acknowledges the committed transfer, not ongoing provider availability.", z.object({ share: receiptSchema })),
  userSessionRoute(), orgMemberRoute(), async (c, next) => {
    c.header("Cache-Control", "no-store")
    try { await requireLocalKeyShareAdministrator(principal(c)); await next() }
    catch (error) { return failure(c, error) }
  }, validator("json", localKeyShareInputSchema, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_share", message: invalidMessage }, 400)
  }), async (c) => {
    try { return c.json({ share: await shareLocalProviderKey(principal(c), c.req.valid("json")) }) }
    catch (error) { return failure(c, error) }
  })
}
