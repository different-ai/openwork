"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenCheckbox } from "../../_components/ui/checkbox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { type McpRequirementsDiscovery, useDiscoverMcpConnectionRequirements } from "./mcp-connections-data";
import { EMPTY_OAUTH_ADDRESSES, manualOAuthDestination, oauthAddressHost, publishedFieldUnsaved, reviewPublishedAddresses, undoPublishedAddresses, type ManualOAuthAddresses, type ManualOAuthDraft, type ManualOAuthField } from "./manual-oauth-draft";
import type { OAuthAppValidationError } from "./oauth-app-draft";

/** Collapsible group title, shared with "Authorization server selection" in connector settings. */
export const DETAILS_SUMMARY_CLASS = "flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-gray-700 [&::-webkit-details-marker]:hidden";

function EndpointField({ field, label, draft, saved, disabled, onChange, validationError }: {
  field: ManualOAuthField;
  label: string;
  draft: ManualOAuthDraft;
  saved: ManualOAuthAddresses;
  disabled: boolean;
  onChange: (draft: ManualOAuthDraft) => void;
  validationError?: OAuthAppValidationError | null;
}) {
  const errorId = useId();
  const fieldError = validationError?.field === field ? validationError.message : null;
  const testId = field === "authorizationEndpoint" ? "manual-oauth-authorization-endpoint" : "manual-oauth-token-endpoint";
  // Same anatomy as the connector settings Field: 12px label over a DenInput.
  return <label className="flex min-w-0 flex-col gap-1.5">
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-medium text-gray-700">
      {label}
      {publishedFieldUnsaved(draft, field, saved) ? <span data-testid={`${testId}-source`}>
        <DenBadge tone="warning" size="sm">From server · not verified · not saved</DenBadge>
      </span> : null}
    </span>
    <DenInput type="url" name={field} aria-invalid={Boolean(fieldError) || undefined} aria-describedby={fieldError ? errorId : undefined} value={draft.values[field]} disabled={disabled} className="font-mono !text-[13px]" placeholder={field === "authorizationEndpoint" ? "https://sign-in.example.com/authorize" : "https://sign-in.example.com/token"} onChange={(event) => onChange({ ...draft, values: { ...draft.values, [field]: event.target.value } })} data-testid={testId} />
    {fieldError ? <span id={errorId} role="alert" className="text-[12px] text-red-600">{fieldError}</span> : null}
  </label>;
}

