import * as crypto from "node:crypto";
import { recordFreeAutoSignIn } from "@openwork-ee/den-db";
import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy";
import { invalidateTeamInferenceOAuth, revokeMemberGatewayCredentials } from "./llm/inference-provider-lifecycle.js";
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js";
import { removeMemberWorkbotComputersInBackground } from "./workbot/member-computers.js";
import {
  finishScimProvisionedMember,
  organizationAllowsProvisioning,
  provisionSsoMembership,
  provisionVerifiedDomainMembership,
  SCIM_ENTERPRISE_REQUIRED_MESSAGE,
  scimRequestOrganizationId,
  SSO_INVITATION_REQUIRED_MESSAGE,
} from "./identity-provisioning.js";
import { syncOrganizationBillingQuantities } from "./stripe-billing.js";
import { getInitialActiveOrganizationIdForUser } from "./active-organization.js";
import { db } from "./db.js";
import { resolveOrganizationMemberAuthority } from "./organization-team-roles.js";
import { env } from "./env.js";
import { appLogger } from "./observability/logger.js";
import {
  deleteMcpOAuthGrantFamilyForSession,
  getMcpSessionLiveness,
} from "./mcp/session-liveness.js";
import { contributeMcpGrantClaim } from "./mcp/grant-claims.js";
import {
  assertLiveMcpRefreshGrant,
  McpRefreshGrantRevokedError,
  type McpRefreshGrantRow,
} from "./mcp/refresh-grant-liveness.js";
import { deriveDenMcpAgentResource, deriveDenMcpResource, mcpEndpointResource } from "./mcp/resource.js";
import { getDenAuthIssuer, getDenJwtOptions } from "./mcp/jwt-policy.js";
import {
  addRequestedMcpClientScopes,
  DEN_MCP_DEFAULT_CLIENT_SCOPES,
  DEN_MCP_SCOPES,
} from "./mcp/scopes.js";
import {
  DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  DEN_MCP_OAUTH_AUTHORIZATION_EXPIRES_IN_SECONDS,
  DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
} from "./mcp/token-lifetime.js";
import {
  DEN_SESSION_EXPIRES_IN_SECONDS,
  DEN_SESSION_UPDATE_AGE_IN_SECONDS,
} from "./session-lifetime.js";
import { userSessionExpiresAt } from "./session-security-lifetime.js";
import { DEN_ACCOUNT_CONFIG, denUserConfig } from "./account-linking-policy.js";
import { cache } from "./cache.js";
import {
  lastSignInCookieChange,
  lastSignInCookieWrites,
  ORGANIZATION_SAML_ALLOW_IDP_INITIATED,
  ORGANIZATION_SAML_DEPRECATED_ALGORITHM_BEHAVIOR,
  ORGANIZATION_SAML_REQUIRE_TIMESTAMPS,
  SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX,
} from "@openwork-ee/den-sso";
import { hashSessionTokens } from "./session-token.js";
import { DEN_DESKTOP_DEVICE_CLIENT_ID } from "./device-clients.js";
import { beginDesktopDeviceClaim, desktopDeviceAccessDenied, desktopDeviceLoginEnabled, guardDesktopDeviceSessions, requireDesktopDeviceClaim } from "./desktop-device-login.js";
import { auditBetterAuthAfter, auditBetterAuthBefore, auditBetterAuthRefusal, auditBetterAuthSessionAfter, auditBetterAuthSessionBefore, BETTER_AUTH_AUDIT_AFTER_PATHS, BETTER_AUTH_AUDIT_BEFORE_PATHS, BETTER_AUTH_SESSION_AFTER_PATHS, BETTER_AUTH_SESSION_BEFORE_PATHS, noteOAuthConsentReference, noteOAuthRevocation, noteOAuthTokenIssuance, type BetterAuthHookSession } from "./audit/better-auth.js";
import { auditUserUpdateAfter, auditUserUpdateBefore, recordAccountDeleted, recordIdentityLinked, recordIdentityUnlinked } from "./audit/domain/account.js";
import { auditSessionMethod, auditSessionRevokeReason, recordSessionCreated, recordSessionRevoked } from "./audit/domain/sessions.js";
import { SCIM_TOKEN_STORAGE_STRATEGY } from "./scim-token-storage.js";
import { SCIM_EMAIL_CHANGE_REFUSAL, scimEmailChangeAllowed } from "./scim-email-change.js";
import { createScimExistingUserLinkCheck } from "./scim-existing-user-linking.js";
import { isUserKnownToScimOrganization, releaseStaleScimAccountForCreate } from "./scim-reprovisioning.js";
import { fetchCimdMetadataResource, isCimdClientIdUrlAllowed } from "./mcp/cimd-policy.js";
import { withLoopbackRedirectRelaxation } from "./mcp/cimd-loopback-redirects.js";
import { syncDenSignupContact } from "./loops.js";
import { sendEmail } from "./utils/email/send-email.js";
import { organizationInviteEmailProps } from "./invitation-email.js";
import {
  DEN_API_KEY_DEFAULT_PREFIX,
  DEN_API_KEY_EXPIRES_IN_DAYS,
  DEN_API_KEY_EXPIRES_IN_SECONDS,
  DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
} from "./api-key-constants.js";
import { revokeOrganizationApiKeysForMember } from "./api-keys.js";
import { revokeMembershipSessionCredentials } from "./credential-revocation.js";
import {
  denOrganizationAccess,
  denOrganizationStaticRoles,
  validateInvitationRoleAssignment,
} from "./organization-access.js";
import { resolvePermissionsForMember } from "./permissions/resolve.js";
import { roleAssignmentDenial } from "./permissions/team-grants.js";
import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  normalizeOrganizationRoleName,
  organizationRoleValueIncludes,
  splitOrganizationRoles,
} from "./organization-role-hierarchy.js";
import { isScimDeprovisionedEmailForSsoProvider, isScimDeprovisionedIdentity, SCIM_DEPROVISIONED_SIGN_IN_MESSAGE } from "./scim-deprovisioning.js";
import {
  authorizeOrganizationSsoSignIn,
  completeOrganizationSsoTestIntent,
  failOrganizationSsoTestAuthentication,
  getSsoTestIntentIdFromCallbackUrl,
} from "./sso-test-lifecycle.js";
import {
  reconcilePendingInvitationsForUser,
  validateOrganizationMemberRemovalForHook,
  validateOrganizationMemberRoleUpdate,
} from "./orgs.js";
import {
  deleteSessionSsoAuthentication,
  findNonSsoSignInBlock,
  carrySessionSsoProofs,
  findSsoAccessBlock,
  recordDeviceSessionSsoAuthentication,
  recordSessionSsoAuthentication,
  SSO_REQUIRED_MESSAGE,
} from "./organization-sso-access.js";
import { normalizeLoginEmail } from "./auth-login-options.js";
import { getAuthBodyEmail, getSingleOrgEmailSignupPolicyViolation } from "./single-org-signup-policy.js";
import { authorizeInitialAdminBootstrapSignup, readInitialAdminBootstrapGrantFromBody } from "./initial-admin-bootstrap.js";
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid";
import * as schema from "@openwork-ee/den-db/schema";
import { apiKey } from "@better-auth/api-key";
import { createCimdClientDiscovery } from "@better-auth/cimd";
import { extendOAuthProvider, oauthProvider } from "@better-auth/oauth-provider";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { deleteSessionCookie } from "better-auth/cookies";
import { and, eq, gt, sql } from "@openwork-ee/den-db/drizzle";
import { deviceAuthorization, emailOTP, jwt, organization } from "better-auth/plugins";
import {
  DEN_DEVICE_CODE_EXPIRES_IN,
  DEN_DEVICE_CODE_POLL_INTERVAL,
  clearDeviceSessionOrganization,
  isDenDeviceClientId,
  stageDeviceSessionOrganization,
  takeDeviceSessionOrganization,
} from "./device-authorization.js";
import { WORKBOT_OAUTH_CLIENT_ID } from "./workbot/config.js";
import { DEN_LIMITED_BETTER_AUTH_PATHS } from "./auth-rate-limits.js";
import { MCP_SESSION_REVOKED_GRANT_DESCRIPTION } from "./oauth-token-rate-limit-observability.js";
import { CLIENT_IP_IPV6_SUBNET, RESOLVED_CLIENT_IP_HEADER } from "./client-ip.js";
import { ensureWorkbotOAuthClient } from "./workbot/oauth-client.js";

const logger = appLogger.child({ component: "auth" });

const SSO_SESSION_PATHS = new Set(["/sso/callback/:providerId", "/sso/callback", "/sso/saml2/sp/acs/:providerId", "/sso/saml2/callback/:providerId"]);

async function organizationIdForSlug(slug: string | null) {
  if (!slug) return null;
  const [organization] = await db
    .select({ id: schema.OrganizationTable.id })
    .from(schema.OrganizationTable)
    .where(eq(schema.OrganizationTable.slug, slug))
    .limit(1);
  return organization?.id ?? null;
}

const deviceApprovedSessionOrganizations = new Map<string, { organizationId: string; ssoProviderId: string | null; ssoAuthenticatedAt: Date | null }>();

