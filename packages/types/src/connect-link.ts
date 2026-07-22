// Shared contract for organization connect links. The default transport is a
// short-lived HTTPS exchange; an optional Ed25519 JWS transport is available
// when its public key ships in the desktop build. Both carry configuration
// provenance only — never authentication.

export const CONNECT_LINK_ROUTE = "connect";
export const CONNECT_LINK_AUDIENCE = "openwork-desktop-connect";
export const CONNECT_LINK_VERSION = 1;
export const CONNECT_LINK_ALGORITHM = "EdDSA";
export const CONNECT_LINK_DEFAULT_TTL_HOURS = 72;
export const CONNECT_LINK_MAX_TTL_HOURS = 168;
export const CONNECT_LINK_EXCHANGE_TTL_MINUTES = 5;

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
  | "replayed"
  | "unavailable";

export type ConnectLinkTransport = "signed" | "exchange";

export type ConnectLinkVerifySuccess = {
  ok: true;
  claims: ConnectLinkClaims;
  transport: ConnectLinkTransport;
  kid: string | null;
};

export type ConnectLinkVerifyFailure = {
  ok: false;
  code: ConnectLinkVerifyErrorCode;
  message: string;
};

export type ConnectLinkVerifyResult =
  | ConnectLinkVerifySuccess
  | ConnectLinkVerifyFailure;
