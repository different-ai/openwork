import { getInitialActiveOrganizationIdForUser } from "./active-organization.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { appLogger } from "./observability/logger.js";
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
} from "./organization-access.js";
import {
  getOrganizationSsoJitRole,
  ORGANIZATION_SSO_JIT_ROLE,
} from "./sso-jit.js";
import {
  ORGANIZATION_SAML_ALLOW_IDP_INITIATED,
  ORGANIZATION_SAML_DEPRECATED_ALGORITHM_BEHAVIOR,
  ORGANIZATION_SAML_REQUIRE_TIMESTAMPS,
} from "./sso-saml-policy.js";
import {
  getOrganizationContextForUser,
  reconcilePendingInvitationsForUser,
  seedDefaultOrganizationRoles,
  validateOrganizationMemberRemovalForHook,
  validateOrganizationMemberRoleUpdate,
} from "./orgs.js";
import {
  findEnterpriseAuthRequirementForEmail,
  findEnterpriseAuthRequirementForUserId,
} from "./enterprise-auth-requirement.js";
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
import { and, eq, sql } from "@openwork-ee/den-db/drizzle";
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
export const DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX = "ow_mcp_at_";
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
  return roleValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(roleName);
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
}

function throwMemberLifecycleError(message: string): never {
  throw new APIError("BAD_REQUEST", { message });
}

function getBodyEmail(body: unknown) {
  if (!body || typeof body !== "object") {
    return null;
  }

  const value = Object.getOwnPropertyDescriptor(body, "email")?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
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

      if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-up/email") {
        return;
      }

      const email = getBodyEmail(ctx.body);
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
      deleteSessionCookie(ctx);
      throw ctx.redirect(getEnterpriseAuthRedirectUrl({
        signInPath: requirement.signInPath,
        email: newSession.user.email,
        callbackUrl: ctx.context.responseHeaders?.get("location") ?? null,
      }));
    }),
  },
  advanced: {
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
      allowPublicClientPrelogin: true,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      accessTokenExpiresIn: DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      m2mAccessTokenExpiresIn: DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      refreshTokenExpiresIn: DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
      clientRegistrationDefaultScopes: [...DEN_MCP_DEFAULT_CLIENT_SCOPES],
      clientRegistrationAllowedScopes: [...DEN_MCP_SCOPES],
      advertisedMetadata: {
        scopes_supported: [...DEN_MCP_SCOPES],
        claims_supported: [
          DEN_MCP_TOKEN_USE_CLAIM,
          DEN_MCP_ORG_ID_CLAIM,
          DEN_MCP_RESOURCE_CLAIM,
        ],
      },
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
      customAccessTokenClaims: ({ referenceId, resource, scopes }) => {
        const claims: Record<string, string> = {};
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
        refreshToken: "ow_mcp_rt_",
        clientSecret: "ow_mcp_cs_",
      },
    }),
    scim({
      storeSCIMToken: SCIM_TOKEN_STORAGE_STRATEGY,
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
            message: "Only workspace owners or members with security configuration permission can manage SCIM.",
          });
        }
      },
    }),
    sso({
      providersLimit: 1000,
      provisionUserOnEveryLogin: true,
      domainVerification: {
        enabled: true,
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
        const payload = {
          organizationId: normalizeDenTypeId("organization", provider.organizationId),
          userId: normalizeDenTypeId("user", user.id),
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
