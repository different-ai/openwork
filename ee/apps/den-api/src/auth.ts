import * as crypto from "node:crypto";
import { getInitialActiveOrganizationIdForUser } from "./active-organization.js";
import { db } from "./db.js";
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
  DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
} from "./mcp/token-lifetime.js";
import {
  DEN_SESSION_EXPIRES_IN_SECONDS,
  DEN_SESSION_UPDATE_AGE_IN_SECONDS,
} from "./session-lifetime.js";
import { DEN_ACCOUNT_CONFIG } from "./account-linking-policy.js";
import { cache } from "./cache.js";
import { SCIM_TOKEN_STORAGE_STRATEGY } from "./scim-token-storage.js";
import { syncDenSignupContact } from "./loops.js";
import { sendEmail } from "./utils/email/send-email.js";
import {
  DEN_API_KEY_DEFAULT_PREFIX,
  DEN_API_KEY_EXPIRES_IN_DAYS,
  DEN_API_KEY_EXPIRES_IN_SECONDS,
  DEN_API_KEY_RATE_LIMIT_MAX,
  DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
  revokeOrganizationApiKeysForMember,
} from "./api-keys.js";
import { revokeMembershipSessionCredentials } from "./credential-revocation.js";
import {
  canManageSecurityConfiguration,
  denOrganizationAccess,
  denOrganizationStaticRoles,
  validateInvitationRoleAssignment,
} from "./organization-access.js";
import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_SUPER_ADMIN_ROLE,
  normalizeOrganizationRoleName,
  organizationRoleValueIncludes,
  splitOrganizationRoles,
} from "./organization-role-hierarchy.js";
import {
  getOrganizationSsoJitRole,
  ORGANIZATION_SSO_JIT_ROLE,
} from "./sso-jit.js";
import { isScimDeprovisionedIdentity } from "./scim-deprovisioning.js";
import {
  ORGANIZATION_SAML_ALLOW_IDP_INITIATED,
  ORGANIZATION_SAML_DEPRECATED_ALGORITHM_BEHAVIOR,
  ORGANIZATION_SAML_REQUIRE_TIMESTAMPS,
} from "./sso-saml-policy.js";
import { SSO_DOMAIN_VERIFICATION_TOKEN_PREFIX } from "./sso-domain-verification.js";
import {
  getOrganizationContextForUser,
  listAssignableRoles,
  reconcilePendingInvitationsForUser,
  seedDefaultOrganizationRoles,
  validateOrganizationMemberRemovalForHook,
  validateOrganizationMemberRoleUpdate,
} from "./orgs.js";
import {
  findEnterpriseAuthRequirementForEmail,
  findEnterpriseAuthRequirementForUserId,
} from "./enterprise-auth-requirement.js";
import { normalizeLoginEmail } from "./auth-login-options.js";
import { getAuthBodyEmail, getSingleOrgEmailSignupPolicyViolation } from "./single-org-signup-policy.js";
import { readInitialAdminBootstrapGrantFromBody } from "./initial-admin-bootstrap.js";
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid";
import * as schema from "@openwork-ee/den-db/schema";
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { deleteSessionCookie } from "better-auth/cookies";
import { and, eq, gt, sql } from "@openwork-ee/den-db/drizzle";
import { emailOTP, jwt, organization } from "better-auth/plugins";

