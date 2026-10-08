/**
 * Member IAM Identity Center sign-in for Amazon Bedrock (device authorization).
 * Den registers a public OIDC client with the organization's Identity Center,
 * shows the person AWS's own approval page and code, and polls for the token.
 * Before storing anything it proves the sign-in works for the set's account and
 * permission set: it fetches role credentials and asks STS who they belong to.
 */
import { randomBytes } from "node:crypto"
import { z } from "zod"
import {
  AwsSsoError,
  createAwsSsoTokenFromDevice,
  getAwsCallerIdentity,
  getAwsSsoRoleCredentials,
  logoutAwsSso,
  registerAwsSsoClient,
  startAwsSsoDeviceAuthorization,
  type AwsSsoClient,
  type FetchLike,
} from "@openwork-ee/utils/aws-identity-center"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import type { GatewayAwsSsoSettings, InferenceAwsSsoSecret } from "@openwork/types/den/inference"

const CLIENT_NAME = "OpenWork AI Gateway"

let egressFetch: FetchLike | null = null
/** AWS hosts are public; the guarded transport still refuses private addresses and redirects. */
export function awsSsoFetch(): FetchLike {
  egressFetch ??= createInferenceEgressFetch({ allowedOrigins: new Set() })
  return egressFetch
}

/** The pending device sign-in, kept in the encrypted attempt row for at most ten minutes. */
export const awsSsoAttemptSchema = z.object({
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  userId: z.string().min(1),
  clientBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  aws: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    clientSecretExpiresAt: z.number().int().positive(),
    deviceCode: z.string().min(1),
    userCode: z.string().min(1),
    verificationUri: z.string().min(1),
    verificationUriComplete: z.string().min(1),
    interval: z.number().int().min(1).max(60),
    nextPollAt: z.number().int().nonnegative(),
  }),
})
export type AwsSsoAttempt = z.infer<typeof awsSsoAttemptSchema>

export function readAwsSsoAttempt(value: string): AwsSsoAttempt | null {
  try { return awsSsoAttemptSchema.parse(JSON.parse(value)) } catch { return null }
}

export async function startAwsSsoSignIn(input: { sso: GatewayAwsSsoSettings; fetchImpl?: FetchLike; now?: number }) {
  const fetchImpl = input.fetchImpl ?? awsSsoFetch()
  const client = await registerAwsSsoClient({ region: input.sso.region, clientName: CLIENT_NAME, fetchImpl })
  const device = await startAwsSsoDeviceAuthorization({ region: input.sso.region, client, startUrl: input.sso.startUrl, fetchImpl })
  const now = input.now ?? Date.now()
  return {
    device,
    aws: { ...client, deviceCode: device.deviceCode, userCode: device.userCode, verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete, interval: device.interval, nextPollAt: now + device.interval * 1000 },
  }
}

export type AwsSsoPollResult =
  | { kind: "pending"; slowDown: boolean }
  | { kind: "connected"; secret: InferenceAwsSsoSecret; expiresAt: Date }

/**
 * One CreateToken attempt. On approval, checks the role and builds the secret.
 * If anything after token issue fails, ends the new AWS session before rethrowing.
 */
export async function pollAwsSsoSignIn(input: { sso: GatewayAwsSsoSettings; aws: AwsSsoAttempt["aws"]; fetchImpl?: FetchLike; now?: () => number }): Promise<AwsSsoPollResult> {
  const fetchImpl = input.fetchImpl ?? awsSsoFetch()
  const now = input.now ?? Date.now
  const client: AwsSsoClient = { clientId: input.aws.clientId, clientSecret: input.aws.clientSecret, clientSecretExpiresAt: input.aws.clientSecretExpiresAt }
  const requestedAt = now()
  let tokens
  try {
    tokens = await createAwsSsoTokenFromDevice({ region: input.sso.region, client, deviceCode: input.aws.deviceCode, fetchImpl })
  } catch (error) {
    if (error instanceof AwsSsoError && (error.code === "aws_sso_authorization_pending" || error.code === "aws_sso_slow_down")) {
      return { kind: "pending", slowDown: error.code === "aws_sso_slow_down" }
    }
    throw error
  }
  try {
    if (!tokens.refreshToken) throw new AwsSsoError("aws_sso_invalid_response", "IAM Identity Center did not issue a refresh token. Ask your administrator to check the Identity Center instance.")
    const role = await getAwsSsoRoleCredentials({ region: input.sso.region, accessToken: tokens.accessToken, accountId: input.sso.accountId, roleName: input.sso.roleName, fetchImpl })
    const identity = await getAwsCallerIdentity({ region: input.sso.region, credentials: role, fetchImpl })
    if (identity.account !== input.sso.accountId) throw new AwsSsoError("aws_sso_role_forbidden", "AWS returned credentials for a different account than this provider uses.")
    return {
      kind: "connected",
      expiresAt: new Date(requestedAt + tokens.expiresIn * 1000),
      secret: {
        accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
        clientId: client.clientId, clientSecret: client.clientSecret, clientSecretExpiresAt: client.clientSecretExpiresAt,
        sso: input.sso,
        identity: { arn: identity.arn, userName: identity.userName, authorizationRevision: randomBytes(32).toString("base64url") },
      },
    }
  } catch (error) {
    await logoutAwsSso({ region: input.sso.region, accessToken: tokens.accessToken, fetchImpl })
    throw error
  }
}
