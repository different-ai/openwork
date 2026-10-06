import type { Hono } from "hono"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { describeRoute } from "hono-openapi"
import { orgMemberRoute, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getValidAccessToken } from "../../capability-sources/generic-oauth.js"
import { getConnectedAccount, type ConnectedAccountRow } from "../../capability-sources/oauth-credentials.js"
import { getNativeOAuthProvider } from "../../capability-sources/provider-registry.js"
import { listNativeProviderUsableEntries, nativeProviderConnectionPolicyError, resolveDefaultNativeProviderCredentialId } from "../../capability-sources/native-provider-connections.js"
import { parseSlackAccountIdentity } from "../../capability-sources/slack-policy.js"
import { readSlackThread, searchSlack, SlackCapabilityError, slackConnectionRequired, slackErrorSchema, slackSearchInputSchema, slackSearchResultSchema, slackThreadInputSchema, slackThreadResultSchema } from "../../capability-sources/slack-api.js"
import { listTeamsForMember } from "../../orgs.js"
import { readInternalCapabilityConnectorId } from "../../session.js"
import type { OrgRouteVariables } from "./shared.js"

type Member = { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member"> }

function checkAccount(member: Member, account: ConnectedAccountRow | null) {
  const identity = parseSlackAccountIdentity(account?.externalAccountId ?? null)
  if (!account || account.organizationId !== member.organizationId || account.orgMembershipId !== member.orgMembershipId || account.providerId !== "slack" || !identity) throw slackConnectionRequired()
}

async function slackSession(member: Member, headers: Headers) {
  const policy = await nativeProviderConnectionPolicyError(member.organizationId, "slack")
  if (policy) throw new SlackCapabilityError(403, { error: policy.kind, message: policy.message })
  const provider = getNativeOAuthProvider("slack")
  if (!provider) throw slackConnectionRequired()
  const teams = await listTeamsForMember({ organizationId: member.organizationId, memberId: member.orgMembershipId })
  const teamIds = teams.map((team) => team.id)
  const selected = readInternalCapabilityConnectorId(headers)
  const credentialProviderId = selected
    ? (await listNativeProviderUsableEntries({ ...member, teamIds })).find((entry) => entry.id === selected && entry.nativeProviderKey === "slack")?.id
    : await resolveDefaultNativeProviderCredentialId({ ...member, teamIds, nativeProviderKey: "slack" })
  // ENG-76 supports only the per-member native alias, not MCP/BYO credentials or another connector's default.
  if (credentialProviderId !== "slack") throw slackConnectionRequired()
  checkAccount(member, await getConnectedAccount({ ...member, providerId: credentialProviderId }))
  const token = await getValidAccessToken({ ...member, provider, credentialProviderId })
  if ("error" in token) throw slackConnectionRequired()
  checkAccount(member, token.account)
  const rechecked = await nativeProviderConnectionPolicyError(member.organizationId, "slack")
  if (rechecked) throw new SlackCapabilityError(403, { error: rechecked.kind, message: rechecked.message })
  return { accessToken: token.accessToken, scopes: token.account.scopes }
}

const errorResponses = {
  400: jsonResponse("Invalid request.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Slack or Connect is disabled by policy.", slackErrorSchema),
  404: jsonResponse("Conversation or message unavailable to this member.", slackErrorSchema),
  409: jsonResponse("Connect Slack or grant the requested permissions.", slackErrorSchema),
  429: jsonResponse("Slack rate limit; no automatic retry.", slackErrorSchema),
  502: jsonResponse("Slack could not complete the lookup.", slackErrorSchema),
  504: jsonResponse("Bounded Slack lookup timed out.", slackErrorSchema),
}

export function registerSlackRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/capabilities/slack/threads",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Read a Slack thread excerpt with source links as the calling member",
      description: "Read one bounded page of a Slack thread using channelId and ts from search. Slack enforces this member's access and the conversation's history permission. Always report this as an excerpt, include source links, and surface hasMore, nextCursor, historyLimited, and truncation. No background paging or history import.",
      responses: { 200: jsonResponse("Bounded Slack thread excerpt.", slackThreadResultSchema), ...errorResponses },
    }),
    orgMemberRoute(),
    queryValidator(slackThreadInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const member = c.get("organizationContext")
      if (!member) return c.json({ error: "unauthorized" }, 401)
      try {
        const session = await slackSession({ organizationId: member.organization.id, orgMembershipId: member.currentMember.id }, c.req.raw.headers)
        return c.json(await readSlackThread(session, c.req.valid("query")))
      } catch (error) {
        if (error instanceof SlackCapabilityError) {
          if (error.body.retryAfterSeconds) c.header("Retry-After", String(error.body.retryAfterSeconds))
          return c.json(error.body, error.status)
        }
        return c.json({ error: "needs_connection", message: "Slack authorization could not be verified. Check your Slack connection and try again." }, 409)
      }
    },
  )
  app.get(
    "/v1/capabilities/slack/search",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Search Slack messages with source links as the calling member",
      description: "Read-only live Slack RTS lookup using only this member's connected Slack account. One bounded page, no file search, legacy fallback, or complete-thread claim. Omitted conversationTypes searches only granted categories; explicit ungranted categories return missing_permission. Surface scope omissions, truncation, and source links in the answer.",
      responses: { 200: jsonResponse("Bounded Slack search excerpts.", slackSearchResultSchema), ...errorResponses },
    }),
    orgMemberRoute(),
    queryValidator(slackSearchInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const member = c.get("organizationContext")
      if (!member) return c.json({ error: "unauthorized" }, 401)
      try {
        const session = await slackSession({ organizationId: member.organization.id, orgMembershipId: member.currentMember.id }, c.req.raw.headers)
        return c.json(await searchSlack(session, c.req.valid("query")))
      } catch (error) {
        if (error instanceof SlackCapabilityError) {
          if (error.body.retryAfterSeconds) c.header("Retry-After", String(error.body.retryAfterSeconds))
          return c.json(error.body, error.status)
        }
        // Never pass provider bodies, token-refresh errors, or credentials into request logs.
        return c.json({ error: "needs_connection", message: "Slack authorization could not be verified. Check your Slack connection and try again." }, 409)
      }
    },
  )
}
