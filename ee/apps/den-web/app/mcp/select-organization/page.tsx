"use client";

import { Check, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { OnboardingTexture } from "../../(den)/_components/onboarding-texture";
import { SetupFrame } from "../../(den)/_components/setup-frame";
import {
  SetupErrorLine,
  SetupFacts,
  SetupLetterTile,
  SetupLine,
  SetupPanelBody,
  SetupPanelTitle,
  SetupQuietButton,
  SetupSkeletonRows,
  SetupStatus,
} from "../../(den)/_components/setup-frame-parts";
import { denApiCredentials, denBrowserEndpoint } from "../../(den)/_lib/den-api-origin";
import {
  MCP_OAUTH_RESTART_MESSAGE,
  describeMcpOAuthError,
  isMcpOAuthQueryExpired,
} from "../../(den)/_lib/mcp-oauth-route";
import { getRuntimeConfig } from "../../(den)/_lib/runtime-config";
import { useOrgListWindow } from "../../(den)/_lib/use-org-list-window";
import { FilterInput } from "../../(den)/dashboard/_components/item-list";
import { McpReturnLine, McpUnverifiedAppWarning, mcpIdentityFacts, useMcpRedirect } from "../client-identity";
import { McpConsentPermissions, McpTechnicalDetails } from "../consent-permissions";
import { McpStoryTiles, mcpStoryCopy } from "../mcp-story";
import { useLocationQuery } from "../use-location-query";
import { FIRST_PARTY_APP_CLIENT_IDS } from "../client-trust-constants";
import { useMcpClient } from "../use-mcp-client";

type Organization = {
  id: string;
  slug?: string | null;
  name?: string | null;
  role?: string | null;
  isActive?: boolean;
};

type FlowState =
  | "loading"
  | "ready"
  | "empty"
  | "expired"
  | "signed_out"
  | "cancelled"
  | "submitting"
  | "redirecting";

const ORG_PAGE_SIZE = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPayloadString(payload: unknown, key: "message" | "error" | "url") {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function getErrorMessage(payload: unknown, fallback: string) {
  return readPayloadString(payload, "message") ?? readPayloadString(payload, "error") ?? fallback;
}

async function requestJson(path: string, init?: RequestInit) {
  await getRuntimeConfig();
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    credentials: denApiCredentials(endpoint),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const payload: unknown = await response.json().catch(() => null);
  return { response, payload };
}

function formatRole(role: string | null | undefined) {
  if (!role) return "Member";
  return role
    .split(/[-_,\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function orgDisplayName(org: Organization) {
  return org.name || org.slug || org.id;
}

function parseCreatedOrg(payload: unknown): Organization | null {
  if (!isRecord(payload) || !isRecord(payload.organization)) return null;
  const organization = payload.organization;
  if (typeof organization.id !== "string" || !organization.id) return null;
  return {
    id: organization.id,
    slug: typeof organization.slug === "string" ? organization.slug : null,
    name: typeof organization.name === "string" ? organization.name : null,
    role: "owner",
    isActive: true,
  };
}

function parseOrgs(payload: unknown): Organization[] {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) return [];
  const result: Organization[] = [];
  for (const entry of payload.orgs) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    result.push({
      id: entry.id,
      slug: typeof entry.slug === "string" ? entry.slug : null,
      name: typeof entry.name === "string" ? entry.name : null,
      role: typeof entry.role === "string" ? entry.role : null,
      isActive: entry.isActive === true,
    });
  }
  return result;
}

function parseEmail(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.user)) return null;
  return typeof payload.user.email === "string" ? payload.user.email : null;
}

export default function McpSelectOrganizationPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [flowState, setFlowState] = useState<FlowState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState<string | null>(null);

  const locationQuery = useLocationQuery();
  const oauthQuery = locationQuery ?? "";
  const params = useMemo(() => new URLSearchParams(oauthQuery), [oauthQuery]);
  const requestedScope = params.get("scope") ?? "openid profile email mcp:read";
  const client = useMcpClient(oauthQuery);
  // OpenWork's own apps (Workbot): choosing a workspace is all there is to it.
  const firstParty = client.clientId !== null && FIRST_PARTY_APP_CLIENT_IDS.has(client.clientId);
  const redirect = useMcpRedirect(oauthQuery);
  const appName = client.name ?? "this app";
  const actor = client.name ?? "This app";
  const story = mcpStoryCopy(client);
  const selectedOrg = useMemo(() => orgs.find((org) => org.id === selectedOrgId) ?? null, [orgs, selectedOrgId]);
  const isBusy = flowState === "submitting" || flowState === "redirecting";
  const creating = orgs.length === 0 && (flowState === "empty" || isBusy);
  const orgWindow = useOrgListWindow(orgs, ORG_PAGE_SIZE);

  useEffect(() => {
    if (locationQuery === null) return;
    let cancelled = false;
    if (isMcpOAuthQueryExpired(oauthQuery)) {
      setFlowState("expired");
      return;
    }
    void (async () => {
      const [me, directory] = await Promise.all([
        requestJson("/v1/me", { method: "GET" }),
        requestJson("/v1/me/orgs", { method: "GET" }),
      ]);
      if (cancelled) return;
      setEmail(me.response.ok ? parseEmail(me.payload) : null);
      if (!directory.response.ok) {
        setFlowState("signed_out");
        return;
      }
      const list = parseOrgs(directory.payload);
      setOrgs(list);
      setSelectedOrgId(list.find((org) => org.isActive)?.id ?? list[0]?.id ?? "");
      setFlowState(list.length ? "ready" : "empty");
    })();
    return () => {
      cancelled = true;
    };
  }, [locationQuery, oauthQuery]);

  async function continueFlow(org: Organization | null = selectedOrg) {
    if (!org) return;
    setFlowState("submitting");
    setErrorMessage(null);

    const active = await requestJson("/api/auth/organization/set-active", {
      method: "POST",
      body: JSON.stringify({ organizationId: org.id, organizationSlug: org.slug ?? null }),
    });
    if (!active.response.ok) {
      setFlowState("ready");
      setErrorMessage(getErrorMessage(active.payload, "Could not choose this workspace. Try again."));
      return;
    }

    const continued = await requestJson("/api/auth/oauth2/consent", {
      method: "POST",
      body: JSON.stringify({ accept: true, scope: requestedScope, oauth_query: oauthQuery }),
    });
    if (!continued.response.ok) {
      const message = describeMcpOAuthError(continued.payload, `Could not authorize ${appName}. Try again.`);
      setFlowState(message === MCP_OAUTH_RESTART_MESSAGE ? "expired" : "ready");
      setErrorMessage(message);
      return;
    }

    const redirectUrl = readPayloadString(continued.payload, "url");
    setFlowState("redirecting");
    if (redirectUrl) {
      window.location.href = redirectUrl;
      return;
    }
    window.location.reload();
  }

  // A brand-new person reaches this page with no workspace. Create it here
  // and keep going with the same signed query, so their agent's
  // authorization never has to restart.
  async function createWorkspaceAndContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = workspaceName.trim();
    if (name.length < 2) return;
    setFlowState("submitting");
    setCreateError(null);
    setErrorMessage(null);

    const created = await requestJson("/v1/org", { method: "POST", body: JSON.stringify({ name }) });
    const org = created.response.ok ? parseCreatedOrg(created.payload) : null;
    if (!org) {
      setFlowState("empty");
      setCreateError("Could not create the workspace. Try again.");
      return;
    }

    setOrgs([org]);
    setSelectedOrgId(org.id);
    await continueFlow(org);
  }

  async function cancelFlow() {
    setFlowState("submitting");
    setErrorMessage(null);
    const denied = await requestJson("/api/auth/oauth2/consent", {
      method: "POST",
      body: JSON.stringify({ accept: false, scope: requestedScope, oauth_query: oauthQuery }),
    });
    const redirectUrl = readPayloadString(denied.payload, "url");
    if (redirectUrl) {
      setFlowState("redirecting");
      window.location.href = redirectUrl;
      return;
    }
    setFlowState("cancelled");
  }

  const storyWorkspace = selectedOrg ? orgDisplayName(selectedOrg) : workspaceName.trim() || null;

  const frame = (children: ReactNode) => (
    <SetupFrame
      title={story.title}
      description={story.description}
      aside={<McpStoryTiles client={client} workspaceName={storyWorkspace} appHost={redirect?.host ?? null} />}
      panelVisual={<OnboardingTexture />}
    >
      <div data-testid="mcp-select-organization">{children}</div>
    </SetupFrame>
  );

  if (flowState === "expired") {
    return frame(
      <SetupPanelBody gap="md">
        <SetupPanelTitle>This sign-in link expired</SetupPanelTitle>
        <div className="flex flex-col gap-1.5">
          <SetupLine>Start sign-in again from your agent.</SetupLine>
          <SetupLine muted>Nothing was authorized.</SetupLine>
        </div>
      </SetupPanelBody>,
    );
  }

  if (flowState === "cancelled") {
    return frame(<SetupStatus icon={<X className="size-5" strokeWidth={1.5} />} title="Nothing was authorized" line="You can close this tab." />);
  }

  if (flowState === "signed_out") {
    return frame(
      <SetupPanelBody gap="md">
        <SetupPanelTitle>Sign in to continue</SetupPanelTitle>
        <SetupLine>Sign in to OpenWork, then {appName} can finish connecting.</SetupLine>
        <a className="den-button-primary w-full" href={`/?${oauthQuery}`}>Sign in to OpenWork</a>
      </SetupPanelBody>,
    );
  }

  const identity = mcpIdentityFacts(client, redirect);
  const facts = [
    identity.app,
    identity.returnsTo,
    { label: "Account", value: email ?? "…", testId: "mcp-account-email" },
  ];

  return frame(
    <SetupPanelBody>
      <SetupPanelTitle>{creating ? "Name your workspace" : "Choose a workspace"}</SetupPanelTitle>

      {flowState === "loading" ? <SetupSkeletonRows /> : null}

      {creating ? (
        <form id="mcp-create-workspace" className="flex flex-col gap-2" onSubmit={(event) => void createWorkspaceAndContinue(event)}>
          <label htmlFor="mcp-workspace-name" className="den-label">Workspace name</label>
          <input
            id="mcp-workspace-name"
            className="den-input"
            name="workspaceName"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="My work"
            minLength={2}
            maxLength={120}
            autoComplete="organization"
            autoFocus
            required
            disabled={isBusy}
          />
          {createError ? <SetupErrorLine>{createError}</SetupErrorLine> : null}
        </form>
      ) : null}

      {!creating && orgs.length > 0 ? (
        <div className="flex flex-col gap-3">
          {orgWindow.showSearch ? (
            <FilterInput size="md" value={orgWindow.query} onChange={orgWindow.setQuery} placeholder="Filter by name" />
          ) : null}
          <div role="radiogroup" aria-label="Workspace" className="flex flex-col border-t border-[var(--setup-hairline)]">
            {orgWindow.visible.map((org) => {
              const display = orgDisplayName(org);
              const isSelected = selectedOrgId === org.id;
              return (
                <label
                  key={org.id}
                  className={`flex min-h-13 cursor-pointer items-center gap-3 border-b border-[var(--setup-hairline)] py-2 ${isBusy ? "pointer-events-none opacity-70" : ""}`}
                >
                  <input
                    type="radio"
                    name="mcp-organization"
                    checked={isSelected}
                    onChange={() => setSelectedOrgId(org.id)}
                    className="sr-only"
                    disabled={isBusy}
                  />
                  <SetupLetterTile name={display} />
                  <span className="flex min-w-0 grow flex-col">
                    <span className="truncate text-sm font-medium leading-5 text-[var(--dls-text-primary)]">{display}</span>
                    <span className="text-[13px] leading-[18px] text-[var(--dls-text-secondary)]">{formatRole(org.role)}</span>
                  </span>
                  <span className="flex w-24 shrink-0 items-center justify-end gap-2.5 text-[13px] text-[var(--dls-text-secondary)]">
                    {org.isActive ? <span>Current</span> : null}
                    {isSelected ? <Check aria-hidden="true" className="size-4 text-[var(--dls-text-primary)]" strokeWidth={1.5} /> : null}
                  </span>
                </label>
              );
            })}
          </div>
          {orgWindow.filteredCount === 0 && orgWindow.query ? <SetupLine muted>No workspaces match.</SetupLine> : null}
          {orgWindow.hasMore ? (
            <SetupQuietButton className="self-start text-[var(--setup-ink-soft)]" onClick={orgWindow.showAll}>
              Show {orgWindow.hiddenCount} more
            </SetupQuietButton>
          ) : null}
        </div>
      ) : null}

      <SetupFacts rows={facts} />

      {firstParty ? null : <McpConsentPermissions scope={requestedScope} actor={actor} />}

      <div className="flex flex-col gap-3.5">
        {firstParty ? null : <McpUnverifiedAppWarning redirect={redirect} client={client} />}
        {firstParty ? null : <McpReturnLine client={client} redirect={redirect} short />}
        {errorMessage ? <SetupErrorLine>{errorMessage}</SetupErrorLine> : null}
        {creating ? (
          <button
            type="submit"
            form="mcp-create-workspace"
            className="den-button-primary w-full"
            disabled={isBusy || workspaceName.trim().length < 2}
          >
            {isBusy ? (firstParty ? "Opening…" : "Authorizing…") : firstParty ? "Create workspace and continue" : "Create workspace and authorize"}
          </button>
        ) : (
          <button
            type="button"
            className="den-button-primary w-full"
            onClick={() => void continueFlow()}
            disabled={isBusy || flowState === "loading" || !selectedOrgId}
          >
            {isBusy ? (firstParty ? "Opening…" : "Authorizing…") : firstParty ? `Continue to ${client.name ?? "OpenWork"}` : client.name ? `Authorize ${client.name}` : "Authorize this app"}
          </button>
        )}
        <div className="flex items-start justify-between gap-4">
          <McpTechnicalDetails scope={requestedScope} clientId={client.clientId} redirect={redirect} />
          <SetupQuietButton onClick={() => void cancelFlow()} disabled={isBusy || flowState === "loading"}>
            Cancel
          </SetupQuietButton>
        </div>
      </div>
    </SetupPanelBody>,
  );
}