function localMcpResourceAliases(resource: string) {
  if (!env.devMode) {
    return [];
  }

  try {
    const url = new URL(resource);
    if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
      return [url.toString().replace(/\/+$/, "")];
    }
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return [url.toString().replace(/\/+$/, "")];
    }
  } catch {}

  return [];
}

function apiPublicMcpResource(apiPublicUrl: string | undefined) {
  if (!apiPublicUrl) return [];

  try {
    const url = new URL(apiPublicUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    return [`${url.origin}${pathname === "/" ? "" : pathname}/mcp`];
  } catch {
    return [];
  }
}

function mcpEndpointResourceAliases(resource: string) {
  return [mcpEndpointResource(resource, "agent"), mcpEndpointResource(resource, "admin")];
}

export const DEN_MCP_RESOURCE = env.mcpResourceUrl ?? deriveDenMcpResource(env.betterAuthUrl, env.webAppHosts);
export const DEN_MCP_OAUTH_RESOURCE = deriveDenMcpAgentResource({
  apiPublicUrl: env.apiPublicUrl,
  mcpResource: DEN_MCP_RESOURCE,
});
export const DEN_MCP_FIRST_PARTY_CLIENT_ID = "openwork-desktop";
const DEN_API_PUBLIC_MCP_RESOURCES = apiPublicMcpResource(env.apiPublicUrl);
const DEN_MCP_BASE_RESOURCES = [
  DEN_MCP_RESOURCE,
  `${env.betterAuthUrl}/mcp`,
  ...DEN_API_PUBLIC_MCP_RESOURCES,
  ...env.mcpAdditionalResources,
  ...localMcpResourceAliases(DEN_MCP_RESOURCE),
  ...DEN_API_PUBLIC_MCP_RESOURCES.flatMap((resource) => localMcpResourceAliases(resource)),
  ...env.mcpAdditionalResources.flatMap((resource) => localMcpResourceAliases(resource)),
];
export const DEN_MCP_LEGACY_PARENT_RESOURCES = Array.from(new Set(DEN_MCP_BASE_RESOURCES));
export const DEN_MCP_FIRST_PARTY_RESOURCES = Array.from(new Set([
  ...DEN_MCP_BASE_RESOURCES,
  ...DEN_MCP_BASE_RESOURCES.flatMap((resource) => mcpEndpointResourceAliases(resource)),
]));
export const DEN_MCP_RESOURCES = Array.from(new Set([
  DEN_MCP_OAUTH_RESOURCE,
  ...DEN_MCP_FIRST_PARTY_RESOURCES,
]));
export const DEN_MCP_OAUTH_VALID_AUDIENCES = [DEN_MCP_OAUTH_RESOURCE];
export const DEN_MCP_TOKEN_USE_CLAIM = `${env.mcpClaimNamespace}/token_use`;
export const DEN_MCP_ORG_ID_CLAIM = `${env.mcpClaimNamespace}/org_id`;
export const DEN_MCP_RESOURCE_CLAIM = `${env.mcpClaimNamespace}/resource`;
export const DEN_MCP_GRANT_ID_CLAIM = `${env.mcpClaimNamespace}/grant_id`;
export const DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX = "ow_mcp_at_";
const DEN_MCP_REFRESH_TOKEN_PREFIX = "ow_mcp_rt_";
export { DEN_MCP_SCOPES } from "./mcp/scopes.js";

export function normalizeMcpOAuthResource(resource: string): string | null {
  const normalized = resource.replace(/\/+$/, "");
  if (normalized === DEN_MCP_OAUTH_RESOURCE) {
    return DEN_MCP_OAUTH_RESOURCE;
  }
  return DEN_MCP_FIRST_PARTY_RESOURCES.includes(normalized) ? DEN_MCP_OAUTH_RESOURCE : null;
}

type AuthMemberHookRow = typeof schema.MemberTable.$inferSelect;

const socialProviders = {
  ...(env.github.clientId && env.github.clientSecret
    ? {
        github: {
          clientId: env.github.clientId,
          clientSecret: env.github.clientSecret,
        },
      }
    : {}),
  ...(env.google.clientId && env.google.clientSecret
    ? {
        google: {
          clientId: env.google.clientId,
          clientSecret: env.google.clientSecret,
        },
      }
    : {}),
};

function hasRole(roleValue: string, roleName: string) {
  return organizationRoleValueIncludes(roleValue, roleName);
}

function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === "string")
    : [];
}

function pickRemoteIdentity(userInfo: Record<string, unknown>) {
  return (
    maybeString(userInfo.sub) ??
    maybeString(userInfo.id) ??
    maybeString(userInfo.nameID) ??
    maybeString(userInfo.nameId) ??
    maybeString(userInfo.email)
  );
}

function getInvitationOrigin() {
  return (
    env.betterAuthTrustedOrigins.find((origin) => origin !== "*") ??
    env.betterAuthUrl
  );
}

function buildInvitationLink(invitationId: string) {
  return new URL(
    `/join-org?invite=${encodeURIComponent(invitationId)}`,
    getInvitationOrigin(),
  ).toString();
}

function hasMcpScope(scopes: readonly string[]) {
  return scopes.some((scope) => scope.startsWith("mcp:"));
}

async function revokeOrganizationMemberCredentials(input: {
  organizationId: string;
  orgMembershipId: string;
  userId: string | null;
  reason: "member_removed" | "member_role_changed";
}) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId);
  const orgMembershipId = normalizeDenTypeId("member", input.orgMembershipId);
  const userId = input.userId ? normalizeDenTypeId("user", input.userId) : null;

  await revokeOrganizationApiKeysForMember({
    organizationId,
    orgMembershipId,
    userId,
    reason: input.reason,
  });
  await revokeMembershipSessionCredentials({
    organizationId,
    userId,
    memberId: orgMembershipId,
    reason: input.reason === "member_removed" ? "member_removed" : "role_changed",
  });
}

async function deleteOrganizationMemberConnectedAccounts(input: {
  organizationId: string;
  orgMembershipId: string;
}) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId);
  const orgMembershipId = normalizeDenTypeId("member", input.orgMembershipId);

  await db
    .delete(schema.ConnectedAccountTable)
    .where(and(
      eq(schema.ConnectedAccountTable.organizationId, organizationId),
      eq(schema.ConnectedAccountTable.orgMembershipId, orgMembershipId),
    ));
  await db
    .delete(schema.LlmProviderMemberCredentialTable)
    .where(and(
      eq(schema.LlmProviderMemberCredentialTable.organizationId, organizationId),
      eq(schema.LlmProviderMemberCredentialTable.orgMembershipId, orgMembershipId),
    ));
}

function throwMemberLifecycleError(message: string): never {
  throw new APIError("BAD_REQUEST", { message });
}

const auditHookLogger = appLogger.child({ component: "better_auth_audit" });

async function readAuditHookSession(token: unknown): Promise<BetterAuthHookSession> {
  const session = typeof token === "string" ? await cache.auth.session(token) : null;
  if (!session?.user.id) return null;
  return {
    userId: session.user.id,
    email: typeof session.user.email === "string" ? session.user.email : null,
    sessionId: session.session.id,
    activeOrganizationId: typeof session.session.activeOrganizationId === "string" ? session.session.activeOrganizationId : null,
    activeTeamId: session.session.activeTeamId,
  };
}

async function runAuditHook(name: string, run: () => Promise<void>): Promise<void> {
  if (!env.auditCaptureEnabled) return;
  try {
    await run();
  } catch (error) {
    auditHookLogger.warn("better-auth session/account audit hook failed", { audit_hook: name, error_name: error instanceof Error ? error.name : typeof error });
  }
}

function removedMemberIdentity(value: unknown): { id: string; organizationId: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const nestedMember = Object.getOwnPropertyDescriptor(value, "member")?.value;
  const candidate = nestedMember && typeof nestedMember === "object" ? nestedMember : value;
  const id = Object.getOwnPropertyDescriptor(candidate, "id")?.value;
  const organizationId = Object.getOwnPropertyDescriptor(candidate, "organizationId")?.value;
  if (typeof id !== "string" || typeof organizationId !== "string") {
    return null;
  }
  return { id, organizationId };
}

