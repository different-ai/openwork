/**
 * Ties a connector's OAuth callback to the person who started it.
 *
 * The callback is public and routed by signed state alone, because the
 * provider may redirect into a browser that never signed in to OpenWork (the
 * desktop app opens the system browser). The state proves who started the
 * connection, not who approved it at the provider. So before the code is
 * exchanged: a browser signed in as the starter continues, a browser signed in
 * as someone else is refused, and a browser with no OpenWork session is shown
 * which account the connection belongs to and must confirm.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { Context } from "hono"
import { db } from "../db.js"
import type { AuthContextVariables } from "../session.js"

/** Query parameter the confirmation page adds when the person continues. */
export const OAUTH_CALLBACK_CONFIRMATION_PARAM = "confirm"

export const OAUTH_CALLBACK_OTHER_ACCOUNT_MESSAGE = "This connection was started from a different OpenWork account than the one signed in to this browser. Sign in to OpenWork as the account that started it, then try Connect again."

type OAuthCallbackStarter = {
  memberId: DenTypeId<"member">
  userId: DenTypeId<"user">
  email: string
  organizationName: string
}

/** The active member the signed state names, with the names the confirmation page shows. */
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

/** The OpenWork user signed in to the browser that received the provider's reply, if any. */
export function oauthCallbackSessionUserId(c: Context): string | null {
  const user: AuthContextVariables["user"] | undefined = c.get("user")
  return user?.id ?? null
}

function confirmationDigest(input: { state: string; code: string; secret: string }): Buffer {
  // Bound to this state and this authorization code: it cannot be made before
  // Den has shown the page for exactly this reply, and it lives only as long
  // as the state does.
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

/**
 * What to do with a provider reply before anything is exchanged or stored.
 * A reply without a code grants nothing, so only another signed-in account stops it.
 */
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

/** The confirmation page is the only callback page with a control: never framed, cached or leaked by referrer. */
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
