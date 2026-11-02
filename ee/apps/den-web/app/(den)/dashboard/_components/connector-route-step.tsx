"use client";

import { ChevronRight, Lock, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenCheckbox } from "../../_components/ui/checkbox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import type { OAuthAppInput } from "./connector-setup";
import { ConnectorDiscoveryChecks } from "./connector-discovery-checks";
import type { DiscoveryCheck } from "./connector-discovery-stream";
import { OAuthAppFields, createOAuthAppDraft, type OAuthAppDraft } from "./connector-setup-fields";
import { connectorOAuthAccess, requestedScopeSelection } from "./connector-oauth-access";
import {
  type ConnectorRoute,
  type ConnectorRouteAuth,
  type ConnectorRouteClient,
  type RequestHeaderDraft,
  detectedRoute,
  MAX_REQUEST_HEADERS,
  requestHeadersFromDrafts,
} from "./connector-route";
import { ItemHeader, ItemPage, SectionTitle, StepFooter } from "./item-header";
import { ConnectorLogo } from "./item-logo";
import type { McpRequirementsDiscovery, McpRequestHeaderInput } from "./mcp-connections-data";
import { McpCredentialInput } from "./mcp-credential-input";

const OAUTH_APP_FORM_ID = "connector-route-oauth-app";

function DetectedBadge({ loading }: { loading: boolean }) {
  if (loading) return <DenSkeleton className="h-[18px] w-16 rounded-full" />;
  return <DenBadge size="sm" tone="neutral">Detected</DenBadge>;
}

