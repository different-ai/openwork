/**
 * Member credential sets: each person signs in to the upstream cloud with their
 * own account. One place for what each sign-in method needs from the set and
 * what makes a member's stored credential usable.
 *
 *   google     Google OAuth client (Vertex)                          oauth_google
 *   microsoft  Entra ID tenant + confidential app registration (Foundry)  oauth_azure
 *   aws_sso    IAM Identity Center instance, account, permission set (Bedrock)  aws_sso
 */
import { isDeepStrictEqual } from "node:util"
import { GatewayCredentialSetTable, GatewayProviderCredentialTable } from "@openwork-ee/den-db/schema"
import { GATEWAY_MEMBER_SIGN_IN_CREDENTIAL_KINDS, gatewayAwsSsoSettingsSchema, gatewayMemberSignInMethod, microsoftTenantIdSchema, type GatewayAwsSsoSettings, type GatewayMemberSignInMethod, type InferenceProviderSecret } from "@openwork/types/den/inference"
import { googleOAuthClientBinding } from "./inference-provider-google-oauth.js"

type CredentialSet = Pick<typeof GatewayCredentialSetTable.$inferSelect, "id" | "oauth_client_id" | "oauth_client_secret" | "oauth_tenant_id" | "aws_sso">
type Credential = Pick<typeof GatewayProviderCredentialTable.$inferSelect, "kind" | "expires_at" | "last_error">

export { gatewayMemberSignInMethod }
export type { GatewayMemberSignInMethod }

/** Sign-in methods behind the gatewayCloudSignIn feature. */
export function isCloudSignInMethod(method: GatewayMemberSignInMethod | null): method is "aws_sso" | "microsoft" {
  return method === "aws_sso" || method === "microsoft"
}

export function memberSignInCredentialKind(method: GatewayMemberSignInMethod) {
  return GATEWAY_MEMBER_SIGN_IN_CREDENTIAL_KINDS[method]
}

export function readAwsSsoSettings(value: unknown): GatewayAwsSsoSettings | null {
  const parsed = gatewayAwsSsoSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** What an administrator still has to enter before members can sign in, or null when the set is complete. */
export function memberSignInConfigurationError(method: GatewayMemberSignInMethod, set: Omit<CredentialSet, "id">): string | null {
  switch (method) {
    case "google":
      return set.oauth_client_id?.trim() && set.oauth_client_secret?.trim() ? null : "Member credential sets require a non-empty Google OAuth client ID and secret."
    case "microsoft":
      if (!set.oauth_tenant_id || !microsoftTenantIdSchema.safeParse(set.oauth_tenant_id).success) return "Microsoft Foundry member sets require the Entra ID directory (tenant) ID, a GUID."
      return set.oauth_client_id?.trim() && set.oauth_client_secret?.trim() ? null : "Microsoft Foundry member sets require the Entra ID application (client) ID and a client secret."
    case "aws_sso":
      return readAwsSsoSettings(set.aws_sso) ? null : "Amazon Bedrock member sets require the AWS access portal URL, IAM Identity Center region, AWS account ID and permission set name."
  }
}

/** Fields of a set that do not belong to its sign-in method. */
export function memberSignInExtraneousFields(method: GatewayMemberSignInMethod | null, set: Omit<CredentialSet, "id">): string | null {
  if (method !== "microsoft" && set.oauth_tenant_id) return "Only Microsoft Foundry member sets take an Entra ID tenant."
  if (method !== "aws_sso" && set.aws_sso) return "Only Amazon Bedrock member sets take IAM Identity Center settings."
  if (method === "aws_sso" && (set.oauth_client_id || set.oauth_client_secret)) return "Amazon Bedrock sets register their own IAM Identity Center client; remove the OAuth client."
  return null
}

/** True when two versions of a set would hand members the same upstream identity. */
export function sameMemberSignInConfiguration(a: Omit<CredentialSet, "id">, b: Omit<CredentialSet, "id">) {
  return a.oauth_client_id === b.oauth_client_id && a.oauth_client_secret === b.oauth_client_secret
    && (a.oauth_tenant_id ?? null) === (b.oauth_tenant_id ?? null) && isDeepStrictEqual(a.aws_sso ?? null, b.aws_sso ?? null)
}

/**
 * Binds a browser entry attempt to the set's sign-in configuration, so a change
 * while someone is signing in invalidates the attempt. Google keeps its original
 * binding; the others are namespaced by method.
 */
export function memberSignInBinding(method: GatewayMemberSignInMethod, set: CredentialSet, verifier: string): string | null {
  if (memberSignInConfigurationError(method, set)) return null
  switch (method) {
    case "google":
      return googleOAuthClientBinding(verifier, set.oauth_client_id ?? "", set.oauth_client_secret ?? "")
    case "microsoft":
      return googleOAuthClientBinding(verifier, `microsoft:${set.oauth_tenant_id?.toLowerCase()}:${set.oauth_client_id}`, set.oauth_client_secret ?? "")
    case "aws_sso":
      return googleOAuthClientBinding(verifier, `aws_sso:${JSON.stringify(readAwsSsoSettings(set.aws_sso))}`, set.id)
  }
}

/** A member's stored credential can serve requests now or after a silent renewal. */
export function memberSignInCredentialUsable(method: GatewayMemberSignInMethod, set: Omit<CredentialSet, "id">, credential: Credential, parsed: InferenceProviderSecret, now = Date.now()): boolean {
  if (memberSignInConfigurationError(method, set)) return false
  const expiry = credential.expires_at?.getTime()
  if (expiry === undefined || !Number.isFinite(expiry)) return false
  switch (method) {
    case "google":
      return parsed.kind === "oauth_google" && credential.last_error !== "invalid_client" && Boolean(parsed.token.refreshToken)
    case "microsoft":
      return parsed.kind === "oauth_azure" && credential.last_error !== "invalid_client" && Boolean(parsed.token.refreshToken)
        && parsed.token.microsoftIdentity?.tenantId.toLowerCase() === set.oauth_tenant_id?.toLowerCase()
        && parsed.token.microsoftIdentity?.clientId === set.oauth_client_id
    case "aws_sso":
      return parsed.kind === "aws_sso" && isDeepStrictEqual(parsed.awsSso.sso, readAwsSsoSettings(set.aws_sso))
        && parsed.awsSso.clientSecretExpiresAt * 1000 > now
  }
}

/** The person-facing name of what they sign in with. */
export function memberSignInBrand(method: GatewayMemberSignInMethod) {
  return method === "google" ? "Google" : method === "microsoft" ? "Microsoft" : "AWS"
}