const logger = appLogger.child({ component: "auth" });

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
  // Audience compatibility: tokens issued before the proxied default carry
  // the bare-origin resource (`<betterAuthUrl>/mcp`); keep accepting them.
  `${env.betterAuthUrl}/mcp`,
  // Auto-trust the public API origin so multi-origin clients work without extra config.
  ...DEN_API_PUBLIC_MCP_RESOURCES,
  ...env.mcpAdditionalResources,
  ...localMcpResourceAliases(DEN_MCP_RESOURCE),
  ...DEN_API_PUBLIC_MCP_RESOURCES.flatMap((resource) => localMcpResourceAliases(resource)),
  ...env.mcpAdditionalResources.flatMap((resource) => localMcpResourceAliases(resource)),
];
export const DEN_MCP_LEGACY_PARENT_RESOURCES = Array.from(new Set(DEN_MCP_BASE_RESOURCES));
export const DEN_MCP_FIRST_PARTY_RESOURCES = Array.from(new Set([
  ...DEN_MCP_BASE_RESOURCES,
  // rmcp uses the configured concrete endpoint as the OAuth resource during
  // token exchange. Accept the two registered child endpoints as aliases of
  // their canonical parent resource.
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
const INVALID_MCP_SESSION_GRANT_DESCRIPTION = "The authorization backing this grant has been revoked. Re-authorize the connection.";
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
}) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId);
  const orgMembershipId = normalizeDenTypeId("member", input.orgMembershipId);
  const userId = input.userId ? normalizeDenTypeId("user", input.userId) : null;

  await revokeOrganizationApiKeysForMember({
    organizationId,
    orgMembershipId,
    userId,
  });
  await revokeMembershipSessionCredentials({
    organizationId,
    userId,
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
  ["/organization/create-role", "Use the Den roles API to manage organization roles."],
  ["/organization/update-role", "Use the Den roles API to manage organization roles."],
  ["/organization/delete-role", "Use the Den roles API to manage organization roles."],
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
      error_description: INVALID_MCP_SESSION_GRANT_DESCRIPTION,
    });
  }
}