/** Reviewing published addresses only edits this draft. Save remains the trust boundary. */
export function ManualOAuthFields({ url, draft, onChange, saved = EMPTY_OAUTH_ADDRESSES, hasClientSecret = false, disabled = false, discovery, setupValidation = false, trustConfirmed = false, onTrustConfirmedChange, validationError }: {
  url: string;
  draft: ManualOAuthDraft;
  onChange: (draft: ManualOAuthDraft) => void;
  saved?: ManualOAuthAddresses;
  hasClientSecret?: boolean;
  disabled?: boolean;
  discovery?: McpRequirementsDiscovery | null;
  /** Custom setup collects explicit trust; saved settings retain their existing save flow. */
  setupValidation?: boolean;
  trustConfirmed?: boolean;
  onTrustConfirmedChange?: (confirmed: boolean) => void;
  validationError?: OAuthAppValidationError | null;
}) {
  const trustErrorId = useId();
  const discover = useDiscoverMcpConnectionRequirements();
  const [preview, setPreview] = useState<McpRequirementsDiscovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const result = preview ?? discovery;
  const mismatch = result?.warnings.some((warning) => warning.code === "oauth_issuer_mismatch") === true;
  const manuallyConfigured = Boolean(saved.authorizationEndpoint && saved.tokenEndpoint);
  const destination = manualOAuthDestination(url, draft.values, hasClientSecret);
  const pendingReview = draft.published !== null;

  async function inspect(): Promise<McpRequirementsDiscovery | null> {
    setError(null);
    try {
      const result = await discover.mutateAsync(url);
      setPreview(result);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sign-in addresses could not be read.");
      return null;
    }
  }

  async function review() {
    const source = result ?? await inspect();
    if (!source) return;
    const addresses = (source.publishedSignInAddresses ?? []).filter((entry, index, all) => all.findIndex((candidate) => candidate.authorizationEndpoint === entry.authorizationEndpoint && candidate.tokenEndpoint === entry.tokenEndpoint) === index);
    const address = addresses[0];
    if (!address || addresses.length !== 1) {
      setError(addresses.length > 1 ? "This server publishes more than one pair of sign-in addresses. Check with the server owner and enter the intended pair manually." : "This server did not publish usable sign-in addresses. Ask the server owner for the authorization and token URLs.");
      return;
    }
    setError(null);
    onChange(reviewPublishedAddresses(draft, { authorizationEndpoint: address.authorizationEndpoint, tokenEndpoint: address.tokenEndpoint }, source.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")));
  }

  return <details className="group" open={Boolean(discovery?.warnings.some((warning) => warning.code === "oauth_issuer_mismatch")) || manuallyConfigured} data-testid="manual-oauth-settings" onToggle={(event) => {
    // Opening unconfigured sign-in settings may inspect public metadata. Saved
    // manual configurations never discover implicitly, even when this row opens.
    if (event.currentTarget.open && !result && !manuallyConfigured && !discover.isPending && !disabled) void inspect();
  }}>
    <summary className={DETAILS_SUMMARY_CLASS} data-testid="manual-oauth-summary">
      <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform group-open:rotate-90" aria-hidden />
      Sign-in addresses
    </summary>
    <div className="mt-3 flex min-w-0 flex-col gap-3">
      {!pendingReview ? <>
        {mismatch ? <div data-testid="manual-oauth-failure">
          {/* The shared error notice with its next action, as Den's other "failed · Try again" notices. */}
          <DenNotice
            tone="error"
            message={<>
              <span className="block font-medium">Sign-in stopped: this server's sign-in information is inconsistent</span>
              <span className="mt-1 block text-[13px] leading-5">OpenWork can't confirm which service should receive your users' sign-in codes, so it won't use the published addresses on its own. Check them with the server owner before using them.</span>
            </>}
            action={<DenButton type="button" variant="secondary" size="sm" disabled={disabled} loading={discover.isPending} onClick={() => void review()}>Review published addresses</DenButton>}
          />
        </div> : <div className="flex justify-start"><DenButton type="button" variant="secondary" size="sm" disabled={disabled || !url} loading={discover.isPending} onClick={() => void review()}>Review published addresses</DenButton></div>}
        {result?.publishedSignInAddresses?.length ? <details className="group/technical text-[12px] text-gray-500">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden"><ChevronRight className="h-3.5 w-3.5 transition-transform group-open/technical:rotate-90" aria-hidden />Technical details</summary>
          <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-2xl border border-gray-100 bg-white px-5 py-3 leading-5">
            {result.publishedSignInAddresses.map((address, index) => <div key={index} className="contents">
              <dt>Named sign-in service</dt><dd className="break-all text-gray-700">{address.advertisedIssuer}</dd>
              <dt>Published issuer</dt><dd className="break-all text-gray-700">{address.metadataIssuer}</dd>
              <dt>Authorization URL</dt><dd className="break-all font-mono text-gray-700">{address.authorizationEndpoint}</dd>
              <dt>Token URL</dt><dd className="break-all font-mono text-gray-700">{address.tokenEndpoint}</dd>
            </div>)}
          </dl>
        </details> : null}
      </> : null}
      <EndpointField field="authorizationEndpoint" label="Authorization endpoint URL" draft={draft} saved={saved} disabled={disabled} onChange={onChange} validationError={setupValidation ? validationError : null} />
      <EndpointField field="tokenEndpoint" label="Token endpoint URL" draft={draft} saved={saved} disabled={disabled} onChange={onChange} validationError={setupValidation ? validationError : null} />
      {pendingReview || destination.differentHost ? <div data-testid="manual-oauth-trust-warning">
        {/* The shared warning notice (amber icon, neutral surface); Undo sits in its action slot. */}
        <DenNotice
          tone="warning"
          message={<>
            <span className="block">{destination.beforeHost}<strong className="font-semibold">{destination.host}</strong>{destination.afterHost}</span>
            {pendingReview ? <span className="mt-1 block text-[13px] leading-5 text-gray-600">
              {draft.published?.inconsistent ? "OpenWork didn't verify these addresses because the server's information is inconsistent. Save only if the server owner confirms them." : "OpenWork hasn't verified these addresses. Save only if the server owner confirms them."}
            </span> : null}
          </>}
          action={pendingReview ? <DenButton type="button" variant="secondary" size="sm" disabled={disabled} onClick={() => onChange(undoPublishedAddresses(draft))}>Undo</DenButton> : undefined}
        />
      </div> : null}
      {setupValidation && draft.values.authorizationEndpoint.trim() && draft.values.tokenEndpoint.trim() && (mismatch || pendingReview || destination.differentHost) ? <label className="flex items-start gap-2 text-[12px] leading-5 text-gray-700" data-testid="manual-oauth-trust-confirmation">
        <DenCheckbox name="trustConfirmed" checked={trustConfirmed} disabled={disabled || !onTrustConfirmedChange} onCheckedChange={(checked) => onTrustConfirmedChange?.(checked)} aria-invalid={validationError?.field === "trustConfirmed" || undefined} aria-describedby={validationError?.field === "trustConfirmed" ? trustErrorId : undefined} className="mt-1" />
        <span>I checked these addresses with the server owner and approve sending users to <strong>{oauthAddressHost(draft.values.authorizationEndpoint)}</strong> to sign in, and sending their sign-in codes{hasClientSecret ? " and the client secret" : ""} to <strong>{oauthAddressHost(draft.values.tokenEndpoint)}</strong>.</span>
      </label> : null}
      {setupValidation && validationError?.field === "trustConfirmed" ? <p id={trustErrorId} role="alert" className="text-[12px] text-red-600">{validationError.message}</p> : null}
      {!setupValidation && Boolean(draft.values.authorizationEndpoint) !== Boolean(draft.values.tokenEndpoint) ? <p role="alert" className="text-[12px] text-red-600">Enter both addresses, or clear both to use automatic discovery.</p> : null}
      {error ? <p role="alert" className="text-[12px] text-red-600">{error}</p> : null}
    </div>
  </details>;
}
