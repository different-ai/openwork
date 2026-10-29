"use client";

import { Lock, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import type { OAuthAppInput } from "./connector-setup";
import { OAuthAppFields } from "./connector-setup-fields";
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
import type { McpRequirementsDiscovery } from "./mcp-connections-data";
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
export function ConnectorRouteStep({ name, url, back, initial = null, discovery, discovering, unreachable, secretRequired, onCancel, onContinue }: {
  name: string;
  /** The route picked before Back, so going back keeps the admin's choices. */
  initial?: ConnectorRoute | null;
  url: string;
  back: { href: string; label: string };
  discovery: McpRequirementsDiscovery | null;
  discovering: boolean;
  unreachable: boolean;
  secretRequired: boolean;
  onCancel: () => void;
  onContinue: (route: ConnectorRoute, oauthApp: OAuthAppInput | null) => void;
}) {
  const detected = detectedRoute(discovery);
  const [auth, setAuth] = useState<ConnectorRouteAuth | null>(initial?.auth ?? null);
  const [client, setClient] = useState<ConnectorRouteClient | null>(initial?.client ?? null);
  const [headers, setHeaders] = useState<RequestHeaderDraft[]>(() => (initial?.requestHeaders ?? []).map((header) => ({ ...newHeaderRow(), ...header })));
  const [showProblems, setShowProblems] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // OAuth only rules automatic registration out when the server answered and offers neither method.
  const automaticLocked = detected.auth === "oauth" && detected.automaticRegistration === null
    ? `${name} doesn't let apps register themselves.`
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

  const route: ConnectorRoute = { auth: chosenAuth, client: chosenClient, requestHeaders };

  function submit(oauthApp: OAuthAppInput | null) {
    if (hasProblems) {
      setShowProblems(true);
      return;
    }
    onContinue(route, oauthApp);
  }

  const note = discovering
    ? `Checking ${name}...`
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
      {unreachable ? (
        <DenNotice
          tone="error"
          message={`OpenWork couldn't reach ${name}. Check the address, or add the header it needs, then continue.`}
        />
      ) : null}

      <section className="flex flex-col gap-2.5">
        <SectionTitle title="How people sign in" />
        <OptionPanel label="How people sign in">
          <RouteOption
            group="connector-route-auth"
            value="oauth"
            testId="connector-route-auth-oauth"
            checked={chosenAuth === "oauth"}
            onSelect={() => setAuth("oauth")}
            title="Sign in with OAuth"
            description={`Each person signs in to ${name} before they use it.`}
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
            description={`${name} takes a key instead of a sign-in.`}
            detected={detected.auth === "api_key"}
            detecting={false}
          />
          <RouteOption
            group="connector-route-auth"
            value="none"
            testId="connector-route-auth-none"
            checked={chosenAuth === "none"}
            onSelect={() => setAuth("none")}
            title="No sign-in"
            description="Open access, or a key sent as a header."
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
              title="Register OpenWork automatically"
              description={automaticDescription}
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
              detected={detected.client === "own"}
              detecting={false}
            >
              <OAuthAppFields
                url={url}
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
          <DenButton type="submit" form={OAUTH_APP_FORM_ID} disabled={discovering} data-testid="connector-route-continue">Continue</DenButton>
        ) : (
          <DenButton disabled={discovering} onClick={() => submit(null)} data-testid="connector-route-continue">Continue</DenButton>
        )}
      </StepFooter>
    </ItemPage>
  );
}