async function assertBetterAuthInvitationRoleAssignment(input: {
  organizationId: string;
  userId: string;
  role: string;
}) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId);
  const context = await getOrganizationContextForUser({
    organizationId,
    userId: normalizeDenTypeId("user", input.userId),
  });
  if (!context) {
    throw new APIError("FORBIDDEN", {
      message: "Only organization members can assign invitation roles.",
    });
  }

  const validation = validateInvitationRoleAssignment({
    role: input.role || ORGANIZATION_MEMBER_ROLE,
    availableRoles: await listAssignableRoles(organizationId),
    currentMember: context.currentMember,
    roles: context.roles,
  });
  if (!validation.ok) {
    throw new APIError(validation.error === "invalid_role" ? "BAD_REQUEST" : "FORBIDDEN", {
      message: validation.message,
    });
  }
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

  const organizationId = normalizeDenTypeId("organization", input.organizationId);
  const context = await getOrganizationContextForUser({
    organizationId,
    userId: normalizeDenTypeId("user", input.userId),
  });
  if (!context) {
    throw new APIError("FORBIDDEN", {
      message: "Only organization members can refresh invitation roles.",
    });
  }

  const invitations = await db
    .select({ role: schema.InvitationTable.role })
    .from(schema.InvitationTable)
    .where(and(
      eq(schema.InvitationTable.organizationId, organizationId),
      eq(schema.InvitationTable.email, input.email.trim().toLowerCase()),
      eq(schema.InvitationTable.status, "pending"),
      gt(schema.InvitationTable.expiresAt, new Date()),
    ))
    .limit(1);

  const invitation = invitations[0] ?? null;
  if (!invitation) {
    return;
  }

  const validation = validateInvitationRoleAssignment({
    role: invitation.role,
    availableRoles: await listAssignableRoles(organizationId),
    currentMember: context.currentMember,
    roles: context.roles,
  });
  if (!validation.ok) {
    throw new APIError(validation.error === "invalid_role" ? "BAD_REQUEST" : "FORBIDDEN", {
      message: validation.message,
    });
  }
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
  return {
    role: member.role,
    isOwner: member.isOwner,
  };
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

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins:
    env.betterAuthTrustedOrigins.length > 0
      ? env.betterAuthTrustedOrigins
      : undefined,
  socialProviders:
    Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
  database: drizzleAdapter(db, {
    provider: "mysql",
    schema,
  }),
  account: DEN_ACCOUNT_CONFIG,
  session: {
    expiresIn: DEN_SESSION_EXPIRES_IN_SECONDS,
    updateAge: DEN_SESSION_UPDATE_AGE_IN_SECONDS,
    freshAge: 15 * 60,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            ...user,
            email: normalizeLoginEmail(user.email),
          },
        }),
      },
      update: {
        before: async (user) => ({
          data: typeof user.email === "string"
            ? {
              ...user,
              email: normalizeLoginEmail(user.email),
            }
            : user,
        }),
        after: async (user) => {
          if (typeof user.id === "string") {
            // User profile changes can stale cached auth payloads; clear all sessions here.
            await cache.auth.deleteSessionsForUser(normalizeDenTypeId("user", user.id));
          }
        },
      },
    },
    member: {
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
          });
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const userId = normalizeDenTypeId("user", session.userId);
          const activeOrganizationId = await getInitialActiveOrganizationIdForUser(userId);
          try {
            // SSO JIT creates the raw member row before the session row, so this
            // chokepoint can merge any matching pending invitation without blocking sign-in.
            await reconcilePendingInvitationsForUser(userId);
          } catch (error) {
            logger.error("invitation reconcile failed", { user_id: userId, error });
          }

          return {
            data: {
              ...session,
              activeOrganizationId,
            },
          };
        },
      },
      update: {
        after: async (session) => {
          if (typeof session.token === "string") {
            // Better Auth session updates are the explicit invalidation point for cached sessions.
            await cache.auth.deleteSession(session.token);
          }
          if (typeof session.id === "string") {
            await cache.auth.deleteSessionId(normalizeDenTypeId("session", session.id));
          }
        },
      },
      delete: {
        after: async (session) => {
          if (typeof session.token === "string") {
            // Sign-out deletes the backing session row, so cached hits must be cleared here.
            await cache.auth.revokeSession(session.token);
          }
          if (typeof session.id === "string") {
            await cache.auth.revokeSessionId(normalizeDenTypeId("session", session.id));
          }
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await assertLiveMcpSessionForRefreshGrant(ctx);

      if (ctx.path === "/oauth2/authorize") {
        const clientId = maybeString(ctx.query?.client_id);
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
          throw new APIError("FORBIDDEN", { message: deniedMutation.message });
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
      }

      if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email") {
        return;
      }

      const email = getAuthBodyEmail(ctx.body);
      if (ctx.path === "/sign-up/email") {
        const invitationAllowsSignup = await hasPendingInvitationForEmail({
          invitationIdOrToken: readRequestQueryParam(ctx.request, "invite") ?? readStringProperty(ctx.query, "invite") ?? readStringProperty(ctx.body, "invite"),
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

      const requirement = await findEnterpriseAuthRequirementForEmail(email);
      if (!requirement) {
        return;
      }

      throw new APIError("FORBIDDEN", {
        message: "This account is managed by an organization. Use SSO to sign in.",
      });
    }),
    after: createAuthMiddleware(async (ctx) => {
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

      if (ctx.path !== "/callback/:id") {
        return;
      }

      const newSession = ctx.context.newSession;
      if (!newSession) {
        return;
      }

      const requirement = await findEnterpriseAuthRequirementForUserId(newSession.user.id);
      if (!requirement) {
        return;
      }

      await ctx.context.internalAdapter.deleteSession(newSession.session.token);
      // Enterprise auth rejection deletes the just-created session outside hooks in some adapters.
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
    cookiePrefix: "openwork-den",
    ...(env.betterAuthCookieDomain
      ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: env.betterAuthCookieDomain,
        },
      }
      : {}),
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"],
      ipv6Subnet: 64,
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
          // better-auth 1.7 oauth-provider models with no den typeid: without
          // an id the drizzle adapter emits `insert ... values (default, ...)`
          // and MySQL rejects it (no default on `id`) — the oauthResource seed
          // storm of 2026-08-07. oauthClientResource/oauthClientAssertion use
          // forceAllowId, but cover them for any future non-forced create.
          case "oauthResource":
          case "oauthClientResource":
          case "oauthClientAssertion":
            return crypto.randomUUID();
          case "rateLimit":
            return createDenTypeId("rateLimit");
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
      "/sign-in/email": {
        window: 300,
        max: 5,
      },
      "/sign-up/email": {
        window: 3600,
        max: env.devMode ? 100 : 5,
      },
      "/email-otp/send-verification-otp": {
        window: 3600,
        max: 5,
      },
      "/email-otp/verify-email": {
        window: 300,
        max: 10,
      },
      "/oauth2/token": false,
      "/request-password-reset": {
        window: 3600,
        max: 5,
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
      dynamicAccessControl: {
        enabled: true,
      },
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
          props: {
            inviteLink: buildInvitationLink(data.id),
            invitedByName: data.inviter.user.name ?? data.inviter.user.email,
            invitedByEmail: data.inviter.user.email,
            organizationName: data.organization.name,
            role: data.role,
          },
        });
      },
      organizationHooks: {
        afterCreateOrganization: async ({ organization }) => {
          await seedDefaultOrganizationRoles(
            normalizeDenTypeId("organization", organization.id),
          );
        },
        beforeAddMember: async ({ member }) => {
          const role = typeof member.role === "string" ? member.role : "";
          if (hasRole(role, ORGANIZATION_SUPER_ADMIN_ROLE)) {
            throw new APIError("FORBIDDEN", {
              message: "Use the Den invitation and member role APIs to grant privileged organization roles.",
            });
          }

          if (hasRole(role, ORGANIZATION_OWNER_ROLE)) {
            const existingMembers = await db
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
      // better-auth 1.7 gates every token-request `resource` parameter on the
      // oauthResource registry (invalid_target "is not configured" otherwise;
      // validAudiences no longer whitelists issuance). Seed all accepted MCP
      // resource aliases at startup — seeding is idempotent (insertOnly).
      resources: [...DEN_MCP_RESOURCES],
      // 1.7 defaults to requiring an oauthClientResource link per client per
      // resource. Dynamically registered MCP clients never request resources
      // at registration, so enforcement would invalid_target every DCR client.
      // Keep pre-1.7 behavior: registry + audience validation, no per-client ACL.
      enforcePerClientResources: false,
      allowPublicClientPrelogin: true,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
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
          accessToken: ({ ctx, client, user, referenceId }) => contributeMcpGrantClaim({
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
          }),
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

          return normalizeDenTypeId("organization", activeOrganizationId);
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
      // Better Auth refresh-family teardown and /oauth2/revoke intentionally do
      // not remove durable consent. Already minted JWT exposure remains bounded
      // by the configured 45-minute MCP access-token lifetime.
      prefix: {
        opaqueAccessToken: DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
        refreshToken: DEN_MCP_REFRESH_TOKEN_PREFIX,
        clientSecret: "ow_mcp_cs_",
      },
    }),
    scim({
      storeSCIMToken: SCIM_TOKEN_STORAGE_STRATEGY,
      requiredRole: [ORGANIZATION_OWNER_ROLE, ORGANIZATION_SUPER_ADMIN_ROLE, ORGANIZATION_ADMIN_ROLE],
      beforeSCIMTokenGenerated: async ({ member }) => {
        if (!member?.organizationId || !member.userId) {
          throw new APIError("FORBIDDEN", {
            message: "SCIM connections must belong to an organization.",
          });
        }

        const organizationContext = await getOrganizationContextForUser({
          organizationId: normalizeDenTypeId("organization", member.organizationId),
          userId: normalizeDenTypeId("user", member.userId),
        });

        if (!canManageSecurityConfiguration(organizationContext)) {
          throw new APIError("FORBIDDEN", {
            message: "Only workspace owners and super-admins can manage SCIM.",
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
        disabled: false,
        defaultRole: ORGANIZATION_SSO_JIT_ROLE,
        getRole: getOrganizationSsoJitRole,
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
          throw new APIError("FORBIDDEN", {
            message: "This user was deprovisioned by SCIM. Reactivate them in the identity provider before signing in.",
          });
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
      },
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
        maxRequests: DEN_API_KEY_RATE_LIMIT_MAX,
        timeWindow: DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
      },
    }),
  ],
});
