/**
 * AWS IAM Identity Center (SSO) for per-member Amazon Bedrock credentials.
 *
 * Den runs the OAuth device authorization flow against the organization's own
 * Identity Center instance (no client is registered ahead of time: each sign-in
 * registers a public OIDC client, as the AWS CLI does) and stores the resulting
 * refresh token. The Gateway renews the access token and exchanges it for
 * short-lived role credentials of the configured account and permission set,
 * which then sign Bedrock requests with SigV4. Only these AWS hosts are ever
 * reached, all derived from a validated region:
 *
 *   oidc.<region>.amazonaws.com          RegisterClient, StartDeviceAuthorization, CreateToken
 *   portal.sso.<region>.amazonaws.com    GetRoleCredentials, Logout
 *   sts.<region>.amazonaws.com           GetCallerIdentity (who signed in)
 */
import { signAwsRequest, type AwsCredentials } from "./aws-sigv4.js"
import { isAwsRegion } from "./inference-egress.js"

export const AWS_SSO_SCOPE = "sso:account:access"
export const AWS_SSO_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const REQUEST_TIMEOUT_MS = 15_000
const tokenMaterial = /^[\x21-\x7e]+$/

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type AwsSsoErrorCode =
  | "aws_sso_unreachable"
  | "aws_sso_unavailable"
  | "aws_sso_invalid_response"
  | "aws_sso_authorization_pending"
  | "aws_sso_slow_down"
  | "aws_sso_access_denied"
  | "aws_sso_expired"
  | "aws_sso_invalid_grant"
  | "aws_sso_invalid_client"
  | "aws_sso_invalid_request"
  | "aws_sso_unauthorized"
  | "aws_sso_role_forbidden"

export class AwsSsoError extends Error {
  constructor(readonly code: AwsSsoErrorCode, message: string, readonly status?: number) {
    super(message)
    this.name = "AwsSsoError"
  }

  /** Worth retrying later with the same token: AWS or the network had a problem. */
  get transient() {
    return this.code === "aws_sso_unreachable" || this.code === "aws_sso_unavailable" || this.code === "aws_sso_slow_down"
  }
}

export function awsSsoOidcHost(region: string) {
  if (!isAwsRegion(region)) throw new AwsSsoError("aws_sso_invalid_request", "Invalid IAM Identity Center region.")
  return `oidc.${region}.amazonaws.com`
}

export function awsSsoPortalHost(region: string) {
  if (!isAwsRegion(region)) throw new AwsSsoError("aws_sso_invalid_request", "Invalid IAM Identity Center region.")
  return `portal.sso.${region}.amazonaws.com`
}

