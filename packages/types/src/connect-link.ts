// Shared contract for signed connect links (`openwork://connect?token=<JWT>`).
// The token is an EdDSA (Ed25519) compact JWS minted by a Den deployment and
// verified by the desktop app against vendor public keys embedded in the
// build. It carries configuration provenance only — never authentication.

export const CONNECT_LINK_ROUTE = "connect";
export const CONNECT_LINK_AUDIENCE = "openwork-desktop-connect";
export const CONNECT_LINK_VERSION = 1;
export const CONNECT_LINK_ALGORITHM = "EdDSA";
export const CONNECT_LINK_DEFAULT_TTL_HOURS = 72;
export const CONNECT_LINK_MAX_TTL_HOURS = 168;

export type ConnectLinkOrg = {
  name: string;
};

/** Maps one-for-one to desktop-bootstrap.json's managed branding fields. */
export type ConnectLinkBrand = {
  appName: string;
  logoUrl: string | null;
  iconUrl: string | null;
};

export type ConnectLinkDenTarget = {
  baseUrl: string;
  apiBaseUrl?: string | null;
};

export type ConnectLinkClaims = {
  iss: string;
  aud: typeof CONNECT_LINK_AUDIENCE;
  iat: number;
  exp: number;
  jti: string;
  v: typeof CONNECT_LINK_VERSION;
  org: ConnectLinkOrg;
  brand: ConnectLinkBrand;
  den: ConnectLinkDenTarget;
  requireSignin: boolean;
};

export type ConnectLinkVerifyErrorCode =
  | "invalid_token"
  | "bad_signature"
  | "unknown_kid"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "wrong_version"
  | "insecure_url"
  | "malformed_claims"
  | "replayed";

export type ConnectLinkVerifySuccess = {
  ok: true;
  claims: ConnectLinkClaims;
  kid: string;
};

export type ConnectLinkVerifyFailure = {
  ok: false;
  code: ConnectLinkVerifyErrorCode;
  message: string;
};

export type ConnectLinkVerifyResult =
  | ConnectLinkVerifySuccess
  | ConnectLinkVerifyFailure;
