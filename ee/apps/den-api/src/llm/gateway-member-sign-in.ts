import { isDeepStrictEqual } from "node:util"
import { GatewayCredentialSetTable, GatewayProviderCredentialTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { liteLlmEntraScope } from "@openwork-ee/gateway-catalog"
import { GATEWAY_MEMBER_SIGN_IN_CREDENTIAL_KINDS, gatewayAwsSsoSettingsSchema, gatewayMemberSignInMethod, microsoftTenantIdSchema, type GatewayAwsSsoSettings, type GatewayMemberSignInMethod, type InferenceProviderSecret } from "@openwork/types/den/inference"
import { googleOAuthClientBinding } from "./inference-provider-google-oauth.js"

type CredentialSet = Pick<typeof GatewayCredentialSetTable.$inferSelect, "id" | "oauth_client_id" | "oauth_client_secret" | "oauth_tenant_id" | "aws_sso">
type Credential = Pick<typeof GatewayProviderCredentialTable.$inferSelect, "kind" | "expires_at" | "last_error">
type SignInProvider = Pick<typeof GatewayProviderTable.$inferSelect, "provider_id" | "settings">

export type { GatewayMemberSignInMethod }

export function providerMemberSignInScope(provider: SignInProvider): string | null {
  return liteLlmEntraScope(provider)
}

export function providerMemberSignInMethod(provider: SignInProvider): GatewayMemberSignInMethod | null {
  return gatewayMemberSignInMethod(provider.provider_id, { liteLlmEntraSignIn: providerMemberSignInScope(provider) !== null })
}

export function memberSignInCredentialKind(method: GatewayMemberSignInMethod) {
  return GATEWAY_MEMBER_SIGN_IN_CREDENTIAL_KINDS[method]
}

export function readAwsSsoSettings(value: unknown): GatewayAwsSsoSettings | null {
  const parsed = gatewayAwsSsoSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function memberSignInConfigurationError(method: GatewayMemberSignInMethod, set: Omit<CredentialSet, "id">, scope: string | null = null): string | null {
  switch (method) {
    case "google":
      return set.oauth_client_id?.trim() && set.oauth_client_secret?.trim() ? null : "Member credential sets require a non-empty Google OAuth client ID and secret."
    case "microsoft": {
      const product = scope === null ? "Microsoft Foundry" : "LiteLLM"
      if (!set.oauth_tenant_id || !microsoftTenantIdSchema.safeParse(set.oauth_tenant_id).success) return `${product} member sets require the Entra ID directory (tenant) ID, a GUID.`
      return set.oauth_client_id?.trim() && set.oauth_client_secret?.trim() ? null : `${product} member sets require the Entra ID application (client) ID and a client secret.`
    }
    case "aws_sso":
      return readAwsSsoSettings(set.aws_sso) ? null : "Amazon Bedrock member sets require the AWS access portal URL, IAM Identity Center region, AWS account ID and permission set name."
  }
}

export function memberSignInExtraneousFields(method: GatewayMemberSignInMethod | null, set: Omit<CredentialSet, "id">): string | null {
  if (method !== "microsoft" && set.oauth_tenant_id) return "Only Microsoft Foundry member sets take an Entra ID tenant."
  if (method !== "aws_sso" && set.aws_sso) return "Only Amazon Bedrock member sets take IAM Identity Center settings."
  if (method === "aws_sso" && (set.oauth_client_id || set.oauth_client_secret)) return "Amazon Bedrock sets register their own IAM Identity Center client; remove the OAuth client."
  return null
}

export function sameMemberSignInConfiguration(a: Omit<CredentialSet, "id">, b: Omit<CredentialSet, "id">) {
  return a.oauth_client_id === b.oauth_client_id && a.oauth_client_secret === b.oauth_client_secret
    && (a.oauth_tenant_id ?? null) === (b.oauth_tenant_id ?? null) && isDeepStrictEqual(a.aws_sso ?? null, b.aws_sso ?? null)
}

export function memberSignInBinding(method: GatewayMemberSignInMethod, set: CredentialSet, verifier: string, scope: string | null = null): string | null {
  if (memberSignInConfigurationError(method, set, scope)) return null
  switch (method) {
    case "google":
      return googleOAuthClientBinding(verifier, set.oauth_client_id ?? "", set.oauth_client_secret ?? "")
    case "microsoft": {
      const tenant = set.oauth_tenant_id?.toLowerCase()
      return googleOAuthClientBinding(verifier, scope === null ? `microsoft:${tenant}:${set.oauth_client_id}` : `microsoft:${JSON.stringify([tenant, set.oauth_client_id, scope])}`, set.oauth_client_secret ?? "")
    }
    case "aws_sso":
      return googleOAuthClientBinding(verifier, `aws_sso:${JSON.stringify(readAwsSsoSettings(set.aws_sso))}`, set.id)
  }
}

export function memberSignInCredentialUsable(method: GatewayMemberSignInMethod, set: Omit<CredentialSet, "id">, credential: Credential, parsed: InferenceProviderSecret, now = Date.now(), scope: string | null = null): boolean {
  if (memberSignInConfigurationError(method, set, scope)) return false
  const expiry = credential.expires_at?.getTime()
  if (expiry === undefined || !Number.isFinite(expiry)) return false
  switch (method) {
    case "google":
      return parsed.kind === "oauth_google" && credential.last_error !== "invalid_client" && Boolean(parsed.token.refreshToken)
    case "microsoft":
      return parsed.kind === "oauth_azure" && credential.last_error !== "invalid_client" && Boolean(parsed.token.refreshToken)
        && parsed.token.microsoftIdentity?.tenantId.toLowerCase() === set.oauth_tenant_id?.toLowerCase()
        && parsed.token.microsoftIdentity?.clientId === set.oauth_client_id
        && (parsed.token.microsoftIdentity?.scope ?? null) === scope
    case "aws_sso":
      return parsed.kind === "aws_sso" && isDeepStrictEqual(parsed.awsSso.sso, readAwsSsoSettings(set.aws_sso))
        && parsed.awsSso.clientSecretExpiresAt * 1000 > now
  }
}

export function memberSignInBrand(method: GatewayMemberSignInMethod) {
  return method === "google" ? "Google" : method === "microsoft" ? "Microsoft" : "AWS"
}
