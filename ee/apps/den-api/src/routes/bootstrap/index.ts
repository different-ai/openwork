import { and, eq, gt, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import { ensureMemberGatewayKey } from "../../gateway-keys.js"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  AuthUserTable,
  RateLimitTable,
  WorkspaceBootstrapTable,
  WorkspaceClaimCodeTable,
  WorkspaceClaimTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, parseSkillMarkdown } from "@openwork-ee/utils"
import { createHash, randomBytes } from "node:crypto"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { ensureDefaultDesktopPolicyForOrganization } from "../../desktop-policies.js"
import { env } from "../../env.js"
import { jsonValidator, paramValidator, publicRoute, userSessionRoute } from "../../middleware/index.js"
import {
  JWT_BEARER_GRANT_TYPE,
  PRECLAIM_SCOPE,
  agentUserValues,
  issueClaimCode,
  lookupClaimCode,
  preclaimAssertionAudience,
  readClaimState,
  revokePreclaimCredentials,
  signPreclaimAssertion,
  verifyPreclaimAssertion,
} from "../../workspace-preclaim.js"
import { DEFAULT_ORGANIZATION_LIMITS } from "../../organization-limits.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { seedDefaultOrganizationRoles, setSessionActiveOrganization } from "../../orgs.js"
import { clampUtf8Bytes, PROJECTION_TEXT_MAX_BYTES } from "../org/plugin-system/projection-text.js"
import type { AuthContextVariables } from "../../session.js"
import {
  DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
  DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
  DEFAULT_OPENWORK_MARKETPLACE_NAME,
} from "../org/plugin-system/default-marketplaces.js"

const BOOTSTRAP_TTL_MS = 1000 * 60 * 60 * 24
const BOOTSTRAP_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const BOOTSTRAP_RATE_LIMIT_MAX = 5
const CLAIM_TOKEN_BYTES = 32
const STARTER_SKILL_OUTPUT = "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED"

const bootstrapWorkspaceSchema = z.object({
  workspaceName: z.string().trim().min(2).max(120),
  skillName: z.string().trim().min(1).max(120).default("First OpenWork Skill"),
  devicePublicKey: z.string().trim().min(16).max(4096).optional(),
  claimRoles: z.array(z.enum(["owner", "admin", "member"])).min(1).max(3).default(["owner"]),
  // Optional. Not persisted and not a security boundary - the claim token is
  // the only thing that authorizes a claim. This is purely passed through
  // into the owner claim link so the claim page can pre-fill (not lock) the
  // email field for a smoother human handoff.
  ownerEmail: z.string().trim().toLowerCase().email().max(255).optional(),
  // Optional teammate emails to invite as soon as the workspace is claimed.
  // Not actionable until a human claims ownership (a provisional workspace
  // has no authenticated member yet), so these ride along on the owner
  // claim link and are sent through the existing /v1/invitations endpoint
  // by the claim page right after a successful claim.
  teammateEmails: z.array(z.string().trim().toLowerCase().email().max(255)).max(10).optional(),
})

const acceptClaimSchema = z.object({
  token: z.string().trim().min(24).max(255),
})

const claimLinkSchema = z.object({
  id: denTypeIdSchema("workspaceClaim"),
  role: z.string(),
  token: z.string(),
  url: z.string(),
  expiresAt: z.string().datetime(),
})

const bootstrapWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  organization: z.object({
    id: denTypeIdSchema("organization"),
    name: z.string(),
    slug: z.string(),
    status: z.literal("provisional"),
  }),
  setup: z.object({
    id: denTypeIdSchema("workspaceBootstrap"),
    expiresAt: z.string().datetime(),
  }),
  skill: z.object({
    id: denTypeIdSchema("configObject"),
    title: z.string(),
    output: z.literal(STARTER_SKILL_OUTPUT),
  }),
  claimLinks: z.array(claimLinkSchema),
  identity: z.object({
    type: z.literal("anonymous"),
    assertion: z.string(),
    assertionType: z.literal("urn:ietf:params:oauth:grant-type:jwt-bearer"),
    tokenEndpoint: z.string(),
    scope: z.string(),
    expiresAt: z.string().datetime(),
    claimEndpoint: z.string(),
  }),
})

