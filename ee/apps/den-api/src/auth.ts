import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy";
import { revokeMemberGatewayCredentials } from "./llm/inference-provider-lifecycle.js";
import { coreHooks, mergeCoreHookRecords, type CoreBootContributorPoints, type CoreRawMutationDenial } from "./core/hooks/index.js";
import { getInitialActiveOrganizationIdForUser } from "./active-organization.js";
import { maybeString, readStringProperty } from "./better-auth-values.js";
import { db } from "./db.js";
import { checkMemberAddEligibility } from "./member-add-eligibility.js";
import type { MemberAddPath } from "./member-add-eligibility-config.js";
import { resolveOrganizationMemberAuthority } from "./organization-team-roles.js";
import { env } from "./env.js";
import { appLogger } from "./observability/logger.js";
import { getDenAuthIssuer, getDenJwtOptions } from "./mcp/jwt-policy.js";
import {
  DEN_SESSION_EXPIRES_IN_SECONDS,
  DEN_SESSION_UPDATE_AGE_IN_SECONDS,
} from "./session-lifetime.js";
import { DEN_ACCOUNT_CONFIG } from "./account-linking-policy.js";
import { cache } from "./cache.js";
import { SCIM_TOKEN_STORAGE_STRATEGY } from "./scim-token-storage.js";
import { createScimExistingUserLinkCheck } from "./scim-existing-user-linking.js";
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
import { isScimDeprovisionedEmailForSsoProvider, isScimDeprovisionedIdentity, SCIM_DEPROVISIONED_SIGN_IN_MESSAGE } from "./scim-deprovisioning.js";
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
import { deviceAuthorization, emailOTP, jwt, organization } from "better-auth/plugins";
import {
  DEN_DEVICE_CODE_EXPIRES_IN,
  DEN_DEVICE_CODE_POLL_INTERVAL,
  clearDeviceSessionOrganization,
  isDenDeviceClientId,
  stageDeviceSessionOrganization,
  takeDeviceSessionOrganization,
} from "./device-authorization.js";

const logger = appLogger.child({ component: "auth" });

export {
  DEN_MCP_FIRST_PARTY_CLIENT_ID,
  DEN_MCP_FIRST_PARTY_RESOURCES,
  DEN_MCP_GRANT_ID_CLAIM,
  DEN_MCP_LEGACY_PARENT_RESOURCES,
  DEN_MCP_OAUTH_RESOURCE,
  DEN_MCP_OAUTH_VALID_AUDIENCES,
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_RESOURCE,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_RESOURCES,
  DEN_MCP_TOKEN_USE_CLAIM,
  normalizeMcpOAuthResource,
} from "./mcp/oauth-resources.js";
export { DEN_MCP_SCOPES } from "./mcp/scopes.js";

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