const RAW_BETTER_AUTH_MUTATION_DENIALS: readonly (readonly [string, string])[] = [
  ["/organization/update", "Use the Den organization settings API to update workspace configuration."],
  ["/organization/delete", "Workspace deletion through Better Auth is disabled."],
  ["/organization/update-member-role", "Use the Den member role API to change organization roles."],
  ["/organization/remove-member", "Use the Den member API to remove organization members."],
  ["/organization/create-role", "Custom organization roles are not supported."],
  ["/organization/update-role", "Custom organization roles are not supported."],
  ["/organization/delete-role", "Custom organization roles are not supported."],
  ["/organization/create-team", "Use the Den teams API to manage teams."],
  ["/organization/update-team", "Use the Den teams API to manage teams."],
  ["/organization/remove-team", "Use the Den teams API to manage teams."],
  ["/organization/add-team-member", "Use the Den teams API to manage team membership."],
  ["/organization/remove-team-member", "Use the Den teams API to manage team membership."],
  ["/organization/add-member", "Use the Den invitation API to add members."],
  ["/organization/invite-member", "Use the Den invitation API to invite members."],
  ["/organization/cancel-invitation", "Use the Den invitation API to cancel invitations."],
  ["/organization/accept-invitation", "Use the Den invitation API to accept invitations."],
  ["/sso/register", "Use the Den SSO API to manage SSO providers."],
  ["/sso/update-provider", "Use the Den SSO API to manage SSO providers."],
  ["/sso/delete-provider", "Use the Den SSO API to manage SSO providers."],
  ["/sso/request-domain-verification", "Use the Den SSO API to verify SSO domains."],
  ["/sso/verify-domain", "Use the Den SSO API to verify SSO domains."],
  ["/api-key/create", "Use the Den API key API to manage organization API keys."],
  ["/api-key/update", "Use the Den API key API to manage organization API keys."],
  ["/api-key/delete", "Use the Den API key API to manage organization API keys."],
  ["/scim/generate-token", "Use the Den SCIM API to manage SCIM tokens."],
  ["/scim/delete-provider-connection", "Use the Den SCIM API to manage SCIM providers."],
  ["/device/approve", "Approve command-line sign-ins on the Den device page."],
  ["/device/deny", "Deny command-line sign-ins on the Den device page."],
];

export function getRawBetterAuthMutationDenial(path: string) {
  const denial = RAW_BETTER_AUTH_MUTATION_DENIALS.find(([deniedPath]) => deniedPath === path);
  if (!denial) {
    return null;
  }
  return {
    error: "forbidden",
    message: denial[1],
  };
}

async function denyBetterAuthTeamMutation() {
  throw new APIError("FORBIDDEN", { message: "Use the Den teams API to manage teams and their membership." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function clampSessionExpiresAt(userId: string, expiresAt: Date, createdAt: Date) {
  try {
    const latest = await userSessionExpiresAt(userId, new Date(), createdAt);
    return latest < expiresAt ? latest : expiresAt;
  } catch (error) {
    logger.error("session length could not be read", { user_id: userId, error });
    return expiresAt;
  }
}

function readStringProperty(value: unknown, propertyName: string) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const property = Object.getOwnPropertyDescriptor(value, propertyName)?.value;
  return typeof property === "string" && property.trim() ? property.trim() : null;
}

function readRequestQueryParam(request: Request | undefined, propertyName: string) {
  if (!request) {
    return null;
  }

  const value = new URL(request.url).searchParams.get(propertyName)?.trim() ?? "";
  return value || null;
}

async function hasPendingInvitationForEmail(input: { invitationIdOrToken: string | null; email: string | null }) {
  if (!input.invitationIdOrToken || !input.email) {
    return false;
  }

  const [invitation] = await db
    .select({ inviteToken: schema.InvitationTable.inviteToken })
    .from(schema.InvitationTable)
    .where(and(
      sql`(${schema.InvitationTable.id} = ${input.invitationIdOrToken} or ${schema.InvitationTable.inviteToken} = ${input.invitationIdOrToken})`,
      eq(schema.InvitationTable.status, "pending"),
      gt(schema.InvitationTable.expiresAt, new Date()),
      sql`lower(${schema.InvitationTable.email}) = ${input.email.trim().toLowerCase()}`,
    ))
    .limit(1);

  return Boolean(invitation);
}

function readSignUpInvite(ctx: { request?: Request; query?: unknown; body?: unknown } | null | undefined) {
  if (!ctx) return null;
  return readRequestQueryParam(ctx.request, "invite") ?? readStringProperty(ctx.query, "invite") ?? readStringProperty(ctx.body, "invite");
}

async function isEmailAlreadyVerified(email: string) {
  const [user] = await db
    .select({ emailVerified: schema.AuthUserTable.emailVerified })
    .from(schema.AuthUserTable)
    .where(eq(schema.AuthUserTable.email, normalizeLoginEmail(email)))
    .limit(1);
  return user?.emailVerified === true;
}

function normalizeRawRoleValue(roleValue: string) {
  return splitOrganizationRoles(roleValue)
    .map((role) => normalizeOrganizationRoleName(role))
    .filter(Boolean)
    .join(",");
}

function readRoleProperty(value: unknown, propertyName: string) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const property = Object.getOwnPropertyDescriptor(value, propertyName)?.value;
  if (typeof property === "string") {
    const normalized = normalizeRawRoleValue(property);
    return normalized || null;
  }

  if (!Array.isArray(property)) {
    return null;
  }

  const roles: string[] = [];
  for (const entry of property) {
    if (typeof entry === "string") {
      const normalized = normalizeOrganizationRoleName(entry);
      if (normalized) {
        roles.push(normalized);
      }
    }
  }
  return roles[0] ? roles.join(",") : null;
}

function readBooleanProperty(value: unknown, propertyName: string) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.getOwnPropertyDescriptor(value, propertyName)?.value === true;
}

function hashOAuthProviderToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function stripMcpRefreshTokenPrefix(refreshToken: string) {
  return refreshToken.startsWith(DEN_MCP_REFRESH_TOKEN_PREFIX)
    ? refreshToken.slice(DEN_MCP_REFRESH_TOKEN_PREFIX.length)
    : null;
}

async function assertLiveMcpSessionForRefreshGrant(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  if (ctx.path !== "/oauth2/token" || readStringProperty(ctx.body, "grant_type") !== "refresh_token") {
    return;
  }

  const refreshToken = readStringProperty(ctx.body, "refresh_token");
  if (!refreshToken) {
    return;
  }

  const tokenSecret = stripMcpRefreshTokenPrefix(refreshToken);
  if (!tokenSecret) {
    return;
  }

  const grant = await ctx.context.adapter.findOne<McpRefreshGrantRow>({
    model: "oauthRefreshToken",
    where: [{ field: "token", value: hashOAuthProviderToken(tokenSecret) }],
  });
  try {
    await assertLiveMcpRefreshGrant({
      grant,
      getSessionLiveness: getMcpSessionLiveness,
      findConsent: ({ clientId, userId, referenceId }) => ctx.context.adapter.findOne<{ id: string }>({
        model: "oauthConsent",
        where: [
          { field: "clientId", value: clientId },
          { field: "userId", value: userId },
          { field: "referenceId", value: referenceId },
        ],
      }),
      deleteGrantFamily: deleteMcpOAuthGrantFamilyForSession,
    });
  } catch (error) {
    if (!(error instanceof McpRefreshGrantRevokedError)) {
      throw error;
    }
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: MCP_SESSION_REVOKED_GRANT_DESCRIPTION,
    });
  }
}

async function resolveBetterAuthActor(input: { organizationId: string; userId: string }) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId);
  const member = await cache.org.membership({
    organizationId,
    userId: normalizeDenTypeId("user", input.userId),
  });
  if (!member) {
    return null;
  }
  return {
    organizationId,
    memberId: member.id,
    permissions: await resolvePermissionsForMember({ organizationId, memberId: member.id }),
  };
}

async function resolveBetterAuthActorPermissions(input: { organizationId: string; userId: string }) {
  return (await resolveBetterAuthActor(input))?.permissions ?? null;
}

async function assertBetterAuthActorMayInvite(input: {
  actor: NonNullable<Awaited<ReturnType<typeof resolveBetterAuthActor>>>;
  role: string;
}) {
  const validation = await validateInvitationRoleAssignment({
    role: input.role,
    permissions: input.actor.permissions,
    decideAdminAssignment: (role) => roleAssignmentDenial({
      organizationId: input.actor.organizationId,
      caller: input.actor.permissions,
      callerMemberId: input.actor.memberId,
      target: null,
      nextRole: role,
    }),
  });
  if (!validation.ok) {
    throw new APIError(validation.error === "invalid_role" ? "BAD_REQUEST" : "FORBIDDEN", {
      message: validation.message,
    });
  }
}

async function assertBetterAuthInvitationRoleAssignment(input: {
  organizationId: string;
  userId: string;
  role: string;
}) {
  const actor = await resolveBetterAuthActor(input);
  if (!actor) {
    throw new APIError("FORBIDDEN", {
      message: "Only organization members can assign invitation roles.",
    });
  }

  await assertBetterAuthActorMayInvite({ actor, role: input.role || ORGANIZATION_MEMBER_ROLE });
}

async function assertBetterAuthInvitationRefreshRole(input: {
  organizationId: string;
  userId: string;
  email: string;
  resend: boolean;
}) {
  if (!input.resend) {
    return;
  }

  const actor = await resolveBetterAuthActor(input);
  if (!actor) {
    throw new APIError("FORBIDDEN", {
      message: "Only organization members can refresh invitation roles.",
    });
  }

  const invitations = await db
    .select({ role: schema.InvitationTable.role })
    .from(schema.InvitationTable)
    .where(and(
      eq(schema.InvitationTable.organizationId, actor.organizationId),
      eq(schema.InvitationTable.email, input.email.trim().toLowerCase()),
      eq(schema.InvitationTable.status, "pending"),
      gt(schema.InvitationTable.expiresAt, new Date()),
    ))
    .limit(1);

  const invitation = invitations[0] ?? null;
  if (!invitation) {
    return;
  }

  await assertBetterAuthActorMayInvite({ actor, role: invitation.role });
}