const acceptClaimResponseSchema = z.object({
  ok: z.literal(true),
  organization: z.object({
    id: denTypeIdSchema("organization"),
    name: z.string(),
    slug: z.string(),
    role: z.string(),
  }),
})

const bootstrapParamsSchema = z.object({
  bootstrapId: denTypeIdSchema("workspaceBootstrap"),
})

const userCodeParamsSchema = z.object({
  userCode: z.string().trim().min(4).max(32),
})

const acceptClaimCodeSchema = z.object({
  userCode: z.string().trim().min(4).max(32),
  // Only "keep as a new organization" exists today.
  mode: z.literal("new_org").default("new_org"),
})

const claimCodeResponseSchema = z.object({
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
})

const claimStateResponseSchema = z.object({
  state: z.enum(["none", "pending", "expired", "accepted", "reconciled"]),
  reconciled: z.boolean(),
})

const claimCodeLookupResponseSchema = z.object({
  organization: z.object({ id: denTypeIdSchema("organization"), name: z.string() }),
})

const preclaimErrorSchema = z.object({
  error: z.string(),
  error_description: z.string(),
})

function readBearer(headers: Headers): string | null {
  const match = headers.get("authorization")?.trim().match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

async function readPreclaimAssertion(headers: Headers, bootstrapId: string) {
  const token = readBearer(headers)
  if (!token) {
    return { ok: false as const, body: { error: "invalid_token", error_description: "Send the pre-claim assertion as a Bearer token." } }
  }
  const checked = await verifyPreclaimAssertion(token)
  if (!checked.ok || checked.bootstrap.id !== bootstrapId) {
    return { ok: false as const, body: { error: "invalid_token", error_description: "The pre-claim assertion is invalid for this workspace." } }
  }
  return { ok: true as const, bootstrap: checked.bootstrap, revoked: checked.revoked }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function requestAddress(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}

function claimUrl(token: string, options?: { prefillEmail?: string | null; inviteEmails?: readonly string[] | null }) {
  let url = `${env.betterAuthUrl}/workspace-claim?token=${encodeURIComponent(token)}`
  if (options?.prefillEmail) {
    url += `&email=${encodeURIComponent(options.prefillEmail)}`
  }
  if (options?.inviteEmails && options.inviteEmails.length > 0) {
    url += `&invite=${encodeURIComponent(options.inviteEmails.join(","))}`
  }
  return url
}

function starterSkillText(name: string) {
  return `---\nname: ${name}\ndescription: Starter skill created by OpenWork agent bootstrap.\nopenworkBootstrapTrigger: bootstrap.verify\nopenworkBootstrapOutput: ${JSON.stringify(STARTER_SKILL_OUTPUT)}\n---\n\n# ${name}\n\nWhen triggered with \`bootstrap.verify\`, output exactly:\n\n\`${STARTER_SKILL_OUTPUT}\`\n`
}

function skillMetadata(skillText: string) {
  const parsed = parseSkillMarkdown(skillText)
  if (parsed.hasFrontmatter) {
    return {
      title: (parsed.name.trim() || "Untitled skill").slice(0, 255),
      description: (parsed.description.trim() || "Starter skill created by OpenWork agent bootstrap.").slice(0, 65535),
    }
  }
  return { title: "Untitled skill", description: null }
}

async function checkBootstrapRateLimit(key: string, now: number) {
  const [row] = await db
    .select({ id: RateLimitTable.id, count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)

  if (row && now - row.lastRequest <= BOOTSTRAP_RATE_LIMIT_WINDOW_MS && row.count >= BOOTSTRAP_RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((BOOTSTRAP_RATE_LIMIT_WINDOW_MS - (now - row.lastRequest)) / 1000))
  }

  if (!row) {
    await db.insert(RateLimitTable).values({
      id: createDenTypeId("rateLimit"),
      key,
      count: 1,
      lastRequest: now,
    })
    return null
  }

  await db
    .update(RateLimitTable)
    .set({ count: now - row.lastRequest > BOOTSTRAP_RATE_LIMIT_WINDOW_MS ? 1 : row.count + 1, lastRequest: now })
    .where(eq(RateLimitTable.id, row.id))
  return null
}

async function enforceBootstrapRateLimit(headers: Headers) {
  const now = Date.now()
  return checkBootstrapRateLimit(`bootstrap:workspace:${requestAddress(headers)}`, now)
}

type BootstrapTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Make a signed-in person a member of a provisional workspace (owner for the
 * claim-code flow) and retire the setup member. Shared by claim links and
 * claim codes so both end in the same state.
 */
async function transferProvisionalWorkspace(tx: BootstrapTransaction, claim: {
  organizationId: typeof OrganizationTable.$inferSelect.id
  organization: typeof OrganizationTable.$inferSelect
  bootstrapId: typeof WorkspaceBootstrapTable.$inferSelect.id
  setupMemberId: typeof WorkspaceBootstrapTable.$inferSelect.setupMemberId
  role: string
  userId: ReturnType<typeof normalizeDenTypeId<"user">>
  now: Date
}): Promise<{ status: "membership_removed" } | { status: "ok"; memberId: ReturnType<typeof createDenTypeId<"member">> }> {
  const { now } = claim
  const normalizedUserId = claim.userId
  const [existingMember] = await tx
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, claim.organizationId), eq(MemberTable.userId, normalizedUserId), isNull(MemberTable.removedAt)))
    .limit(1)
    .for("update")
  const [removedMember] = existingMember
    ? []
    : await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, claim.organizationId), eq(MemberTable.userId, normalizedUserId), isNotNull(MemberTable.removedAt)))
      .limit(1)
      .for("update")

  if (removedMember) {
    return { status: "membership_removed" as const }
  }

  const memberId = existingMember?.id ?? createDenTypeId("member")
  if (existingMember) {
    await tx.update(MemberTable).set({ role: claim.role, joinedAt: now }).where(eq(MemberTable.id, existingMember.id))
  } else {
    await tx.insert(MemberTable).values({
      id: memberId,
      organizationId: claim.organizationId,
      userId: normalizedUserId,
      role: claim.role,
      joinedAt: now,
    })
  }

  await tx.update(MemberTable).set({ removedAt: now }).where(eq(MemberTable.id, claim.setupMemberId))
  await tx.update(WorkspaceBootstrapTable).set({ status: "claimed", claimedAt: now }).where(eq(WorkspaceBootstrapTable.id, claim.bootstrapId))
  const metadata = readOrganizationMetadata(claim.organization.metadata)
  await tx.update(OrganizationTable).set({
    metadata: {
      ...metadata,
      bootstrap: {
        ...readOrganizationMetadata(metadata.bootstrap),
        provisional: false,
        claimedAt: now.toISOString(),
        // Preserve existing claim attribution: this is the authenticated
        // account's internal ID stored at runtime, not a customer identity
        // embedded in public source or fixtures.
        claimedByUserId: normalizedUserId,
      },
    },
  }).where(eq(OrganizationTable.id, claim.organizationId))
  return { status: "ok", memberId }
}

