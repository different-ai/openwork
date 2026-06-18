import type { JwtOptions } from "better-auth/plugins"

export const DEN_JWT_SIGNING_ALGORITHM = "EdDSA"
export const DEN_JWT_KEY_CURVE = "Ed25519"
export const DEN_JWKS_ROTATION_INTERVAL_SECONDS = 24 * 60 * 60
export const DEN_JWKS_GRACE_PERIOD_SECONDS = 60 * 60

export function getDenAuthIssuer(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/api/auth`
}

export function getDenJwtOptions(input: { issuer: string }) {
  return {
    jwt: {
      issuer: input.issuer,
    },
    jwks: {
      keyPairConfig: {
        alg: DEN_JWT_SIGNING_ALGORITHM,
        crv: DEN_JWT_KEY_CURVE,
      },
      rotationInterval: DEN_JWKS_ROTATION_INTERVAL_SECONDS,
      gracePeriod: DEN_JWKS_GRACE_PERIOD_SECONDS,
    },
  } satisfies JwtOptions
}