// Which member-add path a Better Auth adapter insert belongs to. Creating an
// organization adds its first member, the owner, which never needs a seat check.
function memberAddPathForBetterAuthRequest(path: string | null): MemberAddPath | null {
  if (path === "/organization/create") {
    return null;
  }
  if (path?.startsWith("/scim/v2/")) {
    return "scim";
  }
  if (path?.startsWith("/sso/callback/") || path?.startsWith("/sso/saml2/")) {
    return "sso_jit";
  }
  return "better_auth_other";
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

// Raw Better Auth endpoints Den replaces with its own APIs. Modules
// contribute theirs through core/hooks (auth.rawMutationDenials); a duplicate
// path fails the boot.
const CORE_RAW_BETTER_AUTH_MUTATION_DENIALS: readonly CoreRawMutationDenial[] = [
  { path: "/organization/update", message: "Use the Den organization settings API to update workspace configuration." },
  { path: "/organization/delete", message: "Workspace deletion through Better Auth is disabled." },
  { path: "/organization/update-member-role", message: "Use the Den member role API to change organization roles." },
  { path: "/organization/remove-member", message: "Use the Den member API to remove organization members." },
  { path: "/organization/add-member", message: "Use the Den invitation API to add members." },
  { path: "/organization/invite-member", message: "Use the Den invitation API to invite members." },
  { path: "/organization/cancel-invitation", message: "Use the Den invitation API to cancel invitations." },
  { path: "/organization/accept-invitation", message: "Use the Den invitation API to accept invitations." },
  { path: "/api-key/create", message: "Use the Den API key API to manage organization API keys." },
  { path: "/api-key/update", message: "Use the Den API key API to manage organization API keys." },
  { path: "/api-key/delete", message: "Use the Den API key API to manage organization API keys." },
];

const RAW_BETTER_AUTH_MUTATION_DENIALS: ReadonlyMap<string, string> = new Map(Object.entries(mergeCoreHookRecords(
  "auth.rawMutationDenials",
  [CORE_RAW_BETTER_AUTH_MUTATION_DENIALS, ...coreHooks.collectBoot("auth.rawMutationDenials")]
    .flat()
    .map((denial) => ({ [denial.path]: denial.message })),
)));

export function getRawBetterAuthMutationDenial(path: string) {
  const message = RAW_BETTER_AUTH_MUTATION_DENIALS.get(path);
  if (message === undefined) {
    return null;
  }
  return {
    error: "forbidden",
    message,
  };
}

async function denyBetterAuthTeamMutation() {
  throw new APIError("FORBIDDEN", { message: "Use the Den teams API to manage teams and their membership." });
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
  const authority = await resolveOrganizationMemberAuthority({
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    memberId: member.id,
  });
  if (!authority) return null;
  return {
    role: authority.directRole,
    adminTeams: authority.adminTeams,
    isOwner: hasRole(authority.directRole, ORGANIZATION_OWNER_ROLE),
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

const BETTER_AUTH_MODEL_ID_GENERATORS: ReadonlyMap<string, () => string> = new Map(Object.entries(mergeCoreHookRecords("auth.modelIds", [
  {
    user: () => createDenTypeId("user"),
    session: () => createDenTypeId("session"),
    account: () => createDenTypeId("account"),
    verification: () => createDenTypeId("verification"),
    apikey: () => createDenTypeId("apiKey"),
    apiKey: () => createDenTypeId("apiKey"),
    rateLimit: () => createDenTypeId("rateLimit"),
    deviceCode: () => createDenTypeId("deviceCode"),
    organization: () => createDenTypeId("organization"),
    member: () => createDenTypeId("member"),
    invitation: () => createDenTypeId("invitation"),
    organizationRole: () => createDenTypeId("organizationRole"),
  },
  ...coreHooks.collectBoot("auth.modelIds"),
])));

const RESERVED_ORGANIZATION_METADATA_KEYS = (() => {
  const fragments = coreHooks.collectBoot("org.reservedMetadataKeys");
  return {
    keys: fragments.flatMap((fragment) => fragment.keys ?? []),
    capabilityKeys: fragments.flatMap((fragment) => fragment.capabilityKeys ?? []),
    droppedCapabilityKeys: fragments.flatMap((fragment) => fragment.droppedCapabilityKeys ?? []),
  };
})();

function mergeBootFragments<P extends "betterAuth.orgHooks" | "oauth.providerConfig">(point: P): CoreBootContributorPoints[P] {
  const merged: CoreBootContributorPoints[P] = {};
  for (const fragment of coreHooks.collectBoot(point)) {
    const collision = Object.keys(fragment).find((key) => key in merged);
    if (collision) {
      throw new Error(`core_hook_contribution_collision: ${point} key "${collision}" is contributed twice`);
    }
    Object.assign(merged, fragment);
  }
  return merged;
}

const contributedPlugins = coreHooks.collectBoot("betterAuth.plugins").flat();
const contributedOAuthProviderConfig = mergeBootFragments("oauth.providerConfig");
const contributedOrganizationHooks = mergeBootFragments("betterAuth.orgHooks");

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  onAPIError: {
    // OAuth authorization errors that cannot be returned to the client
    // (unknown client, unregistered redirect URI, malformed request) and the
    // other Better Auth error redirects land on Den web's branded page instead
    // of Better Auth's built-in card (or, in production, a bare `/?error=`).
    errorURL: `${env.betterAuthUrl}/connect/error`,
  },
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
        before: async (user, context) => {
          const email = normalizeLoginEmail(user.email);
          // SSO callbacks (/sso/callback/:providerId, /sso/saml2/sp/acs/:providerId)
          // create the user before provisionUser runs, so refuse a SCIM-deprovisioned
          // email here or the refused sign-in leaves a ghost user, session, and membership.
          const ssoProviderId = readStringProperty(context?.params, "providerId");
          if (ssoProviderId && await isScimDeprovisionedEmailForSsoProvider({ ssoProviderId, email })) {
            throw new APIError("FORBIDDEN", { message: SCIM_DEPROVISIONED_SIGN_IN_MESSAGE });
          }
          return {
            data: {
              ...user,
              email,
            },
          };
        },
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
    teamMember: {
      delete: {
        before: async (membership: typeof schema.TeamMemberTable.$inferSelect) => {
          await db.transaction((tx) => coreHooks.runTx("team.membershipChanged", { tx, organizationId: null, teamId: membership.teamId }));
        },
      },
    },
    team: {
      delete: {
        before: async (team: typeof schema.TeamTable.$inferSelect) => {
          await db.transaction((tx) => coreHooks.runTx("team.membershipChanged", { tx, organizationId: team.organizationId, teamId: team.id }));
        },
      },
    },
    member: {
      create: {
        // SCIM provisioning, SSO JIT and any other Better Auth adapter insert
        // (W0-05 PR D: observe by default, DEN_MEMBER_ADD_ELIGIBILITY_*).
        before: async (member: Pick<AuthMemberHookRow, "organizationId">, context: { path?: string } | null | undefined) => {
          const path = memberAddPathForBetterAuthRequest(context?.path ?? null);
          if (!path) {
            return;
          }
          const rejection = await checkMemberAddEligibility({ organizationId: member.organizationId, path, netNewSeats: 1 });
          if (rejection) {
            throw new APIError("FORBIDDEN", { message: rejection.message });
          }
        },
        after: async (member: AuthMemberHookRow) => {
          await coreHooks.runPostCommit("member.added", {
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
            source: "betterAuthAdapter",
            userId: member.userId ?? null,
            removedAt: member.removedAt ?? null,
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
          });
          await revokeMemberGatewayCredentials({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
          });
        },
        after: async (member: AuthMemberHookRow) => {
          await revokeMemberGatewayCredentials({
            organizationId: normalizeDenTypeId("organization", member.organizationId),
            memberId: normalizeDenTypeId("member", member.id),
          });
        },
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          const userId = normalizeDenTypeId("user", session.userId);
          const deviceCode = context?.path === "/device/token" ? readStringProperty(context.body, "device_code") : null;
          const deviceOrganizationId = deviceCode
            ? await takeDeviceSessionOrganization({ deviceCode, userId })
            : null;
          const activeOrganizationId = deviceOrganizationId ?? await getInitialActiveOrganizationIdForUser(userId);
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
      if (ctx.path === "/device/token") {
        const deviceCode = readStringProperty(ctx.body, "device_code");
        if (deviceCode) {
          await stageDeviceSessionOrganization(deviceCode);
        }
      }

      if (ctx.path === "/oauth2/authorize") {
        const clientId = maybeString(ctx.query?.client_id);
        if (clientId) {
          await coreHooks.runMiddleware("oauth.firstPartyClients", { clientId, adapter: ctx.context.adapter });
        }
      }

      await coreHooks.runMiddleware("auth.beforePath", { ctx, isRequest: Boolean(ctx.request) });

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
            if (member?.adminTeams.length && !hasRole(member.role, ORGANIZATION_SUPER_ADMIN_ROLE)) {
              throw new APIError("FORBIDDEN", {
                message: "Ask a workspace owner or super-admin to remove your Admin team membership before leaving.",
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

      const rejection = await coreHooks.runGuards("auth.signInEnforcement", { stage: "credentialSignIn", email });
      if (rejection) {
        throw new APIError("FORBIDDEN", { message: rejection.message });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/device/token") {
        const deviceCode = readStringProperty(ctx.body, "device_code");
        if (deviceCode) {
          clearDeviceSessionOrganization(deviceCode);
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

      await coreHooks.runMiddleware("auth.afterPath", { ctx });

      if (ctx.path !== "/callback/:id") {
        return;
      }

      const newSession = ctx.context.newSession;
      if (!newSession) {
        return;
      }

      const rejection = await coreHooks.runGuards("auth.signInEnforcement", { stage: "socialCallback", userId: newSession.user.id });
      if (!rejection) {
        return;
      }
      const signInPath = rejection.details?.signInPath;

      await ctx.context.internalAdapter.deleteSession(newSession.session.token);
      // Enterprise auth rejection deletes the just-created session outside hooks in some adapters.
      await cache.auth.revokeSession(newSession.session.token);
      deleteSessionCookie(ctx);
      throw ctx.redirect(getEnterpriseAuthRedirectUrl({
        signInPath: typeof signInPath === "string" ? signInPath : "/",
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
      trustedProxies: env.trustedProxies,
      ipv6Subnet: 64,
    },
    database: {
      generateId: (options) => BETTER_AUTH_MODEL_ID_GENERATORS.get(options.model)?.() ?? false,
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
        beforeCreateOrganization: async ({ organization }) => {
          let metadata: Record<string, unknown>;
          try {
            metadata = readOrganizationMetadata(organization.metadata);
          } catch {
            throw new APIError("BAD_REQUEST", { message: "Organization metadata must be a JSON object." });
          }
          const reservedKey = RESERVED_ORGANIZATION_METADATA_KEYS.keys.find((key) => key in metadata);
          if (reservedKey) {
            throw new APIError("FORBIDDEN", { message: `${reservedKey} is reserved for internal platform administration.` });
          }
          const capabilities = metadata.capabilities;
          const reservedCapability = capabilities && typeof capabilities === "object"
            ? RESERVED_ORGANIZATION_METADATA_KEYS.capabilityKeys.find((key) => key in capabilities)
            : undefined;
          if (reservedCapability) {
            throw new APIError("FORBIDDEN", { message: `capabilities.${reservedCapability} is reserved for internal platform administration.` });
          }
          if (capabilities && typeof capabilities === "object" && RESERVED_ORGANIZATION_METADATA_KEYS.droppedCapabilityKeys.some((key) => key in capabilities)) {
            const retainedCapabilities = Object.fromEntries(
              Object.entries(capabilities).filter(([key]) => !RESERVED_ORGANIZATION_METADATA_KEYS.droppedCapabilityKeys.includes(key)),
            );
            return { data: { metadata: { ...metadata, capabilities: retainedCapabilities } } };
          }
        },
        beforeUpdateOrganization: async ({ organization }) => {
          // A replacement without dpaSigned can erase it just as easily as an explicit false.
          if ("metadata" in organization) {
            throw new APIError("FORBIDDEN", { message: "Use the Den organization settings API to update workspace configuration." });
          }
        },
        ...contributedOrganizationHooks,
        afterCreateOrganization: async ({ organization }) => {
          const organizationId = normalizeDenTypeId("organization", organization.id);
          await seedDefaultOrganizationRoles(organizationId);
          await coreHooks.runPostCommit("org.created", { organizationId, ownerMemberId: null, source: "betterAuth" });
        },
        beforeAddMember: async ({ member }) => {
          if (readStringProperty(member, "teamId")) {
            await denyBetterAuthTeamMutation();
          }
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
          // Defense in depth: raw /organization/invite-member is denied over HTTP.
          const seatRejection = await checkMemberAddEligibility({ organizationId, path: "better_auth_invitation", netNewSeats: 1 });
          if (seatRejection) {
            throw new APIError("FORBIDDEN", { message: seatRejection.message });
          }
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
      ...contributedOAuthProviderConfig,
    }),
    // Contributed plugins (core/hooks: betterAuth.plugins), in contribution
    // order: CIMD client discovery today.
    ...contributedPlugins,
    scim({
      linkExistingUsers: {
        requireExistingOrgMembership: true,
        shouldLinkUser: createScimExistingUserLinkCheck((where) => db
          .select({ id: schema.MemberTable.id })
          .from(schema.MemberTable)
          .where(where)
          .limit(1)),
      },
      // Group names are metadata, never organization role assignments.
      mapGroupToRoles: () => [],
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
      },
    }),
    // RFC 8628 device authorization for `openwork-bootstrap login`: the CLI
    // shows a code, the person approves it on Den web's /device page, and the
    // CLI receives a Den session token. No password ever reaches the CLI.
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
        maxRequests: DEN_API_KEY_RATE_LIMIT_MAX,
        timeWindow: DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
      },
    }),
  ],
});
