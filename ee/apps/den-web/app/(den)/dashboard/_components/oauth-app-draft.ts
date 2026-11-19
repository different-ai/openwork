import { manualOAuthEndpointSchema } from "@openwork/enterprise-mcp-client/manual-oauth";
import type { OAuthAppInput } from "./connector-setup";
import { manualOAuthDestination, manualOAuthDraft, type ManualOAuthDraft } from "./manual-oauth-draft";

export type OAuthAppDraft = {
  clientId: string;
  clientSecret: string;
  manualDraft: ManualOAuthDraft;
  trustConfirmed: boolean;
};

export function createOAuthAppDraft(): OAuthAppDraft {
  return { clientId: "", clientSecret: "", manualDraft: manualOAuthDraft(), trustConfirmed: false };
}

/** Consent belongs to the exact endpoint pair, not to the client credentials. */
export function withOAuthAppManualDraft(draft: OAuthAppDraft, manualDraft: ManualOAuthDraft): OAuthAppDraft {
  const before = draft.manualDraft;
  const endpointsChanged = before.values.authorizationEndpoint !== manualDraft.values.authorizationEndpoint
    || before.values.tokenEndpoint !== manualDraft.values.tokenEndpoint;
  const reviewChanged = before.published?.values.authorizationEndpoint !== manualDraft.published?.values.authorizationEndpoint
    || before.published?.values.tokenEndpoint !== manualDraft.published?.values.tokenEndpoint
    || before.published?.inconsistent !== manualDraft.published?.inconsistent;
  return { ...draft, manualDraft, trustConfirmed: endpointsChanged || reviewChanged ? false : draft.trustConfirmed };
}

export function oauthAppTrustRequired(draft: OAuthAppDraft, url?: string, issuerMismatch = false): boolean {
  return issuerMismatch || draft.manualDraft.published !== null
    || Boolean(url && manualOAuthDestination(url, draft.manualDraft.values, Boolean(draft.clientSecret.trim())).differentHost);
}

export type OAuthAppValidationError = {
  field: "clientId" | "clientSecret" | "authorizationEndpoint" | "tokenEndpoint" | "trustConfirmed";
  message: string;
};

type OAuthAppValidation = { input: OAuthAppInput; error: null } | { input: null; error: OAuthAppValidationError };

/** Used by the real form submit handler, including Enter and external footer submits. */
export function validateOAuthAppDraft(draft: OAuthAppDraft, options: {
  secretRequired: boolean;
  /** Custom setup requires reviewed destinations; preset forms use their existing validation. */
  setupValidation?: boolean;
  url?: string;
  issuerMismatch?: boolean;
}): OAuthAppValidation {
  const authorizationEndpoint = draft.manualDraft.values.authorizationEndpoint.trim();
  const tokenEndpoint = draft.manualDraft.values.tokenEndpoint.trim();
  const hasManual = Boolean(authorizationEndpoint && tokenEndpoint);
  if (options.setupValidation) {
    if (!draft.clientId.trim()) return { input: null, error: { field: "clientId", message: "Enter the Client ID from your OAuth app." } };
    if (options.secretRequired && !draft.clientSecret.trim()) return { input: null, error: { field: "clientSecret", message: "Enter the Client secret from your OAuth app." } };
    const mismatch = options.issuerMismatch || draft.manualDraft.published?.inconsistent === true;
    if (authorizationEndpoint || tokenEndpoint || mismatch) {
      for (const field of ["authorizationEndpoint", "tokenEndpoint"] satisfies (keyof typeof draft.manualDraft.values)[]) {
        const value = draft.manualDraft.values[field].trim();
        if (!value) return { input: null, error: { field, message: mismatch ? "Enter both sign-in addresses confirmed by the server owner before saving." : "Enter both sign-in addresses, or clear both to use automatic discovery." } };
        // Reuse the backend's browser-safe schema, including its credential-query policy.
        if (!manualOAuthEndpointSchema.safeParse(value).success) return { input: null, error: { field, message: "Use an HTTPS URL (HTTP only on localhost), without credentials, fragments or credential-like query parameters." } };
      }
    }
    if (hasManual && oauthAppTrustRequired(draft, options.url, mismatch) && !draft.trustConfirmed) {
      return { input: null, error: { field: "trustConfirmed", message: "Confirm the sign-in destinations with the server owner, then select the confirmation below." } };
    }
  }
  // Confirmation is local UI state. The complete manual pair is the existing API trust boundary.
  return { input: { clientId: draft.clientId, clientSecret: draft.clientSecret, ...(hasManual ? { manualOAuthEndpoints: { authorizationEndpoint, tokenEndpoint } } : {}) }, error: null };
}