async function getOrganizationMemberRole(input: {
  organizationId: string;
  userId: string;
}) {
  const member = await cache.org.membership({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    userId: normalizeDenTypeId("user", input.userId),
  });
  if (!member) {
    return null;
  }
  const authority = await resolveOrganizationMemberAuthority({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    memberId: member.id,
  });
  if (!authority) return null;
  return {
    memberId: authority.id,
    role: authority.directRole,
    adminTeams: authority.adminTeams,
    isOwner: hasRole(authority.directRole, ORGANIZATION_OWNER_ROLE),
  };
}

type StoredOAuthTokenRow = { clientId?: unknown; userId?: unknown; referenceId?: unknown; scopes?: unknown };

async function noteRevokedOAuthToken(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const token = readStringProperty(ctx.body, "token");
  if (!token) return;
  const refreshSecret = stripMcpRefreshTokenPrefix(token);
  const accessSecret = token.startsWith(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX) ? token.slice(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX.length) : null;
  const secret = refreshSecret ?? accessSecret;
  if (!secret) return;
  const tokenType = refreshSecret ? "refresh_token" : "access_token";
  const row = await ctx.context.adapter.findOne<StoredOAuthTokenRow>({
    model: tokenType === "refresh_token" ? "oauthRefreshToken" : "oauthAccessToken",
    where: [{ field: "token", value: hashOAuthProviderToken(secret) }],
  });
  const clientId = typeof row?.clientId === "string" ? row.clientId : null;
  const userId = typeof row?.userId === "string" ? row.userId : null;
  const referenceId = typeof row?.referenceId === "string" ? row.referenceId : null;
  if (!clientId || !userId || !referenceId) return;
  noteOAuthRevocation({ clientId, userId, referenceId, scopes: stringArray(row?.scopes), tokenType });
}

function getEnterpriseAuthRedirectUrl(input: {
  signInPath: string;
  email: string;
  callbackUrl: string | null;
}) {
  const url = new URL(input.signInPath, getInvitationOrigin());
  url.searchParams.set("loginHint", input.email);
  if (input.callbackUrl) {
    url.searchParams.set("callbackURL", input.callbackUrl);
  }
  return url.toString();
}

async function updateLastSignInCookie(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const change = lastSignInCookieChange({
    path: ctx.path,
    provider: readStringProperty(ctx.params, "id") ?? readStringProperty(ctx.body, "provider"),
    signedIn: Boolean(ctx.context.newSession),
  });
  if (!change) return;
  const writes = lastSignInCookieWrites(change, {
    secure: env.betterAuthUrl.startsWith("https:"),
    cookieDomain: env.betterAuthCookieDomain,
  });
  for (const write of writes) {
    ctx.setCookie(write.name, write.value, write.options);
  }
}

function removeSsoTestSessionCookie(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const headers = ctx.context.responseHeaders;
  if (!headers) return;
  const sessionCookiePrefix = `${ctx.context.authCookies.sessionToken.name}=`;
  const cookies = headers.getSetCookie().filter((cookie) => !cookie.startsWith(sessionCookiePrefix));
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
}

type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const SSO_CARRY_COOKIE = "sso_carry";
const SSO_CARRY_MAX_AGE_SECONDS = 10 * 60;

function ssoCarryCookie(ctx: Pick<AuthHookContext, "context">) {
  const cookie = ctx.context.createAuthCookie(SSO_CARRY_COOKIE, { maxAge: SSO_CARRY_MAX_AGE_SECONDS });
  const secure = env.betterAuthUrl.startsWith("https:");
  return { name: cookie.name, attributes: { ...cookie.attributes, secure, sameSite: secure ? "none" as const : "lax" as const } };
}

async function setSsoCarryCookie(ctx: AuthHookContext) {
  if (!readStringProperty(ctx.context.returned, "url")) return;
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
  const session = typeof token === "string" ? await cache.auth.session(token) : null;
  if (!session) return;
  const cookie = ssoCarryCookie(ctx);
  await ctx.setSignedCookie(cookie.name, `${session.session.id}.${Date.now()}`, ctx.context.secret, cookie.attributes);
}

function clearSsoCarryCookie(ctx: AuthHookContext) {
  const cookie = ssoCarryCookie(ctx);
  ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
}

