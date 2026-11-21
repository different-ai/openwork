import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { Context } from "hono"
import { db } from "../db.js"
import type { AuthContextVariables } from "../session.js"

export const OAUTH_CALLBACK_CONFIRMATION_PARAM = "confirm"

export const OAUTH_CALLBACK_OTHER_ACCOUNT_MESSAGE = "This connection was started from a different OpenWork account than the one signed in to this browser. Sign in to OpenWork as the account that started it, then try Connect again."

type OAuthCallbackStarter = {
  memberId: DenTypeId<"member">
  userId: DenTypeId<"user">
  email: string
  organizationName: string
}

export async function loadOAuthCallbackStarter(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<OAuthCallbackStarter | null> {
  const [row] = await db
    .select({ memberId: MemberTable.id, userId: MemberTable.userId, email: AuthUserTable.email, organizationName: OrganizationTable.name })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(
      eq(MemberTable.id, input.orgMembershipId),
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return row?.userId ? { ...row, userId: row.userId } : null
}

export function oauthCallbackSessionUserId(c: Context): string | null {
  const user: AuthContextVariables["user"] | undefined = c.get("user")
  return user?.id ?? null
}

function confirmationDigest(input: { state: string; code: string; secret: string }): Buffer {
  const codeDigest = createHash("sha256").update(input.code).digest("hex")
  return createHmac("sha256", input.secret).update(`oauth-callback-confirmation:v1\n${input.state}\n${codeDigest}`).digest()
}

export function createOAuthCallbackConfirmation(input: { state: string; code: string; secret: string }): string {
  return confirmationDigest(input).toString("base64url")
}

function confirmationMatches(input: { confirmation: string; state: string; code: string; secret: string }): boolean {
  const expected = new Uint8Array(confirmationDigest(input))
  const provided = new Uint8Array(Buffer.from(input.confirmation, "base64url"))
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

type OAuthCallbackStarterCheck = "continue" | "other_account" | "confirm"

export function checkOAuthCallbackStarter(input: {
  starterUserId: string
  sessionUserId: string | null | undefined
  state: string
  code: string | null
  confirmation: string | null
  secret: string
}): OAuthCallbackStarterCheck {
  if (input.sessionUserId) return input.sessionUserId === input.starterUserId ? "continue" : "other_account"
  if (!input.code) return "continue"
  if (input.confirmation && confirmationMatches({ confirmation: input.confirmation, state: input.state, code: input.code, secret: input.secret })) return "continue"
  return "confirm"
}

export function oauthCallbackConfirmationResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  })
}
