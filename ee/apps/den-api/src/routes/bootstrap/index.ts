import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  OrganizationTable,
  RateLimitTable,
  SkillTable,
  WorkspaceBootstrapTable,
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
import { jsonValidator, publicRoute, authenticatedRoute } from "../../middleware/index.js"
import { DEFAULT_ORGANIZATION_LIMITS } from "../../organization-limits.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { seedDefaultOrganizationRoles, setSessionActiveOrganization } from "../../orgs.js"
import type { AuthContextVariables } from "../../session.js"

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
  expiresAt: z.string(),
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
    expiresAt: z.string(),
  }),
  skill: z.object({
    id: denTypeIdSchema("skill"),
    title: z.string(),
    output: z.literal(STARTER_SKILL_OUTPUT),
  }),
  claimLinks: z.array(claimLinkSchema),
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

export function registerBootstrapRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.post(
    "/v1/bootstrap/workspace",
    describeRoute({
      tags: ["Bootstrap"],
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
        const skillId = createDenTypeId("skill")

        await tx.insert(OrganizationTable).values({
          id: organizationId,
          name: input.workspaceName,
          slug: organizationId,
          metadata: {
            limits: DEFAULT_ORGANIZATION_LIMITS,
            bootstrap: { provisional: true, bootstrapId },
          },
        })

        await tx.insert(MemberTable).values({
          id: setupMemberId,
          organizationId,
          userId: null,
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
        })

        await tx.insert(SkillTable).values({
          id: skillId,
          organizationId,
          createdByOrgMembershipId: setupMemberId,
          title: metadata.title,
          description: metadata.description,
          skillText,
          shared: "org",
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
          skill: { id: skillId, title: metadata.title, output: STARTER_SKILL_OUTPUT },
          claimLinks,
        }
      })

      await ensureDefaultDesktopPolicyForOrganization({ organizationId: result.organization.id, createdByOrgMemberId: result.setupMemberId })
      await seedDefaultOrganizationRoles(result.organization.id)

      const response = { organization: result.organization, setup: result.setup, skill: result.skill, claimLinks: result.claimLinks }
      return c.json({ ok: true, ...response })
    },
  )

  app.post(
    "/v1/bootstrap/claims/accept",
    describeRoute({
      tags: ["Bootstrap"],
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
    authenticatedRoute(),
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

        if (!claim) {
          return null
        }

        const [existingMember] = await tx
          .select({ id: MemberTable.id })
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, claim.organizationId), eq(MemberTable.userId, normalizedUserId), isNull(MemberTable.removedAt)))
          .limit(1)

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
        await tx.update(WorkspaceClaimTable).set({ status: "claimed", claimedByUserId: normalizedUserId, claimedAt: now }).where(eq(WorkspaceClaimTable.id, claim.id))
        await tx.update(WorkspaceBootstrapTable).set({ status: "claimed", claimedAt: now }).where(eq(WorkspaceBootstrapTable.id, claim.bootstrapId))
        await tx.update(OrganizationTable).set({
          metadata: {
            ...(claim.organization.metadata ?? {}),
            bootstrap: { provisional: false, claimedAt: now.toISOString(), claimedByUserId: normalizedUserId },
          },
        }).where(eq(OrganizationTable.id, claim.organizationId))

        return {
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

      if (session?.id) {
        await setSessionActiveOrganization(normalizeDenTypeId("session", session.id), result.organization.id)
      }

      return c.json({ ok: true, ...result })
    },
  )
}