/** One radio row: the choice, whether detection found it, and its fields once picked. */
function RouteOption({ group, value, checked, onSelect, title, description, detected, detecting, locked, testId, children }: {
  group: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: ReactNode;
  detected: boolean;
  detecting: boolean;
  /** Why the option cannot be used here; shown in place of the description. */
  locked?: string | null;
  testId: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3 px-5 py-3.5" data-testid={testId} data-selected={checked} data-detected={detected}>
      <label className={`flex items-start gap-3 ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input
          type="radio"
          name={group}
          value={value}
          checked={checked}
          disabled={Boolean(locked)}
          onChange={onSelect}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900 disabled:opacity-40"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span id={`${id}-title`} className={`text-[14px] font-medium leading-5 ${locked ? "text-gray-500" : "text-gray-900"}`}>{title}</span>
            {detecting || detected ? <DetectedBadge loading={detecting} /> : null}
          </span>
          {locked ? (
            <span id={`${id}-description`} className="flex items-center gap-1.5 text-[13px] leading-[18px] text-gray-500">
              <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
              {locked}
            </span>
          ) : (
            <span id={`${id}-description`} className="text-[13px] leading-[18px] text-gray-500">{description}</span>
          )}
        </span>
      </label>
      {checked && children ? <div className="pl-7">{children}</div> : null}
    </div>
  );
}

function OptionPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
      {children}
    </div>
  );
}

let nextHeaderId = 0;
function newHeaderRow(): RequestHeaderDraft {
  nextHeaderId += 1;
  return { id: `header-${nextHeaderId}`, name: "", value: "" };
}

/**
 * Before a custom connector's checks run, OpenWork shows what it detected
 * (how people sign in, and how OpenWork registers its OAuth app) and lets the
 * admin take another route: their own OAuth app, an API key, or extra headers.
 */
export function ConnectorRouteStep({ name, url, back, initial = null, discovery, discovering, unreachable, secretRequired, liveChecks, callbackUrl, oauthDraft, onOAuthDraftChange, onCancel, onContinue }: {
  name: string;
  /** The route picked before Back, so going back keeps the admin's choices. */
  initial?: ConnectorRoute | null;
  url: string;
  back: { href: string; label: string };
  discovery: McpRequirementsDiscovery | null;
  discovering: boolean;
  unreachable: boolean;
  secretRequired: boolean;
  callbackUrl?: string;
  oauthDraft?: OAuthAppDraft;
  onOAuthDraftChange?: (draft: OAuthAppDraft) => void;
  liveChecks?: { checks: DiscoveryCheck[]; failed: boolean; onRetry: (headers: McpRequestHeaderInput[]) => void };
  onCancel: () => void;
  onContinue: (route: ConnectorRoute, oauthApp: OAuthAppInput | null) => void;
}) {
  const detected = detectedRoute(discovery);
  const [auth, setAuth] = useState<ConnectorRouteAuth | null>(initial?.auth ?? null);
  const [client, setClient] = useState<ConnectorRouteClient | null>(initial?.client ?? null);
  const [headers, setHeaders] = useState<RequestHeaderDraft[]>(() => (initial?.requestHeaders ?? []).map((header) => ({ ...newHeaderRow(), ...header })));
  const [showProblems, setShowProblems] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [localOAuthDraft, setLocalOAuthDraft] = useState(createOAuthAppDraft);
  const [scopeSelection, setScopeSelection] = useState<string[] | null>(initial?.requestedScopes ?? null);
  const [scopeReviewedKey, setScopeReviewedKey] = useState<string | null>(null);
  const access = connectorOAuthAccess(discovery);
  const selectedScopes = requestedScopeSelection(discovery, scopeSelection ?? access.selectedDefault);
  const scopeReviewKey = JSON.stringify([discovery?.authentication.resource, discovery?.authentication.authorizationServers.map((server) => server.issuer), access.conflictingScopes, selectedScopes]);
  const scopeReviewed = scopeReviewedKey === scopeReviewKey;
  const [accessError, setAccessError] = useState<string | null>(null);
  const metadataInconsistent = discovery?.warnings.some((warning) => warning.code === "oauth_issuer_mismatch") === true;

  // OAuth only rules automatic registration out when the server answered and offers neither method.
  const automaticLocked = detected.auth === "oauth" && detected.automaticRegistration === null
    ? metadataInconsistent ? "Automatic setup could not be verified. Review the sign-in addresses for your own app." : `${name} doesn't let apps register themselves.`
    : null;
  const chosenAuth: ConnectorRouteAuth = auth ?? detected.auth ?? "oauth";
  const chosenClient: ConnectorRouteClient = automaticLocked ? "own" : client ?? detected.client ?? "automatic";
  const { headers: requestHeaders, problems } = requestHeadersFromDrafts(headers, chosenAuth);
  const hasProblems = Object.keys(problems).length > 0;
  const usesOwnApp = chosenAuth === "oauth" && chosenClient === "own";

  const automaticDescription = detected.automaticRegistration === "dynamic"
    ? `OpenWork registers itself with ${name}.`
    : detected.automaticRegistration === "client_metadata"
      ? `${name} reads OpenWork's published app details.`
      : `OpenWork registers itself with ${name} when people first sign in.`;

  const route: ConnectorRoute = { auth: chosenAuth, client: chosenClient, requestHeaders, ...(chosenAuth === "oauth" ? { requestedScopes: selectedScopes } : {}) };

  function submit(oauthApp: OAuthAppInput | null) {
    if (hasProblems) {
      setShowProblems(true);
      return;
    }
    if (chosenAuth === "oauth") {
      if (access.requiresScopeChoice && selectedScopes.length === 0) { setAccessError("Choose the permissions to request before connecting."); return; }
      if (access.conflictingScopes.length > 0 && !scopeReviewed) { setAccessError("Review the conflicting permission information before connecting."); return; }
    }
    setAccessError(null);
    onContinue(route, oauthApp);
  }

  const note = discovering
    ? liveChecks ? null : `Checking ${name}...`
    : !unreachable && detected.auth === null
      ? `${name} didn't say how people sign in.`
      : null;

  return (
    <ItemPage testId="connector-route">
      <ItemHeader
        back={back}
        logo={<ConnectorLogo name={name} url={url} size="md" />}
        title={`Add ${name}`}
        description={<span className="break-all font-mono text-[13px]" data-testid="connector-route-url">{url}</span>}
      />
      {liveChecks ? (
        <ConnectorDiscoveryChecks
          checks={liveChecks.checks}
          discovering={discovering}
          failed={liveChecks.failed}
          manualCredentials={discovery?.authentication.kind === "manual_bearer"}
          onRetry={() => {
            if (hasProblems) { setShowProblems(true); return; }
            liveChecks.onRetry(requestHeaders);
          }}
        />
      ) : null}
      {unreachable && !liveChecks ? (
        <DenNotice
          tone="error"
          message={`OpenWork couldn't reach ${name}. Check the address, or add the header it needs, then continue.`}
        />
      ) : null}

      <section className="flex flex-col gap-2.5">
        <SectionTitle title="Authentication" />
        <OptionPanel label="Authentication">
          <RouteOption
            group="connector-route-auth"
            value="oauth"
            testId="connector-route-auth-oauth"
            checked={chosenAuth === "oauth"}
            onSelect={() => setAuth("oauth")}
            title="Sign in"
            description={`Connect through ${name}’s sign-in and consent pages.`}
            detected={detected.auth === "oauth"}
            detecting={discovering}
          />
          <RouteOption
            group="connector-route-auth"
            value="api_key"
            testId="connector-route-auth-api-key"
            checked={chosenAuth === "api_key"}
            onSelect={() => setAuth("api_key")}
            title="API key"
            description="Uses an API key. Choose who supplies it next."
            detected={detected.auth === "api_key"}
            detecting={false}
          />
          <RouteOption
            group="connector-route-auth"
            value="none"
            testId="connector-route-auth-none"
            checked={chosenAuth === "none"}
            onSelect={() => setAuth("none")}
            title="No browser sign-in"
            description="Public access, or credentials sent in request headers."
            detected={detected.auth === "none"}
            detecting={false}
          />
        </OptionPanel>
      </section>

      {chosenAuth === "oauth" ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="OAuth app" />
          <OptionPanel label="OAuth app">
            <RouteOption
              group="connector-route-client"
              value="automatic"
              testId="connector-route-client-automatic"
              checked={chosenClient === "automatic"}
              onSelect={() => setClient("automatic")}
              title="Use OpenWork"
              description="No OAuth app credentials to enter."
              detected={detected.client === "automatic"}
              detecting={discovering}
              locked={automaticLocked}
            />
            <RouteOption
              group="connector-route-client"
              value="own"
              testId="connector-route-client-own"
              checked={chosenClient === "own"}
              onSelect={() => setClient("own")}
              title="Use your own OAuth app"
              description={`The client ID from an app you registered with ${name}.`}
              detected={detected.client === "own" && !metadataInconsistent}
              detecting={false}
            >
              <OAuthAppFields
                url={url}
                setupValidation
                callbackUrl={callbackUrl}
                draft={oauthDraft ?? localOAuthDraft}
                onDraftChange={onOAuthDraftChange ?? setLocalOAuthDraft}
                discovery={discovery}
                secretRequired={secretRequired}
                saving={false}
                error={oauthError}
                formId={OAUTH_APP_FORM_ID}
                hideSubmit
                onSave={(input) => {
                  if (!input.clientId.trim()) {
                    setOauthError("Paste the client ID first.");
                    return;
                  }
                  if (!input.manualOAuthEndpoints && !input.clientSecret.trim() && secretRequired) {
                    setOauthError(`${name} needs the client secret too.`);
                    return;
                  }
                  setOauthError(null);
                  submit(input);
                }}
              />
            </RouteOption>
          </OptionPanel>
        </section>
      ) : null}

      {chosenAuth === "oauth" ? (
        <section className="flex flex-col gap-2.5" data-testid="connector-permissions">
          <details className="group/permissions" open={access.requiresScopeChoice || access.conflictingScopes.length > 0}>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-gray-700 [&::-webkit-details-marker]:hidden" data-testid="connector-permissions-summary"><ChevronRight className="h-3.5 w-3.5 transition-transform group-open/permissions:rotate-90 motion-reduce:transition-none" aria-hidden />Permissions requested{selectedScopes.length ? ` (${selectedScopes.length})` : ""}</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-[13px] leading-5 text-gray-600">Review the provider’s consent screen. A read-only tool endpoint does not make the OAuth grant read-only; the provider can require additional permissions or refresh access.</p>
              {access.conflictingScopes.length > 0 ? (
                <label className="flex items-start gap-2 text-[13px] leading-5 text-gray-700">
                  <DenCheckbox checked={scopeReviewed} onCheckedChange={(checked) => setScopeReviewedKey(checked ? scopeReviewKey : null)} className="mt-1" />
                  I reviewed the permission conflict: the sign-in challenge requires {access.conflictingScopes.join(", ")}, but the resource metadata does not list it. Check with the server owner before approving access.
                </label>
              ) : null}
              <div className="flex flex-col divide-y divide-gray-100">
                {[...access.requiredScopes, ...access.optionalScopes].map((scope) => {
                  const required = access.requiredScopes.includes(scope);
                  return <label key={scope} className="flex min-h-10 items-center gap-2 text-[13px] text-gray-700">
                    <DenCheckbox aria-label={`Request ${scope}`} checked={selectedScopes.includes(scope)} disabled={required} onCheckedChange={(checked) => { setScopeSelection(checked ? [...selectedScopes, scope] : selectedScopes.filter((entry) => entry !== scope)); setAccessError(null); }} />
                    <code className="break-all">{scope}</code><span className="ml-auto text-[12px] text-gray-500">{required ? "Required by provider" : "Optional"}</span>
                  </label>;
                })}
              </div>
              {!access.requiredScopes.length && !access.optionalScopes.length ? <p className="text-[12px] text-gray-500">The server did not advertise specific permissions. Its sign-in page will show the access it requests.</p> : null}
              <details className="text-[12px] text-gray-500"><summary className="cursor-pointer font-medium">Client registration details</summary><p className="mt-2">{automaticDescription} OpenWork chooses the supported registration method automatically; your own OAuth app remains an alternative.</p></details>
            </div>
          </details>
          {accessError ? <p role="alert" className="text-[13px] text-red-600">{accessError}</p> : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2.5" data-testid="connector-route-headers">
        <SectionTitle
          title="Request headers"
          meta={headers.length < MAX_REQUEST_HEADERS ? (
            <DenButton
              size="sm"
              variant="secondary"
              icon={Plus}
              onClick={() => setHeaders((rows) => [...rows, newHeaderRow()])}
              data-testid="connector-route-add-header"
            >
              Add header
            </DenButton>
          ) : `Up to ${MAX_REQUEST_HEADERS}`}
        />
        {headers.length > 0 ? (
          <div className="flex flex-col divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
            {headers.map((row, index) => {
              const problem = showProblems ? problems[row.id] : undefined;
              return (
                <div key={row.id} className="flex flex-col gap-1.5 px-5 py-3" data-testid="connector-route-header">
                  <div className="flex items-center gap-2">
                    <DenInput
                      value={row.name}
                      onChange={(event) => setHeaders((rows) => rows.map((entry) => entry.id === row.id ? { ...entry, name: event.target.value } : entry))}
                      placeholder="Header name"
                      aria-label={`Header ${index + 1} name`}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono !text-[13px]"
                      autoFocus={!row.name}
                    />
                    <McpCredentialInput
                      kind="secret"
                      name={`connector-route-header-${row.id}`}
                      aria-label={`Header ${index + 1} value`}
                      placeholder="Value"
                      value={row.value}
                      onChange={(value) => setHeaders((rows) => rows.map((entry) => entry.id === row.id ? { ...entry, value } : entry))}
                    />
                    <button
                      type="button"
                      onClick={() => setHeaders((rows) => rows.filter((entry) => entry.id !== row.id))}
                      aria-label={`Remove header ${index + 1}`}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/5"
                    >
                      <X className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                    </button>
                  </div>
                  {problem ? <p className="text-[12px] text-red-600" role="alert">{problem}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <StepFooter note={note}>
        <DenButton variant="secondary" onClick={onCancel}>Cancel</DenButton>
        {usesOwnApp ? (
          <DenButton type="submit" form={OAUTH_APP_FORM_ID} disabled={discovering} data-testid="connector-route-continue">{chosenAuth === "oauth" ? "Connect" : chosenAuth === "none" ? "Check connection" : "Continue"}</DenButton>
        ) : (
          <DenButton disabled={discovering} onClick={() => submit(null)} data-testid="connector-route-continue">{chosenAuth === "oauth" ? "Connect" : chosenAuth === "none" ? "Check connection" : "Continue"}</DenButton>
        )}
      </StepFooter>
    </ItemPage>
  );
}