export function awsStsHost(region: string) {
  if (!isAwsRegion(region)) throw new AwsSsoError("aws_sso_invalid_request", "Invalid AWS region.")
  return `sts.${region}.amazonaws.com`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readToken(value: unknown, max = 16_384): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && tokenMaterial.test(value) ? value : null
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

async function send(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<{ status: number; body: unknown; errorType: string | null; text: string }> {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new AwsSsoError("aws_sso_unreachable", "IAM Identity Center could not be reached.")
  }
  const text = await response.text().catch(() => "")
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  // AWS JSON errors name the exception in x-amzn-ErrorType ("Name:http://…") and/or the body.
  const errorType = response.headers.get("x-amzn-errortype")?.split(":")[0] ?? (isRecord(body) && typeof body.__type === "string" ? body.__type.split("#").pop() ?? null : null)
  return { status: response.status, body, errorType, text }
}

/** Map an OIDC (RegisterClient, StartDeviceAuthorization, CreateToken) error to a stable code. */
function oidcError(result: { status: number; body: unknown; errorType: string | null }): AwsSsoError {
  const error = isRecord(result.body) && typeof result.body.error === "string" ? result.body.error : null
  const type = result.errorType ?? ""
  const has = (oauth: string, exception: string) => error === oauth || type === exception
  if (has("authorization_pending", "AuthorizationPendingException")) return new AwsSsoError("aws_sso_authorization_pending", "Waiting for approval in the browser.", result.status)
  if (has("slow_down", "SlowDownException")) return new AwsSsoError("aws_sso_slow_down", "Waiting for approval in the browser.", result.status)
  if (has("access_denied", "AccessDeniedException")) return new AwsSsoError("aws_sso_access_denied", "The AWS sign-in was denied.", result.status)
  if (has("expired_token", "ExpiredTokenException")) return new AwsSsoError("aws_sso_expired", "The AWS sign-in code expired. Start again.", result.status)
  if (has("invalid_grant", "InvalidGrantException")) return new AwsSsoError("aws_sso_invalid_grant", "AWS no longer accepts this sign-in. Sign in again.", result.status)
  if (has("invalid_client", "InvalidClientException") || has("unauthorized_client", "UnauthorizedClientException")) return new AwsSsoError("aws_sso_invalid_client", "AWS no longer accepts this sign-in. Sign in again.", result.status)
  if (result.status === 429 || result.status >= 500 || type === "InternalServerException") return new AwsSsoError("aws_sso_unavailable", "IAM Identity Center is temporarily unavailable. Try again shortly.", result.status)
  return new AwsSsoError("aws_sso_invalid_request", "IAM Identity Center rejected the request. Check the start URL and region.", result.status)
}

async function oidc(fetchImpl: FetchLike, region: string, path: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const result = await send(fetchImpl, `https://${awsSsoOidcHost(region)}${path}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal,
  })
  if (result.status < 200 || result.status >= 300) throw oidcError(result)
  if (!isRecord(result.body)) throw new AwsSsoError("aws_sso_invalid_response", "IAM Identity Center returned an invalid response.", result.status)
  return result.body
}

export type AwsSsoClient = { clientId: string; clientSecret: string; clientSecretExpiresAt: number }

/** RegisterClient: a public OIDC client that may request refresh tokens for account access. */
export async function registerAwsSsoClient(input: { region: string; clientName: string; fetchImpl: FetchLike; signal?: AbortSignal }): Promise<AwsSsoClient> {
  const body = await oidc(input.fetchImpl, input.region, "/client/register", { clientName: input.clientName, clientType: "public", scopes: [AWS_SSO_SCOPE] }, input.signal)
  const clientId = readToken(body.clientId, 4096)
  const clientSecret = readToken(body.clientSecret)
  const clientSecretExpiresAt = readPositiveInt(body.clientSecretExpiresAt)
  if (!clientId || !clientSecret || !clientSecretExpiresAt) throw new AwsSsoError("aws_sso_invalid_response", "IAM Identity Center returned an invalid client registration.")
  return { clientId, clientSecret, clientSecretExpiresAt }
}

export type AwsSsoDeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

/** Only AWS-owned sign-in pages may be shown to the person as the place to approve. */
export function isAwsSsoVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && /(?:^|\.)(?:amazonaws\.com|awsapps\.com|app\.aws|aws\.amazon\.com)$/i.test(url.hostname)
  } catch { return false }
}

export async function startAwsSsoDeviceAuthorization(input: { region: string; client: AwsSsoClient; startUrl: string; fetchImpl: FetchLike; signal?: AbortSignal }): Promise<AwsSsoDeviceAuthorization> {
  const body = await oidc(input.fetchImpl, input.region, "/device_authorization", { clientId: input.client.clientId, clientSecret: input.client.clientSecret, startUrl: input.startUrl }, input.signal)
  const deviceCode = readToken(body.deviceCode)
  const userCode = typeof body.userCode === "string" && /^[A-Za-z0-9-]{1,64}$/.test(body.userCode) ? body.userCode : null
  const verificationUri = typeof body.verificationUri === "string" && isAwsSsoVerificationUrl(body.verificationUri) ? body.verificationUri : null
  const complete = typeof body.verificationUriComplete === "string" && isAwsSsoVerificationUrl(body.verificationUriComplete) ? body.verificationUriComplete : verificationUri
  const expiresIn = readPositiveInt(body.expiresIn)
  const interval = readPositiveInt(body.interval) ?? 5
  if (!deviceCode || !userCode || !verificationUri || !complete || !expiresIn) throw new AwsSsoError("aws_sso_invalid_response", "IAM Identity Center returned an invalid device authorization.")
  return { deviceCode, userCode, verificationUri, verificationUriComplete: complete, expiresIn: Math.min(expiresIn, 900), interval: Math.min(Math.max(interval, 1), 30) }
}

export type AwsSsoTokens = { accessToken: string; refreshToken: string | null; expiresIn: number }

function readTokens(body: Record<string, unknown>): AwsSsoTokens {
  const accessToken = readToken(body.accessToken)
  const refreshToken = body.refreshToken === undefined || body.refreshToken === null ? null : readToken(body.refreshToken)
  const expiresIn = readPositiveInt(body.expiresIn)
  const tokenType = body.tokenType
  if (!accessToken || (body.refreshToken !== undefined && body.refreshToken !== null && !refreshToken) || !expiresIn || expiresIn > 7 * 86_400
    || (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"))) {
    throw new AwsSsoError("aws_sso_invalid_response", "IAM Identity Center returned an invalid token.")
  }
  return { accessToken, refreshToken, expiresIn }
}

/** CreateToken with the device code; throws aws_sso_authorization_pending until the person approves. */
export async function createAwsSsoTokenFromDevice(input: { region: string; client: AwsSsoClient; deviceCode: string; fetchImpl: FetchLike; signal?: AbortSignal }): Promise<AwsSsoTokens> {
  return readTokens(await oidc(input.fetchImpl, input.region, "/token", { clientId: input.client.clientId, clientSecret: input.client.clientSecret, grantType: AWS_SSO_DEVICE_GRANT, deviceCode: input.deviceCode }, input.signal))
}

/** CreateToken with the refresh token. AWS may rotate the refresh token; keep the old one when it does not. */
export async function refreshAwsSsoToken(input: { region: string; client: AwsSsoClient; refreshToken: string; fetchImpl: FetchLike; signal?: AbortSignal }): Promise<AwsSsoTokens> {
  return readTokens(await oidc(input.fetchImpl, input.region, "/token", { clientId: input.client.clientId, clientSecret: input.client.clientSecret, grantType: "refresh_token", refreshToken: input.refreshToken }, input.signal))
}

export type AwsRoleCredentials = Required<AwsCredentials> & { expiration: Date }

/** GetRoleCredentials: short-lived keys for the account and permission set, valid for the permission set's session duration. */
export async function getAwsSsoRoleCredentials(input: { region: string; accessToken: string; accountId: string; roleName: string; fetchImpl: FetchLike; signal?: AbortSignal }): Promise<AwsRoleCredentials> {
  const url = new URL(`https://${awsSsoPortalHost(input.region)}/federation/credentials`)
  url.searchParams.set("role_name", input.roleName)
  url.searchParams.set("account_id", input.accountId)
  const result = await send(input.fetchImpl, url.toString(), { method: "GET", headers: { accept: "application/json", "x-amz-sso_bearer_token": input.accessToken }, signal: input.signal })
  if (result.status === 401 || result.errorType === "UnauthorizedException") throw new AwsSsoError("aws_sso_unauthorized", "AWS no longer accepts this sign-in. Sign in again.", result.status)
  // An account or permission set the person is not assigned reads as not found.
  if (result.status === 403 || result.status === 404 || result.errorType === "ForbiddenException" || result.errorType === "ResourceNotFoundException") {
    throw new AwsSsoError("aws_sso_role_forbidden", "Your AWS user is not assigned this permission set in this account. Ask your administrator to assign it in IAM Identity Center.", result.status)
  }
  if (result.status === 429 || result.status >= 500) throw new AwsSsoError("aws_sso_unavailable", "IAM Identity Center is temporarily unavailable. Try again shortly.", result.status)
  if (result.status < 200 || result.status >= 300) throw new AwsSsoError("aws_sso_invalid_request", "IAM Identity Center rejected the request for role credentials. Ask your administrator to check the account ID and permission set.", result.status)
  const credentials = isRecord(result.body) && isRecord(result.body.roleCredentials) ? result.body.roleCredentials : null
  const accessKeyId = credentials && typeof credentials.accessKeyId === "string" && /^[A-Z0-9]{16,128}$/.test(credentials.accessKeyId) ? credentials.accessKeyId : null
  const secretAccessKey = credentials ? readToken(credentials.secretAccessKey, 1024) : null
  const sessionToken = credentials ? readToken(credentials.sessionToken, 16_384) : null
  const expiration = credentials ? readPositiveInt(credentials.expiration) : null
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new AwsSsoError("aws_sso_invalid_response", "IAM Identity Center returned invalid role credentials.")
  return { accessKeyId, secretAccessKey, sessionToken, expiration: new Date(expiration) }
}

/** Logout: ends the Identity Center session of this access token. Best effort; never throws. */
export async function logoutAwsSso(input: { region: string; accessToken: string; fetchImpl: FetchLike; signal?: AbortSignal }): Promise<boolean> {
  try {
    const result = await send(input.fetchImpl, `https://${awsSsoPortalHost(input.region)}/logout`, { method: "POST", headers: { "x-amz-sso_bearer_token": input.accessToken }, signal: input.signal ?? AbortSignal.timeout(5_000) })
    return result.status >= 200 && result.status < 300
  } catch { return false }
}

export type AwsCallerIdentity = { arn: string; account: string; userName: string | null }

/** The role session name of an Identity Center role is the person's user name. */
export function awsSsoUserNameFromArn(arn: string): string | null {
  const match = /^arn:aws[a-z-]*:sts::\d{12}:assumed-role\/[^/]+\/(.+)$/.exec(arn)
  const name = match?.[1]
  return name && name.length <= 320 ? name : null
}

/** STS GetCallerIdentity with the role credentials: proves they work and names who signed in. */
export async function getAwsCallerIdentity(input: { region: string; credentials: AwsCredentials; fetchImpl: FetchLike; now?: Date; signal?: AbortSignal }): Promise<AwsCallerIdentity> {
  const url = new URL(`https://${awsStsHost(input.region)}/`)
  const body = "Action=GetCallerIdentity&Version=2011-06-15"
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json" })
  signAwsRequest({ method: "POST", url, headers, body, credentials: input.credentials, region: input.region, service: "sts", now: input.now ?? new Date() })
  const result = await send(input.fetchImpl, url.toString(), { method: "POST", headers, body, signal: input.signal })
  if (result.status === 429 || result.status >= 500) throw new AwsSsoError("aws_sso_unavailable", "AWS STS is temporarily unavailable. Try again shortly.", result.status)
  if (result.status < 200 || result.status >= 300) throw new AwsSsoError("aws_sso_role_forbidden", "AWS did not accept the credentials for this permission set.", result.status)
  const json = isRecord(result.body) && isRecord(result.body.GetCallerIdentityResponse) && isRecord(result.body.GetCallerIdentityResponse.GetCallerIdentityResult)
    ? result.body.GetCallerIdentityResponse.GetCallerIdentityResult : null
  const arn = typeof json?.Arn === "string" ? json.Arn : /<Arn>([^<]+)<\/Arn>/.exec(result.text)?.[1] ?? null
  const account = typeof json?.Account === "string" ? json.Account : /<Account>(\d{12})<\/Account>/.exec(result.text)?.[1] ?? null
  if (!arn || arn.length > 2048 || !account || !/^\d{12}$/.test(account)) throw new AwsSsoError("aws_sso_invalid_response", "AWS STS returned an invalid identity.")
  return { arn, account, userName: awsSsoUserNameFromArn(arn) }
}