export function registerBootstrapRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.post(
    "/v1/bootstrap/workspace",
    describeRoute({
      tags: ["Bootstrap"],
      security: [],
      summary: "Create a provisional workspace for agent-first setup",
      description: "Creates a provisional workspace, setup member, starter skill, and short-lived claim links without requiring an email account first.",
      responses: {
        200: jsonResponse("Workspace bootstrap completed.", bootstrapWorkspaceResponseSchema),
        400: jsonResponse("The bootstrap request body was invalid.", invalidRequestSchema),
      },
    }),
    publicRoute,
    jsonValidator(bootstrapWorkspaceSchema),
    async (c) => {
      const retryAfter = await enforceBootstrapRateLimit(c.req.raw.headers)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many bootstrap attempts. Try again later." }, 429)
      }

      const input = c.req.valid("json")
      const expiresAt = new Date(Date.now() + BOOTSTRAP_TTL_MS)
      const skillText = starterSkillText(input.skillName)
      const metadata = skillMetadata(skillText)
      const deviceKeyFingerprint = input.devicePublicKey ? sha256(input.devicePublicKey).slice(0, 64) : null

      const result = await db.transaction(async (tx) => {
        const organizationId = createDenTypeId("organization")
        const setupMemberId = createDenTypeId("member")
        const bootstrapId = createDenTypeId("workspaceBootstrap")
        const pluginId = createDenTypeId("plugin")
        const configObjectId = createDenTypeId("configObject")
        const marketplaceId = createDenTypeId("marketplace")

        await tx.insert(OrganizationTable).values({
          id: organizationId,
          name: input.workspaceName,
          slug: organizationId,
          metadata: {
            limits: DEFAULT_ORGANIZATION_LIMITS,
            bootstrap: { provisional: true, bootstrapId },
          },
        })

        // The setup member is a sign-in-less agent user so the pre-claim
        // assertion can authenticate as a real principal on the MCP gateway.
        const agentUser = agentUserValues(bootstrapId)
        const assertionJti = randomBytes(18).toString("base64url")
        await tx.insert(AuthUserTable).values(agentUser)

        await tx.insert(MemberTable).values({
          id: setupMemberId,
          organizationId,
          userId: agentUser.id,
          role: "owner",
        })

        await tx.insert(WorkspaceBootstrapTable).values({
          id: bootstrapId,
          organizationId,
          setupMemberId,
          devicePublicKey: input.devicePublicKey ?? null,
          deviceKeyFingerprint,
          status: "provisional",
          expiresAt,
          agentUserId: agentUser.id,
          assertionJti,
        })

        await tx.insert(PluginTable).values({
          id: pluginId,
          organizationId,
          createdByOrgMembershipId: setupMemberId,
          name: metadata.title,
          description: metadata.description,
          status: "active",
          deletedAt: null,
        })

        await tx.insert(PluginAccessGrantTable).values([
          {
            id: createDenTypeId("pluginAccessGrant"),
            organizationId,
            pluginId,
            orgMembershipId: setupMemberId,
            teamId: null,
            orgWide: false,
            role: "manager",
            createdByOrgMembershipId: setupMemberId,
          },
          {
            id: createDenTypeId("pluginAccessGrant"),
            organizationId,
            pluginId,
            orgMembershipId: null,
            teamId: null,
            orgWide: true,
            role: "viewer",
            createdByOrgMembershipId: setupMemberId,
          },
        ])

        await tx.insert(ConfigObjectTable).values({
          id: configObjectId,
          organizationId,
          objectType: "skill",
          sourceMode: "cloud",
          title: metadata.title,
          description: metadata.description,
          searchText: clampUtf8Bytes([metadata.title, metadata.description, skillText].filter(Boolean).join("\n"), PROJECTION_TEXT_MAX_BYTES),
          currentFileName: null,
          currentFileExtension: null,
          currentRelativePath: null,
          status: "active",
          createdByOrgMembershipId: setupMemberId,
          connectorInstanceId: null,
          deletedAt: null,
        })

        await tx.insert(ConfigObjectVersionTable).values({
          id: createDenTypeId("configObjectVersion"),
          organizationId,
          configObjectId,
          normalizedPayloadJson: null,
          rawSourceText: skillText,
          schemaVersion: null,
          createdVia: "cloud",
          createdByOrgMembershipId: setupMemberId,
          connectorSyncEventId: null,
          sourceRevisionRef: null,
          isDeletedVersion: false,
        })

        await tx.insert(ConfigObjectAccessGrantTable).values([
          {
            id: createDenTypeId("configObjectAccessGrant"),
            organizationId,
            configObjectId,
            orgMembershipId: setupMemberId,
            teamId: null,
            orgWide: false,
            role: "manager",
            createdByOrgMembershipId: setupMemberId,
          },
          {
            id: createDenTypeId("configObjectAccessGrant"),
            organizationId,
            configObjectId,
            orgMembershipId: null,
            teamId: null,
            orgWide: true,
            role: "viewer",
            createdByOrgMembershipId: setupMemberId,
          },
        ])

        await tx.insert(PluginConfigObjectTable).values({
          id: createDenTypeId("pluginConfigObject"),
          organizationId,
          pluginId,
          configObjectId,
          membershipSource: "manual",
          connectorMappingId: null,
          createdByOrgMembershipId: setupMemberId,
        })

        await tx.insert(MarketplaceTable).values({
          id: marketplaceId,
          organizationId,
          name: DEFAULT_OPENWORK_MARKETPLACE_NAME,
          description: DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION,
          logoUrl: DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL,
          status: "active",
          createdByOrgMembershipId: setupMemberId,
          deletedAt: null,
        })

        await tx.insert(MarketplaceAccessGrantTable).values({
          id: createDenTypeId("marketplaceAccessGrant"),
          organizationId,
          marketplaceId,
          orgMembershipId: null,
          teamId: null,
          orgWide: true,
          role: "viewer",
          createdByOrgMembershipId: setupMemberId,
        })

        await tx.insert(MarketplacePluginTable).values({
          id: createDenTypeId("marketplacePlugin"),
          organizationId,
          marketplaceId,
          pluginId,
          membershipSource: "manual",
          createdByOrgMembershipId: setupMemberId,
          removedAt: null,
        })

        const claimLinks = []
        for (const role of [...new Set(input.claimRoles)]) {
          const token = randomBytes(CLAIM_TOKEN_BYTES).toString("base64url")
          const id = createDenTypeId("workspaceClaim")
          await tx.insert(WorkspaceClaimTable).values({
            id,
            bootstrapId,
            organizationId,
            tokenHash: sha256(token),
            role,
            status: "pending",
            expiresAt,
          })
          claimLinks.push({
            id,
            role,
            token,
            url: claimUrl(token, role === "owner" ? { prefillEmail: input.ownerEmail, inviteEmails: input.teammateEmails } : undefined),
            expiresAt: expiresAt.toISOString(),
          })
        }

        return {
          organization: { id: organizationId, name: input.workspaceName, slug: organizationId, status: "provisional" as const },
          setup: { id: bootstrapId, expiresAt: expiresAt.toISOString() },
          setupMemberId,
          agentUserId: agentUser.id,
          assertionJti,
          skill: { id: configObjectId, title: metadata.title, output: STARTER_SKILL_OUTPUT },
          claimLinks,
        }
      })

      await ensureDefaultDesktopPolicyForOrganization({ organizationId: result.organization.id, createdByOrgMemberId: result.setupMemberId })
      await seedDefaultOrganizationRoles(result.organization.id)

      const assertion = await signPreclaimAssertion({
        bootstrapId: result.setup.id,
        organizationId: result.organization.id,
        agentUserId: result.agentUserId,
        jti: result.assertionJti,
        expiresAt,
      })
      const identity = {
        type: "anonymous" as const,
        assertion,
        assertionType: JWT_BEARER_GRANT_TYPE,
        tokenEndpoint: preclaimAssertionAudience(),
        scope: PRECLAIM_SCOPE,
        expiresAt: expiresAt.toISOString(),
        claimEndpoint: `${(env.apiPublicUrl ?? env.betterAuthUrl).replace(/\/$/, "")}/v1/bootstrap/workspace/${result.setup.id}/claim`,
      }
      const response = { organization: result.organization, setup: result.setup, skill: result.skill, claimLinks: result.claimLinks, identity }
      c.header("Cache-Control", "no-store")
      return c.json({ ok: true, ...response })
    },
  )

  app.post(
    "/v1/bootstrap/claims/accept",
    describeRoute({
      tags: ["Bootstrap"],
      security: [{ bearerAuth: [] }],
      summary: "Claim a provisional workspace",
      description: "Lets a signed-in human claim ownership or membership of a provisional agent-created workspace.",
      responses: {
        200: jsonResponse("Workspace claim accepted.", acceptClaimResponseSchema),
        400: jsonResponse("The claim request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to claim a workspace.", unauthorizedSchema),
        403: jsonResponse("The caller cannot accept this claim.", forbiddenSchema),
        404: jsonResponse("The claim token was missing, expired, or already used.", notFoundSchema),
      },
    }),
    userSessionRoute(),
    jsonValidator(acceptClaimSchema),
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      if (!user?.id) {
        return c.json({ error: "unauthorized" }, 401)
      }

      const input = c.req.valid("json")
      const now = new Date()
      const tokenHash = sha256(input.token)
      const normalizedUserId = normalizeDenTypeId("user", user.id)

      const result = await db.transaction(async (tx) => {
        const [claim] = await tx
          .select({
            id: WorkspaceClaimTable.id,
            organizationId: WorkspaceClaimTable.organizationId,
            bootstrapId: WorkspaceClaimTable.bootstrapId,
            role: WorkspaceClaimTable.role,
            setupMemberId: WorkspaceBootstrapTable.setupMemberId,
            organization: OrganizationTable,
          })
          .from(WorkspaceClaimTable)
          .innerJoin(WorkspaceBootstrapTable, eq(WorkspaceClaimTable.bootstrapId, WorkspaceBootstrapTable.id))
          .innerJoin(OrganizationTable, eq(WorkspaceClaimTable.organizationId, OrganizationTable.id))
          .where(
            and(
              eq(WorkspaceClaimTable.tokenHash, tokenHash),
              eq(WorkspaceClaimTable.status, "pending"),
              gt(WorkspaceClaimTable.expiresAt, now),
            ),
          )
          .limit(1)
          .for("update")

        if (!claim) {
          return null
        }

        const transferred = await transferProvisionalWorkspace(tx, {
          organizationId: claim.organizationId,
          organization: claim.organization,
          bootstrapId: claim.bootstrapId,
          setupMemberId: claim.setupMemberId,
          role: claim.role,
          userId: normalizedUserId,
          now,
        })
        if (transferred.status === "membership_removed") {
          return transferred
        }
        const memberId = transferred.memberId
        await tx.update(WorkspaceClaimTable).set({ status: "claimed", claimedByUserId: normalizedUserId, claimedAt: now }).where(eq(WorkspaceClaimTable.id, claim.id))

        return {
          status: "claimed" as const,
          bootstrapId: claim.bootstrapId,
          memberId,
          organization: {
            id: claim.organization.id,
            name: claim.organization.name,
            slug: claim.organization.slug,
            role: claim.role,
          },
        }
      })

      if (!result) {
        return c.json({ error: "claim_not_found", message: "This workspace claim link is missing, expired, or already used." }, 404)
      }
      if (result.status === "membership_removed") {
        return c.json({
          error: "membership_removed",
          message: "Your access to this workspace was removed. Ask a workspace admin for a new invite.",
        }, 403)
      }

      if (session?.id) {
        await setSessionActiveOrganization(normalizeDenTypeId("session", session.id), result.organization.id)
      }
      await ensureMemberGatewayKey({ organizationId: result.organization.id, memberId: result.memberId })
      // A claim link also ends the agent's pre-claim credentials.
      await revokePreclaimCredentials(result.bootstrapId)
      await db.update(WorkspaceClaimCodeTable).set({ state: "cancelled" }).where(and(eq(WorkspaceClaimCodeTable.bootstrapId, result.bootstrapId), eq(WorkspaceClaimCodeTable.state, "pending")))
      return c.json({ ok: true, organization: result.organization })
    },
  )

  app.post(
    "/v1/bootstrap/workspace/:bootstrapId/claim",
    describeRoute({
      tags: ["Bootstrap"],
      security: [{ bearerAuth: [] }],
      summary: "Create a claim code for a provisional workspace",
      description: "Authenticated with the workspace's pre-claim identity assertion as a Bearer token. Returns an RFC 8628-style user code and verification URL for a person to claim the workspace. Each call cancels the previous unused code.",
      responses: {
        200: jsonResponse("Claim code created.", claimCodeResponseSchema),
        401: jsonResponse("The pre-claim assertion is missing, invalid, or revoked.", preclaimErrorSchema),
      },
    }),
    publicRoute,
    paramValidator(bootstrapParamsSchema),
    async (c) => {
      const checked = await readPreclaimAssertion(c.req.raw.headers, c.req.valid("param").bootstrapId)
      if (!checked.ok) return c.json(checked.body, 401)
      if (checked.revoked) {
        return c.json({ error: "invalid_token", error_description: "This workspace was already claimed or expired." }, 401)
      }
      c.header("Cache-Control", "no-store")
      return c.json(await issueClaimCode(checked.bootstrap))
    },
  )

  app.get(
    "/v1/bootstrap/workspace/:bootstrapId/claim",
    describeRoute({
      tags: ["Bootstrap"],
      security: [{ bearerAuth: [] }],
      summary: "Read the claim state of a provisional workspace",
      description: "Authenticated with the workspace's pre-claim identity assertion. Works after the claim so the agent can observe `reconciled`; the assertion itself no longer exchanges for tokens by then.",
      responses: {
        200: jsonResponse("Current claim state.", claimStateResponseSchema),
        401: jsonResponse("The pre-claim assertion is missing or invalid.", preclaimErrorSchema),
      },
    }),
    publicRoute,
    paramValidator(bootstrapParamsSchema),
    async (c) => {
      const checked = await readPreclaimAssertion(c.req.raw.headers, c.req.valid("param").bootstrapId)
      if (!checked.ok) return c.json(checked.body, 401)
      c.header("Cache-Control", "no-store")
      return c.json(await readClaimState(checked.bootstrap))
    },
  )

  app.get(
    "/v1/bootstrap/claim-codes/:userCode",
    describeRoute({
      hide: true,
      tags: ["Bootstrap"],
      security: [{ bearerAuth: [] }],
      summary: "Look up a workspace claim code",
      description: "Returns the workspace a pending claim code belongs to, for the signed-in person on the claim page.",
      responses: {
        200: jsonResponse("The code is pending.", claimCodeLookupResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The code is unknown, used, or expired.", notFoundSchema),
      },
    }),
    userSessionRoute(),
    paramValidator(userCodeParamsSchema),
    async (c) => {
      const lookup = await lookupClaimCode(c.req.valid("param").userCode)
      if (!lookup.ok) {
        return c.json({ error: "invalid_user_code", message: "This code is invalid or has expired. Ask your agent for a new one." }, 404)
      }
      return c.json({ organization: { id: lookup.organizationId, name: lookup.organizationName } })
    },
  )

  app.post(
    "/v1/bootstrap/claim-codes/accept",
    describeRoute({
      hide: true,
      tags: ["Bootstrap"],
      security: [{ bearerAuth: [] }],
      summary: "Claim a provisional workspace with a code",
      description: "The signed-in person becomes the owner of the workspace and keeps it as a new organization. The agent's pre-claim credentials are revoked in the same step, which moves the claim from accepted to reconciled.",
      responses: {
        200: jsonResponse("The workspace was claimed.", acceptClaimResponseSchema),
        400: jsonResponse("The request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller's access to this workspace was removed.", forbiddenSchema),
        404: jsonResponse("The code is unknown, used, or expired.", notFoundSchema),
      },
    }),
    userSessionRoute(),
    jsonValidator(acceptClaimCodeSchema),
    async (c) => {
      const user = c.get("user")
      const session = c.get("session")
      if (!user?.id) {
        return c.json({ error: "unauthorized" }, 401)
      }
      const input = c.req.valid("json")
      const now = new Date()
      const normalizedUserId = normalizeDenTypeId("user", user.id)
      const lookup = await lookupClaimCode(input.userCode, now)
      if (!lookup.ok) {
        return c.json({ error: "invalid_user_code", message: "This code is invalid or has expired. Ask your agent for a new one." }, 404)
      }

      const result = await db.transaction(async (tx) => {
        const [code] = await tx
          .select({ id: WorkspaceClaimCodeTable.id, state: WorkspaceClaimCodeTable.state })
          .from(WorkspaceClaimCodeTable)
          .where(eq(WorkspaceClaimCodeTable.id, normalizeDenTypeId("workspaceClaimCode", lookup.codeId)))
          .limit(1)
          .for("update")
        const [organization] = await tx
          .select()
          .from(OrganizationTable)
          .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", lookup.organizationId)))
          .limit(1)
        if (!code || code.state !== "pending" || !organization) return null
        const transferred = await transferProvisionalWorkspace(tx, {
          organizationId: organization.id,
          organization,
          bootstrapId: normalizeDenTypeId("workspaceBootstrap", lookup.bootstrapId),
          setupMemberId: normalizeDenTypeId("member", lookup.setupMemberId),
          role: "owner",
          userId: normalizedUserId,
          now,
        })
        if (transferred.status === "membership_removed") return transferred
        await tx.update(WorkspaceClaimCodeTable)
          .set({ state: "accepted", claimedByUserId: normalizedUserId, acceptedAt: now })
          .where(eq(WorkspaceClaimCodeTable.id, code.id))
        // Unused claim links stop working once the workspace has an owner.
        await tx.update(WorkspaceClaimTable)
          .set({ status: "cancelled" })
          .where(and(eq(WorkspaceClaimTable.bootstrapId, normalizeDenTypeId("workspaceBootstrap", lookup.bootstrapId)), eq(WorkspaceClaimTable.status, "pending")))
        return {
          status: "claimed" as const,
          codeId: code.id,
          memberId: transferred.memberId,
          organization: { id: organization.id, name: organization.name, slug: organization.slug, role: "owner" },
        }
      })

      if (!result) {
        return c.json({ error: "invalid_user_code", message: "This code is invalid or has expired. Ask your agent for a new one." }, 404)
      }
      if (result.status === "membership_removed") {
        return c.json({ error: "membership_removed", message: "Your access to this workspace was removed. Ask a workspace admin for a new invite." }, 403)
      }

      // Reconcile: revoke the assertion and every pre-claim token, then mark it.
      await revokePreclaimCredentials(lookup.bootstrapId, now)
      await db.update(WorkspaceClaimCodeTable)
        .set({ state: "reconciled", reconciledAt: new Date() })
        .where(eq(WorkspaceClaimCodeTable.id, result.codeId))
      if (session?.id) {
        await setSessionActiveOrganization(normalizeDenTypeId("session", session.id), result.organization.id)
      }
      await ensureMemberGatewayKey({ organizationId: result.organization.id, memberId: result.memberId })
      return c.json({ ok: true, organization: result.organization })
    },
  )
}
