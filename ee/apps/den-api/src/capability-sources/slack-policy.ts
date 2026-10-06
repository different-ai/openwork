import { env } from "../env.js"
import { getDeploymentFeatureState, organizationFeatureEnabled } from "../features.js"

const workspaceIdPattern = /^T[A-Z0-9]{1,63}$/
const userIdPattern = /^[UW][A-Z0-9]{1,63}$/

export type SlackAccountIdentity = { workspaceId: string; userId: string }

type SlackPolicyError = { kind: "policy_blocked"; message: string }

/** Per-organization rollout, independent of each member's Slack consent. */
export async function slackCloudPolicyError(organizationId: string): Promise<SlackPolicyError | null> {
  if (env.orgMode === "multi_org" && await organizationFeatureEnabled(organizationId, "nativeSlack")) return null
  return {
    kind: "policy_blocked",
    message: "Slack search is unavailable for this organization. An OpenWork platform administrator controls availability in Admin.",
  }
}

/**
 * Static App Home is app/workspace plumbing, not an organization read grant.
 * A deployment-wide default of off must not break organizations opted in via
 * Admin. Only deployment exclusion, a kill switch, or a forced-off operator lock
 * stops this generic help surface. Member operations always check their org.
 */
export async function slackHomePolicyError(): Promise<SlackPolicyError | null> {
  const state = await getDeploymentFeatureState("nativeSlack")
  if (env.orgMode === "multi_org" && (state.enabled || state.overrideApplies)) return null
  return { kind: "policy_blocked", message: "The OpenWork Slack app is unavailable on this deployment." }
}

export function encodeSlackAccountIdentity(identity: SlackAccountIdentity): string {
  if (!workspaceIdPattern.test(identity.workspaceId) || !userIdPattern.test(identity.userId)) {
    throw new Error("Slack returned an invalid account identity.")
  }
  return `slack:${identity.workspaceId}:${identity.userId}`
}

export function parseSlackAccountIdentity(value: string | null): SlackAccountIdentity | null {
  if (typeof value !== "string") return null
  const parts = value.split(":")
  if (parts.length !== 3 || parts[0] !== "slack") return null
  const workspaceId = parts[1]
  const userId = parts[2]
  if (!workspaceId || !userId || !workspaceIdPattern.test(workspaceId) || !userIdPattern.test(userId)) return null
  return { workspaceId, userId }
}