async function readSsoCarrySessionId(ctx: Pick<AuthHookContext, "context" | "getSignedCookie">) {
  const value = await ctx.getSignedCookie(ssoCarryCookie(ctx).name, ctx.context.secret).catch(() => null);
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf(".");
  const issuedAt = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isFinite(issuedAt) || Date.now() - issuedAt > SSO_CARRY_MAX_AGE_SECONDS * 1000) return null;
  return value.slice(0, separator);
}

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  onAPIError: {
    errorURL: `${env.betterAuthUrl}/connect/error`,
  },
  trustedOrigins:
    env.betterAuthTrustedOrigins.length > 0
      ? env.betterAuthTrustedOrigins
      : undefined,
  socialProviders:
    Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
  database: guardDesktopDeviceSessions(
    hashSessionTokens(drizzleAdapter(db.$primary, { provider: "mysql", schema }), { secret: env.betterAuthSecret }),
    (database) => hashSessionTokens(drizzleAdapter(database, { provider: "mysql", schema }), { secret: env.betterAuthSecret }),
  ),
  account: DEN_ACCOUNT_CONFIG,
  user: denUserConfig(),
  session: {
    expiresIn: DEN_SESSION_EXPIRES_IN_SECONDS,
    updateAge: DEN_SESSION_UPDATE_AGE_IN_SECONDS,
    freshAge: 15 * 60,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          const email = normalizeLoginEmail(user.email);
          const ssoProviderId = readStringProperty(context?.params, "providerId");
          if (ssoProviderId && await isScimDeprovisionedEmailForSsoProvider({ ssoProviderId, email })) {
            throw new APIError("FORBIDDEN", { message: SCIM_DEPROVISIONED_SIGN_IN_MESSAGE });
          }
          const passwordSignup = context?.path === "/sign-up/email";
          const verifiedByBootstrap = passwordSignup
            && Boolean(await authorizeInitialAdminBootstrapSignup({ body: context.body, email }));
          return {
            data: {
              ...user,
              email,
              ...(passwordSignup ? { emailVerified: verifiedByBootstrap } : {}),
            },
          };
        },
      },
      update: {
        before: async (user, context) => {
          if (typeof user.email === "string" && context?.path === "/scim/v2/Users/:userId") {
            const userId = readStringProperty(context.params, "userId");
            const allowed = userId !== null && await scimEmailChangeAllowed({
              userId: normalizeDenTypeId("user", userId),
              email: user.email,
              resolveOrganizationId: () => scimRequestOrganizationId(context.headers?.get("authorization")),
            });
            if (!allowed) throw new APIError("BAD_REQUEST", SCIM_EMAIL_CHANGE_REFUSAL);
          }
          if (env.auditCaptureEnabled) auditUserUpdateBefore(user, context);
          return {
            data: typeof user.email === "string"
              ? {
                ...user,
                email: normalizeLoginEmail(user.email),
              }
              : user,
          };
        },
        after: async (user, context) => {
          if (typeof user.id === "string") {
            await cache.auth.deleteSessionsForUser(normalizeDenTypeId("user", user.id));
          }
          await runAuditHook("user.update", () => auditUserUpdateAfter(user, context));
        },
      },
      delete: {
        before: async (user) => {
          await runAuditHook("user.delete", () => recordAccountDeleted(user));
        },
      },
    },
    account: {
      create: {
        after: async (account, context) => {
          await runAuditHook("account.create", () => recordIdentityLinked(account, context));
        },
      },
      delete: {
        after: async (account) => {
          await runAuditHook("account.delete", () => recordIdentityUnlinked(account));
        },
      },
    },
    teamMember: {
      delete: {
        before: async (membership: typeof schema.TeamMemberTable.$inferSelect) => {
          await db.transaction((tx) => invalidateTeamInferenceOAuth(tx, membership.teamId));
        },
      },
    },
    team: {
      delete: {
        before: async (team: typeof schema.TeamTable.$inferSelect) => {
          await db.transaction((tx) => invalidateTeamInferenceOAuth(tx, team.id));
        },
      },
    },
    member: {
      create: {
        after: async (member: AuthMemberHookRow) => {
          if (member.removedAt) return;
          await runPostOrganizationMemberChangeHooks({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
            change: "added",
          });
        },
      },
      delete: {
        before: async (member: AuthMemberHookRow) => {
          const validation = await validateOrganizationMemberRemovalForHook({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
          });
          if (!validation.ok) {
            throwMemberLifecycleError(validation.message);
          }

          await deleteOrganizationMemberConnectedAccounts({
            organizationId: member.organizationId,
            orgMembershipId: member.id,
          });
          await revokeOrganizationMemberCredentials({
            organizationId: member.organizationId,
            orgMembershipId: member.id,
            userId: member.userId,
            reason: "member_removed",
          });
          await revokeMemberGatewayCredentials({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
          });
        },
        after: async (member: AuthMemberHookRow) => {
          const organizationId = normalizeDenTypeId("organization", member.organizationId);
          await revokeMemberGatewayCredentials({
            organizationId,
            memberId: normalizeDenTypeId("member", member.id),
          });
          await cache.org.deleteMembers(organizationId);
          await syncOrganizationBillingQuantities({ organizationId });
          removeMemberWorkbotComputersInBackground({ organizationId, memberId: normalizeDenTypeId("member", member.id) });
        },
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          const userId = normalizeDenTypeId("user", session.userId);
          const deviceCode = context?.path === "/device/token" ? readStringProperty(context.body, "device_code") : null;
          const desktopDevice = context?.path === "/device/token" && readStringProperty(context.body, "client_id") === DEN_DESKTOP_DEVICE_CLIENT_ID;
          const deviceApproval = desktopDevice
            ? requireDesktopDeviceClaim(userId)
            : deviceCode ? await takeDeviceSessionOrganization({ deviceCode, userId }) : null;
          const activeOrganizationId = deviceApproval?.organizationId ?? await getInitialActiveOrganizationIdForUser(userId);
          if (deviceApproval && !desktopDevice && typeof session.token === "string") {
            deviceApprovedSessionOrganizations.set(session.token, deviceApproval);
          }
          try {
            await reconcilePendingInvitationsForUser(userId);
          } catch (error) {
            logger.error("invitation reconcile failed", { user_id: userId, error });
          }

          const expiresAt = await clampSessionExpiresAt(userId, session.expiresAt, session.createdAt instanceof Date ? session.createdAt : new Date());
          return {
            data: {
              ...session,
              activeOrganizationId,
              ...(desktopDevice ? { userAgent: DEN_DESKTOP_DEVICE_CLIENT_ID } : {}),
              expiresAt,
            },
          };
        },
        after: async (session, context) => {
          const path = typeof context?.path === "string" ? context.path : null;
          if (path && SSO_SESSION_PATHS.has(path) && typeof session.id === "string") {
            await recordSessionSsoAuthentication({
              sessionId: session.id,
              userId: session.userId,
              providerId: readStringProperty(context?.params, "providerId"),
            }).catch((error) => logger.error("session SSO provenance could not be recorded", { error }));
            const fromSessionId = context ? await readSsoCarrySessionId(context) : null;
            if (fromSessionId) {
              await carrySessionSsoProofs({ fromSessionId, toSessionId: session.id, userId: session.userId })
                .catch((error) => logger.error("earlier SSO sign-ins could not be carried to the new session", { error }));
            }
          }
          const desktopDevice = path === "/device/token" && readStringProperty(context?.body, "client_id") === DEN_DESKTOP_DEVICE_CLIENT_ID;
          const deviceApproval = desktopDevice
            ? requireDesktopDeviceClaim(normalizeDenTypeId("user", session.userId))
            : typeof session.token === "string" ? deviceApprovedSessionOrganizations.get(session.token) : undefined;
          if (!desktopDevice && typeof session.token === "string") deviceApprovedSessionOrganizations.delete(session.token);
          if (deviceApproval?.ssoProviderId && typeof session.id === "string") {
            await recordDeviceSessionSsoAuthentication({ sessionId: session.id, userId: session.userId, organizationId: deviceApproval.organizationId, providerId: deviceApproval.ssoProviderId, authenticatedAt: deviceApproval.ssoAuthenticatedAt })
              .catch((error) => logger.error("device session SSO provenance could not be recorded", { error }));
          }
          await recordFreeAutoSignIn(db, { userId: normalizeDenTypeId("user", session.userId), now: session.createdAt })
            .catch(() => logger.warn("Free Auto sign-in behavior could not be recorded."));
          await runAuditHook("session.create", () => recordSessionCreated(session, auditSessionMethod(context)));
        },
      },
      update: {
        before: async (session, context) => {
          const current = context?.context.session?.session;
          if (!(session.expiresAt instanceof Date) || !current || typeof current.userId !== "string") return;
          return { data: { ...session, expiresAt: await clampSessionExpiresAt(current.userId, session.expiresAt, new Date(current.createdAt)) } };
        },
        after: async (session) => {
          if (typeof session.token === "string") {
            await cache.auth.deleteSession(session.token);
          }
          if (typeof session.id === "string") {
            await cache.auth.deleteSessionId(normalizeDenTypeId("session", session.id));
          }
        },
      },
      delete: {
        before: async (session, context) => {
          if (context?.path === "/revoke-other-sessions" && session.id === context.context.session?.session.id) return false;
        },
        after: async (session, context) => {
          if (typeof session.token === "string") {
            await cache.auth.revokeSession(session.token);
          }
          if (typeof session.id === "string") {
            await deleteSessionSsoAuthentication(session.id).catch(() => undefined);
          }
          if (typeof session.id === "string") {
            await cache.auth.revokeSessionId(normalizeDenTypeId("session", session.id));
          }
          await runAuditHook("session.delete", () => recordSessionRevoked(session, auditSessionRevokeReason(context)));
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/device/token" && readStringProperty(ctx.body, "client_id") === DEN_DESKTOP_DEVICE_CLIENT_ID) {
        beginDesktopDeviceClaim();
      }
      if ((ctx.path === "/device/code" || ctx.path === "/device/token") && readStringProperty(ctx.body, "client_id") === DEN_DESKTOP_DEVICE_CLIENT_ID) {
        const enabled = await db.transaction((tx) => desktopDeviceLoginEnabled(tx));
        if (!enabled) {
          if (ctx.path === "/device/code") throw new APIError("BAD_REQUEST", { error: "invalid_client", error_description: "Device sign-in is not available on this server." });
          throw desktopDeviceAccessDenied();
        }
      }
      if (ctx.path === "/device/token" && readStringProperty(ctx.body, "client_id") !== DEN_DESKTOP_DEVICE_CLIENT_ID) {
        const deviceCode = readStringProperty(ctx.body, "device_code");
        if (deviceCode) {
          await stageDeviceSessionOrganization(deviceCode);
        }
      }

      await assertLiveMcpSessionForRefreshGrant(ctx);

      if (ctx.path === "/scim/v2/Users" && ctx.request?.method === "POST") {
        const organizationId = await scimRequestOrganizationId(ctx.headers?.get("authorization"));
        if (organizationId && !await organizationAllowsProvisioning(organizationId, "scim")) {
          throw new APIError("FORBIDDEN", { message: SCIM_ENTERPRISE_REQUIRED_MESSAGE });
        }
        if (organizationId) {
          await releaseStaleScimAccountForCreate({ organizationId, body: ctx.body });
        }
      }

      if (ctx.path === "/oauth2/authorize") {
        const clientId = maybeString(ctx.query?.client_id);
        if (clientId === WORKBOT_OAUTH_CLIENT_ID) {
          await ensureWorkbotOAuthClient(ctx.context.adapter);
        }
        const requestedScopes = maybeString(ctx.query?.scope)?.split(/\s+/).filter(Boolean) ?? [];

        if (clientId) {
          const client = await ctx.context.adapter.findOne<{ scopes?: unknown }>({
            model: "oauthClient",
            where: [{ field: "clientId", value: clientId }],
          });
          const clientScopes = stringArray(client?.scopes);
          const nextScopes = addRequestedMcpClientScopes(clientScopes, requestedScopes);

          if (nextScopes.length > clientScopes.length) {
            await ctx.context.adapter.update({
              model: "oauthClient",
              where: [{ field: "clientId", value: clientId }],
              update: {
                scopes: nextScopes,
                updatedAt: new Date(),
              },
            });
          }
        }
      }

      if (ctx.request) {
        const deniedMutation = getRawBetterAuthMutationDenial(ctx.path);
        if (deniedMutation) {
          if (env.auditCaptureEnabled) {
            await auditBetterAuthRefusal({
              body: ctx.body,
              session: async () => readAuditHookSession(await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null)),
            });
          }
          throw new APIError("FORBIDDEN", { message: deniedMutation.message });
        }

        if (env.auditCaptureEnabled && ctx.path === "/oauth2/revoke") {
          await runAuditHook("oauth2.revoke", () => noteRevokedOAuthToken(ctx));
        }

        if (env.auditCaptureEnabled && BETTER_AUTH_AUDIT_BEFORE_PATHS.has(ctx.path)) {
          let audited = true;
          try {
            audited = (await auditBetterAuthBefore({
              path: ctx.path, request: ctx.request, body: ctx.body, query: ctx.query,
              session: async () => readAuditHookSession(await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null)),
            })).ok;
          } catch (error) {
            auditHookLogger.warn("better-auth audit attribution failed; continuing without attribution", { auth_path: ctx.path, error_name: error instanceof Error ? error.name : typeof error });
          }
          if (!audited) {
            throw new APIError("SERVICE_UNAVAILABLE", { message: "audit_unavailable", code: "audit_unavailable" });
          }
        }

        if (env.auditCaptureEnabled && BETTER_AUTH_SESSION_BEFORE_PATHS.has(ctx.path)) {
          await auditBetterAuthSessionBefore({
            path: ctx.path, request: ctx.request,
            session: async () => readAuditHookSession(await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null)),
            resetPasswordUserId: async () => {
              const token = readStringProperty(ctx.body, "token") ?? readStringProperty(ctx.query, "token");
              const verification = token ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`) : null;
              return verification && verification.expiresAt > new Date() ? verification.value : null;
            },
          });
        }

        if (ctx.path === "/organization/leave") {
          const organizationId = readStringProperty(ctx.body, "organizationId");
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
          const session = typeof token === "string" ? await cache.auth.session(token) : null;
          if (organizationId && session?.user.id) {
            const member = await getOrganizationMemberRole({
              organizationId,
              userId: session.user.id,
            });
            if (member?.isOwner) {
              throw new APIError("FORBIDDEN", {
                message: "The organization owner cannot leave the workspace. Transfer ownership first.",
              });
            }
            if (member?.adminTeams.length) {
              const permissions = await resolvePermissionsForMember({
                organizationId: normalizeDenTypeId("organization", organizationId),
                memberId: member.memberId,
              });
              if (!permissions.has("teams.manage_admin")) {
                throw new APIError("FORBIDDEN", {
                  message: "Ask the organization owner to remove your Admin team membership before you leave.",
                });
              }
            }
          }
        }

        if (ctx.path === "/organization/add-member") {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
          const session = typeof token === "string" ? await cache.auth.session(token) : null;
          const organizationId = readStringProperty(ctx.body, "organizationId")
            ?? (typeof session?.session.activeOrganizationId === "string" ? session.session.activeOrganizationId : null);
          if (organizationId && session?.user.id) {
            await assertBetterAuthInvitationRoleAssignment({
              organizationId,
              userId: session.user.id,
              role: readRoleProperty(ctx.body, "role") ?? ORGANIZATION_MEMBER_ROLE,
            });
            const email = readStringProperty(ctx.body, "email");
            if (email) {
              await assertBetterAuthInvitationRefreshRole({
                organizationId,
                userId: session.user.id,
                email,
                resend: readBooleanProperty(ctx.body, "resend"),
              });
            }
          }
        }

        if (ctx.path === "/organization/invite-member") {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
          const session = typeof token === "string" ? await cache.auth.session(token) : null;
          const organizationId = readStringProperty(ctx.body, "organizationId")
            ?? (typeof session?.session.activeOrganizationId === "string" ? session.session.activeOrganizationId : null);
          if (organizationId && session?.user.id) {
            await assertBetterAuthInvitationRoleAssignment({
              organizationId,
              userId: session.user.id,
              role: readRoleProperty(ctx.body, "role") ?? ORGANIZATION_MEMBER_ROLE,
            });
            const email = readStringProperty(ctx.body, "email");
            if (email) {
              await assertBetterAuthInvitationRefreshRole({
                organizationId,
                userId: session.user.id,
                email,
                resend: readBooleanProperty(ctx.body, "resend"),
              });
            }
          }
        }

        if (ctx.path === "/organization/set-active") {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
          const session = typeof token === "string" ? await cache.auth.session(token) : null;
          const organizationId = readStringProperty(ctx.body, "organizationId")
            ?? await organizationIdForSlug(readStringProperty(ctx.body, "organizationSlug"));
          if (session && organizationId) {
            const ssoBlock = await findSsoAccessBlock({ sessionId: session.session.id, organizationId });
            if (ssoBlock) {
              throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED", signInPath: ssoBlock.signInPath });
            }
          }
        }

        if (ctx.path === "/sign-in/sso") {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null);
          const session = typeof token === "string" ? await cache.auth.session(token) : null;
          const authorization = await authorizeOrganizationSsoSignIn({
            providerId: readStringProperty(ctx.body, "providerId"),
            organizationSlug: readStringProperty(ctx.body, "organizationSlug"),
            domain: readStringProperty(ctx.body, "domain"),
            email: readStringProperty(ctx.body, "email"),
            callbackUrl: readStringProperty(ctx.body, "callbackURL"),
            userId: session?.user.id ?? null,
          });
          if (!authorization.ok) {
            throw new APIError("FORBIDDEN", { message: authorization.message });
          }
          if (authorization.providerId && !readStringProperty(ctx.body, "providerId") && isRecord(ctx.body)) {
            return { context: { body: { ...ctx.body, providerId: authorization.providerId } } };
          }
        }
      }

      if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email") {
        return;
      }

      const email = getAuthBodyEmail(ctx.body);
      if (ctx.path === "/sign-up/email") {
        const invitationAllowsSignup = await hasPendingInvitationForEmail({
          invitationIdOrToken: readSignUpInvite(ctx),
          email,
        });
        const bootstrapGrant = readInitialAdminBootstrapGrantFromBody(ctx.body);
        const violation = invitationAllowsSignup || bootstrapGrant ? null : await getSingleOrgEmailSignupPolicyViolation(email);
        if (violation) {
          throw new APIError("FORBIDDEN", { message: violation.message });
        }
      }

      if (!email) {
        return;
      }

      const requirement = await findNonSsoSignInBlock({ email });
      if (!requirement) {
        return;
      }

      throw new APIError("FORBIDDEN", {
        message: "This account is managed by an organization. Use SSO to sign in.",
      });
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (env.auditCaptureEnabled && ctx.request && BETTER_AUTH_AUDIT_AFTER_PATHS.has(ctx.path)) {
        try {
          await auditBetterAuthAfter({
            path: ctx.path, request: ctx.request, body: ctx.body, query: ctx.query, params: ctx.params,
            session: async () => readAuditHookSession(await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null)),
            returned: ctx.context.returned,
            newSessionUserId: ctx.context.newSession?.user.id ?? null,
          });
        } catch (error) {
          auditHookLogger.warn("better-auth audit attribution after the endpoint failed", { auth_path: ctx.path, error_name: error instanceof Error ? error.name : typeof error });
        }
      }

      if (env.auditCaptureEnabled && ctx.request && BETTER_AUTH_SESSION_AFTER_PATHS.has(ctx.path)) {
        const request = ctx.request;
        await runAuditHook(ctx.path, () => auditBetterAuthSessionAfter({
          path: ctx.path, request, body: ctx.body, returned: ctx.context.returned,
          sessionUserId: ctx.context.session?.user.id ?? null, sessionId: ctx.context.session?.session.id ?? null,
        }));
      }

      if (ctx.path === "/device/token") {
        const deviceCode = readStringProperty(ctx.body, "device_code");
        if (deviceCode && readStringProperty(ctx.body, "client_id") !== DEN_DESKTOP_DEVICE_CLIENT_ID) {
          clearDeviceSessionOrganization(deviceCode);
        }
        return;
      }

      if (ctx.path === "/sign-in/sso") {
        await setSsoCarryCookie(ctx);
        return;
      }

      if (SSO_SESSION_PATHS.has(ctx.path)) {
        clearSsoCarryCookie(ctx);
      }

      if (ctx.path === "/scim/v2/Users" && ctx.request?.method === "POST") {
        const createdUserId = readStringProperty(ctx.context.returned, "id");
        const organizationId = await scimRequestOrganizationId(ctx.headers?.get("authorization"));
        if (createdUserId && organizationId) {
          await finishScimProvisionedMember({ organizationId, userId: normalizeDenTypeId("user", createdUserId) });
        }
        return;
      }

      if (ctx.path === "/organization/leave") {
        const member = removedMemberIdentity(ctx.context.returned);
        if (member) {
          await deleteOrganizationMemberConnectedAccounts({
            organizationId: member.organizationId,
            orgMembershipId: member.id,
          });
        }
        return;
      }

      if (ctx.path === "/sign-in/email" || ctx.path === "/sign-up/email" || ctx.path === "/sign-in/social") {
        await updateLastSignInCookie(ctx);
        return;
      }

      if (ctx.path === "/sso/callback/:providerId" || ctx.path === "/sso/saml2/sp/acs/:providerId") {
        const callbackUrl = ctx.context.responseHeaders?.get("location") ?? null;
        const intentId = getSsoTestIntentIdFromCallbackUrl(callbackUrl);
        const providerId = readStringProperty(ctx.params, "providerId");
        if (!intentId || !providerId) {
          await updateLastSignInCookie(ctx);
          return;
        }

        const newSession = ctx.context.newSession;
        if (!newSession) {
          await failOrganizationSsoTestAuthentication(intentId);
          return;
        }

        await completeOrganizationSsoTestIntent({
          intentId,
          providerId,
          authenticatedUserId: newSession.user.id,
        });
        await ctx.context.internalAdapter.deleteSession(newSession.session.token);
        await cache.auth.revokeSession(newSession.session.token);
        removeSsoTestSessionCookie(ctx);
        return;
      }

      if (ctx.path !== "/callback/:id") {
        return;
      }

      const newSession = ctx.context.newSession;
      if (!newSession) {
        return;
      }

      const requirement = await findNonSsoSignInBlock({ email: newSession.user.email, userId: newSession.user.id });
      if (!requirement) {
        await provisionVerifiedDomainMembership({
          userId: normalizeDenTypeId("user", newSession.user.id),
          email: newSession.user.email,
          emailVerified: newSession.user.emailVerified === true,
        });
        await updateLastSignInCookie(ctx);
        return;
      }

      await ctx.context.internalAdapter.deleteSession(newSession.session.token);
      await cache.auth.revokeSession(newSession.session.token);
      deleteSessionCookie(ctx);
      throw ctx.redirect(getEnterpriseAuthRedirectUrl({
        signInPath: requirement.signInPath,
        email: newSession.user.email,
        callbackUrl: ctx.context.responseHeaders?.get("location") ?? null,
      }));
    }),
  },
  advanced: {
    cookiePrefix: env.authCookiePrefix,
    ...(env.betterAuthCookieDomain
      ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: env.betterAuthCookieDomain,
        },
      }
      : {}),
    ipAddress: {
      ipAddressHeaders: [RESOLVED_CLIENT_IP_HEADER],
      ipv6Subnet: CLIENT_IP_IPV6_SUBNET,
    },
    database: {
      generateId: (options) => {
        switch (options.model) {
          case "user":
            return createDenTypeId("user");
          case "session":
            return createDenTypeId("session");
          case "account":
            return createDenTypeId("account");
          case "verification":
            return createDenTypeId("verification");
          case "apikey":
          case "apiKey":
            return createDenTypeId("apiKey");
          case "oauthClient":
            return createDenTypeId("oauthClient");
          case "oauthAccessToken":
            return createDenTypeId("oauthAccessToken");
          case "oauthRefreshToken":
            return createDenTypeId("oauthRefreshToken");
          case "oauthConsent":
            return createDenTypeId("oauthConsent");
          case "oauthResource":
          case "oauthClientResource":
          case "oauthClientAssertion":
            return crypto.randomUUID();
          case "rateLimit":
            return createDenTypeId("rateLimit");
          case "deviceCode":
            return createDenTypeId("deviceCode");
          case "organization":
            return createDenTypeId("organization");
          case "member":
            return createDenTypeId("member");
          case "invitation":
            return createDenTypeId("invitation");
          case "team":
            return createDenTypeId("team");
          case "teamMember":
            return createDenTypeId("teamMember");
          case "organizationRole":
            return createDenTypeId("organizationRole");
          case "scimProvider":
            return createDenTypeId("scimProvider");
          case "scimGroup":
            return createDenTypeId("scimGroup");
          case "scimGroupMember":
            return createDenTypeId("scimGroupMember");
          case "scimGroupRole":
            return createDenTypeId("scimGroupRole");
          case "scimGroupRoleGrant":
            return createDenTypeId("scimGroupRoleGrant");
          case "ssoProvider":
            return createDenTypeId("ssoProvider");
          case "ssoConnection":
            return createDenTypeId("ssoConnection");
          case "externalIdentity":
            return createDenTypeId("externalIdentity");
          default:
            return false;
        }
      },
    },
  },
  rateLimit: {
    enabled: !env.devMode,
    storage: "database",
    window: 60,
    max: 20,
    customRules: {
      ...Object.fromEntries(DEN_LIMITED_BETTER_AUTH_PATHS.map((path) => [path, false] as const)),
      "/oauth2/token": false,
      "/get-session": {
        window: 60,
        max: 120,
      },
    },
  },
  emailVerification: {
    sendOnSignUp: env.requireEmailVerification,
    sendOnSignIn: env.requireEmailVerification,
    afterEmailVerification: async (user) => {
      await syncDenSignupContact({
        email: user.email,
        name: user.name,
      });
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: env.requireEmailVerification,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      await sendEmail({
        to: user.email,
        template: "passwordReset",
        props: { resetLink: url },
      });
    },
  },
  plugins: [
    jwt(getDenJwtOptions({ issuer: getDenAuthIssuer(env.betterAuthUrl) })),
    emailOTP({
      overrideDefaultEmailVerification: true,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      async sendVerificationOTP({ email, otp, type }) {
        if (type === "email-verification" && await isEmailAlreadyVerified(email)) {
          return;
        }
        await sendEmail({
          to: email,
          template: "verification",
          props: { verificationCode: otp },
        });
      },
    }),
    organization({
      ac: denOrganizationAccess,
      roles: denOrganizationStaticRoles,
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: env.requireEmailVerification,
      teams: {
        enabled: true,
        defaultTeam: {
          enabled: false,
        },
      },
      async sendInvitationEmail(data) {
        await sendEmail({
          to: data.email,
          template: "organizationInvite",
          props: organizationInviteEmailProps({
            inviteLink: buildInvitationLink(data.id),
            inviterName: data.inviter.user.name,
            inviterEmail: data.inviter.user.email,
            inviteeEmail: data.email,
            organizationName: data.organization.name,
            role: data.role,
          }),
        });
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization }) => {
          let metadata: Record<string, unknown>;
          try {
            metadata = readOrganizationMetadata(organization.metadata);
          } catch {
            throw new APIError("BAD_REQUEST", { message: "Organization metadata must be a JSON object." });
          }
          if ("dpaSigned" in metadata) {
            throw new APIError("FORBIDDEN", { message: "dpaSigned is reserved for internal platform administration." });
          }
          if ("plan" in metadata) {
            throw new APIError("FORBIDDEN", { message: "plan is reserved for internal platform administration." });
          }
          if ("capabilities" in metadata) {
            const { capabilities: _ignored, ...retained } = metadata;
            return { data: { metadata: retained } };
          }
        },
        beforeUpdateOrganization: async ({ organization }) => {
          if ("metadata" in organization) {
            throw new APIError("FORBIDDEN", { message: "Use the Den organization settings API to update workspace configuration." });
          }
        },
        beforeCreateTeam: denyBetterAuthTeamMutation,
        beforeUpdateTeam: denyBetterAuthTeamMutation,
        beforeDeleteTeam: denyBetterAuthTeamMutation,
        beforeAddTeamMember: denyBetterAuthTeamMutation,
        beforeRemoveTeamMember: denyBetterAuthTeamMutation,
        beforeAddMember: async ({ member }) => {
          if (readStringProperty(member, "teamId")) {
            await denyBetterAuthTeamMutation();
          }
          const role = typeof member.role === "string" ? member.role : "";
          if (hasRole(role, ORGANIZATION_ADMIN_ROLE)) {
            throw new APIError("FORBIDDEN", {
              message: "Use the Den invitation and member role APIs to grant privileged organization roles.",
            });
          }

          if (hasRole(role, ORGANIZATION_OWNER_ROLE)) {
            const existingMembers = await db.$primary
              .select({ id: schema.MemberTable.id })
              .from(schema.MemberTable)
              .where(eq(schema.MemberTable.organizationId, normalizeDenTypeId("organization", member.organizationId)))
              .limit(1);
            if (existingMembers[0]) {
              throw new APIError("FORBIDDEN", {
                message: "Owner can only be assigned during organization creation or ownership transfer.",
              });
            }
          }
        },
        beforeCreateInvitation: async ({ invitation, inviter }) => {
          if (readStringProperty(invitation, "teamId")) {
            await denyBetterAuthTeamMutation();
          }
          const organizationId = readStringProperty(invitation, "organizationId");
          if (!organizationId) {
            return;
          }

          await assertBetterAuthInvitationRoleAssignment({
            organizationId,
            userId: inviter.id,
            role: readRoleProperty(invitation, "role") ?? ORGANIZATION_MEMBER_ROLE,
          });
        },
        beforeRemoveMember: async ({ member }) => {
          const validation = await validateOrganizationMemberRemovalForHook({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
          });
          if (!validation.ok) {
            throwMemberLifecycleError(validation.message);
          }

          await deleteOrganizationMemberConnectedAccounts({
            organizationId: member.organizationId,
            orgMembershipId: member.id,
          });
          await revokeOrganizationMemberCredentials({
            organizationId: member.organizationId,
            orgMembershipId: member.id,
            userId: member.userId,
            reason: "member_removed",
          });
        },
        beforeUpdateMemberRole: async ({ member, newRole }) => {
          if (hasRole(member.role, "owner")) {
            throw new APIError("BAD_REQUEST", {
              message: "The organization owner role cannot be changed.",
            });
          }

          if (hasRole(newRole, "owner")) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Owner can only be assigned during organization creation.",
            });
          }

          const validation = await validateOrganizationMemberRoleUpdate({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
            nextRole: newRole,
          });
          if (!validation.ok) {
            throwMemberLifecycleError(validation.message);
          }

          if (member.role !== newRole) {
            await revokeOrganizationMemberCredentials({
              organizationId: member.organizationId,
              orgMembershipId: member.id,
              userId: member.userId,
              reason: "member_role_changed",
            });
          }
        },
      },
    }),
    oauthProvider({
      loginPage: env.betterAuthUrl,
      consentPage: `${env.betterAuthUrl}/mcp/select-organization`,
      scopes: [...DEN_MCP_SCOPES],
      validAudiences: DEN_MCP_OAUTH_VALID_AUDIENCES,
      resources: [...DEN_MCP_RESOURCES],
      enforcePerClientResources: false,
      allowPublicClientPrelogin: true,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      codeExpiresIn: DEN_MCP_OAUTH_AUTHORIZATION_EXPIRES_IN_SECONDS,
      accessTokenExpiresIn: DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      m2mAccessTokenExpiresIn: DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      refreshTokenExpiresIn: DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
      refreshTokenReuseInterval: 30,
      storeTokens: { hash: hashOAuthProviderToken },
      clientRegistrationDefaultScopes: [...DEN_MCP_DEFAULT_CLIENT_SCOPES],
      clientRegistrationAllowedScopes: [...DEN_MCP_SCOPES],
      advertisedMetadata: {
        scopes_supported: [...DEN_MCP_SCOPES],
        claims_supported: [
          DEN_MCP_TOKEN_USE_CLAIM,
          DEN_MCP_ORG_ID_CLAIM,
          DEN_MCP_RESOURCE_CLAIM,
          DEN_MCP_GRANT_ID_CLAIM,
        ],
      },
      extensions: [{
        claims: {
          accessToken: async ({ ctx, client, user, referenceId, scopes, grantType, resources }) => {
            const claims = await contributeMcpGrantClaim({
              claimName: DEN_MCP_GRANT_ID_CLAIM,
              clientId: client.clientId,
              userId: user?.id,
              referenceId,
              findConsent: ({ clientId, userId, referenceId: consentReferenceId }) => ctx.context.adapter.findOne<{ id: string }>({
                model: "oauthConsent",
                where: [
                  { field: "clientId", value: clientId },
                  { field: "userId", value: userId },
                  { field: "referenceId", value: consentReferenceId },
                ],
              }),
            });
            const resource = resources?.[0];
            noteOAuthTokenIssuance({
              clientId: client.clientId,
              userId: user?.id ?? null,
              referenceId: referenceId ?? null,
              scopes: [...scopes],
              grantType: typeof grantType === "string" ? grantType : null,
              resource: typeof resource === "string" ? normalizeMcpOAuthResource(resource) : null,
              grantId: claims[DEN_MCP_GRANT_ID_CLAIM] ?? null,
            });
            return claims;
          },
        },
      }],
      postLogin: {
        page: `${env.betterAuthUrl}/mcp/select-organization`,
        shouldRedirect: async ({ session, scopes }) => {
          if (!hasMcpScope(scopes)) {
            return false;
          }

          return !session.activeOrganizationId;
        },
        consentReferenceId: async ({ session, scopes }) => {
          if (!hasMcpScope(scopes)) {
            return undefined;
          }

          const activeOrganizationId = typeof session.activeOrganizationId === "string"
            ? session.activeOrganizationId
            : undefined;
          if (!activeOrganizationId) {
            throw new APIError("BAD_REQUEST", {
              message: "Select an organization before authorizing MCP access.",
            });
          }

          const referenceId = normalizeDenTypeId("organization", activeOrganizationId);
          const ssoBlock = await findSsoAccessBlock({ sessionId: typeof session.id === "string" ? normalizeDenTypeId("session", session.id) : null, organizationId: referenceId });
          if (ssoBlock) {
            throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE });
          }
          if (typeof session.userId === "string") noteOAuthConsentReference({ userId: session.userId, referenceId });
          return referenceId;
        },
      },
      customAccessTokenClaims: ({ referenceId, resources, scopes }) => {
        const claims: Record<string, string> = {};
        const resource = resources?.[0];
        const mcpResource = typeof resource === "string" ? normalizeMcpOAuthResource(resource) : null;
        if (hasMcpScope(scopes) || mcpResource) {
          claims[DEN_MCP_TOKEN_USE_CLAIM] = "mcp";
          claims[DEN_MCP_RESOURCE_CLAIM] = mcpResource ?? DEN_MCP_OAUTH_RESOURCE;
        }
        if (referenceId) {
          claims[DEN_MCP_ORG_ID_CLAIM] = referenceId;
        }
        return claims;
      },
      prefix: {
        opaqueAccessToken: DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
        refreshToken: DEN_MCP_REFRESH_TOKEN_PREFIX,
        clientSecret: "ow_mcp_cs_",
      },
    }),
    {
      id: "cimd",
      init(ctx) {
        extendOAuthProvider(ctx, {
          clientDiscovery: withLoopbackRedirectRelaxation(createCimdClientDiscovery({
            originBoundFields: ["post_logout_redirect_uris", "client_uri"],
            fetchClientMetadataResource: fetchCimdMetadataResource,
            isMetadataDocumentUrlAllowed: (url) => isCimdClientIdUrlAllowed(url),
            onClientCreated: ({ client }) => {
              logger.info("Registered MCP client from its client ID metadata document", {
                clientId: client.clientId,
                clientName: client.name ?? null,
              });
            },
          })),
        });
      },
    },
    scim({
      linkExistingUsers: {
        shouldLinkUser: createScimExistingUserLinkCheck(isUserKnownToScimOrganization),
      },
      mapGroupToRoles: () => [],
      storeSCIMToken: SCIM_TOKEN_STORAGE_STRATEGY,
      requiredRole: [ORGANIZATION_OWNER_ROLE, ORGANIZATION_SUPER_ADMIN_ROLE, ORGANIZATION_ADMIN_ROLE],
      beforeSCIMTokenGenerated: async ({ member }) => {
        if (!member?.organizationId || !member.userId) {
          throw new APIError("FORBIDDEN", {
            message: "SCIM connections must belong to an organization.",
          });
        }

        const permissions = await resolveBetterAuthActorPermissions({
          organizationId: member.organizationId,
          userId: member.userId,
        });

        if (!permissions?.has("scim.manage")) {
          throw new APIError("FORBIDDEN", {
            message: "You don't have permission to manage SCIM provisioning. Ask the organization owner.",
          });
        }
      },
    }),
    sso({
      providersLimit: 1000,
      provisionUserOnEveryLogin: true,
      domainVerification: {
        enabled: true,
        tokenPrefix: SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX,
      },
      organizationProvisioning: {
        disabled: true,
      },
      saml: {
        enableInResponseToValidation: true,
        allowIdpInitiated: ORGANIZATION_SAML_ALLOW_IDP_INITIATED,
        requireTimestamps: ORGANIZATION_SAML_REQUIRE_TIMESTAMPS,
        algorithms: {
          onDeprecated: ORGANIZATION_SAML_DEPRECATED_ALGORITHM_BEHAVIOR,
        },
      },
      provisionUser: async ({ user, userInfo, provider }) => {
        if (!provider.organizationId) {
          return;
        }

        const now = new Date();
        const remoteId = pickRemoteIdentity(userInfo);
        const displayName = maybeString(userInfo.name) ?? maybeString(userInfo.displayName) ?? maybeString(user.name);
        const email = maybeString(userInfo.email) ?? maybeString(user.email);
        const organizationId = normalizeDenTypeId("organization", provider.organizationId);
        const userId = normalizeDenTypeId("user", user.id);
        if (await isScimDeprovisionedIdentity({ organizationId, userId, email })) {
          throw new APIError("FORBIDDEN", { message: SCIM_DEPROVISIONED_SIGN_IN_MESSAGE });
        }
        const payload = {
          organizationId,
          userId,
          source: "sso",
          ssoProviderId: provider.providerId,
          remoteId,
          userName: maybeString(userInfo.preferred_username) ?? email,
          email,
          displayName,
          attributesJson: userInfo,
          active: true,
          lastSsoLoginAt: now,
        };

        await db
          .insert(schema.ExternalIdentityTable)
          .values({
            id: createDenTypeId("externalIdentity"),
            ...payload,
          })
          .onDuplicateKeyUpdate({
            set: {
              source: sql<string>`case when ${schema.ExternalIdentityTable.scimProviderId} is null then 'sso' else 'scim+sso' end`,
              ssoProviderId: payload.ssoProviderId,
              remoteId: payload.remoteId,
              userName: payload.userName,
              email: payload.email,
              displayName: payload.displayName,
              attributesJson: payload.attributesJson,
              active: payload.active,
              lastSsoLoginAt: payload.lastSsoLoginAt,
            },
          });

        const membership = await provisionSsoMembership({ organizationId, userId, email });
        if (membership === "invitation_required") {
          throw new APIError("FORBIDDEN", { message: SSO_INVITATION_REQUIRED_MESSAGE });
        }
      },
    }),
    deviceAuthorization({
      expiresIn: DEN_DEVICE_CODE_EXPIRES_IN,
      interval: DEN_DEVICE_CODE_POLL_INTERVAL,
      verificationUri: `${env.betterAuthUrl}/device`,
      validateClient: (clientId) => isDenDeviceClientId(clientId),
    }),
    apiKey({
      defaultPrefix: DEN_API_KEY_DEFAULT_PREFIX,
      enableMetadata: true,
      enableSessionForAPIKeys: true,
      maximumNameLength: 64,
      requireName: true,
      disableKeyHashing: false,
      storage: "database",
      keyExpiration: {
        defaultExpiresIn: DEN_API_KEY_EXPIRES_IN_SECONDS,
        disableCustomExpiresTime: true,
        minExpiresIn: 1,
        maxExpiresIn: DEN_API_KEY_EXPIRES_IN_DAYS,
      },
      rateLimit: {
        enabled: true,
        maxRequests: env.apiKeyRateLimitMax,
        timeWindow: DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
      },
    }),
  ],
});
