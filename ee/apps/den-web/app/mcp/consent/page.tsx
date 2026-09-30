"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { OnboardingTexture } from "../../(den)/_components/onboarding-texture";
import { SetupFrame } from "../../(den)/_components/setup-frame";
import {
  SetupErrorLine,
  SetupFacts,
  SetupPanelBody,
  SetupPanelTitle,
  SetupQuietButton,
  SetupStatus,
} from "../../(den)/_components/setup-frame-parts";
import { denApiCredentials, denBrowserEndpoint } from "../../(den)/_lib/den-api-origin";
import { describeMcpOAuthError } from "../../(den)/_lib/mcp-oauth-route";
import { getRuntimeConfig } from "../../(den)/_lib/runtime-config";
import { McpReturnLine, McpUnverifiedAppWarning, mcpIdentityFacts, useMcpRedirect } from "../client-identity";
import { McpConsentPermissions, McpTechnicalDetails } from "../consent-permissions";
import { McpStoryTiles, mcpStoryCopy } from "../mcp-story";
import { useLocationQuery } from "../use-location-query";
import { useMcpClient } from "../use-mcp-client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function readActiveWorkspaceName(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) return null;
  const active = payload.orgs.find((org) => isRecord(org) && org.isActive === true) ?? payload.orgs[0];
  return isRecord(active) && typeof active.name === "string" && active.name.trim() ? active.name.trim() : null;
}

function readEmail(payload: unknown): string | null {
  return isRecord(payload) && isRecord(payload.user) && typeof payload.user.email === "string" ? payload.user.email : null;
}

/**
 * The OAuth consent step (A8/A9): who is asking, which workspace it will use,
 * where the approval goes, and what it can do, then one primary action that
 * names the app. Deny stays a quiet text action.
 */
export default function McpConsentPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
  const [denied, setDenied] = useState(false);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const oauthQuery = useLocationQuery() ?? "";
  const scope = new URLSearchParams(oauthQuery).get("scope") ?? "openid profile email mcp:read";
  const client = useMcpClient(oauthQuery);
  const redirect = useMcpRedirect(oauthQuery);
  const story = mcpStoryCopy(client);
  const actor = client.name ?? "This app";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [me, orgs] = await Promise.all([requestJson("/v1/me", { method: "GET" }), requestJson("/v1/me/orgs", { method: "GET" })]);
      if (cancelled) return;
      setEmail(me.response.ok ? readEmail(me.payload) : null);
      setWorkspaceName(orgs.response.ok ? readActiveWorkspaceName(orgs.payload) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(accept: boolean) {
    setBusy(accept ? "accept" : "deny");
    setError(null);
    const result = await requestJson("/api/auth/oauth2/consent", {
      method: "POST",
      body: JSON.stringify({ accept, scope, oauth_query: oauthQuery }),
    });
    const url = isRecord(result.payload) && typeof result.payload.url === "string" ? result.payload.url : null;
    if (!result.response.ok) {
      setBusy(null);
      setError(describeMcpOAuthError(result.payload, accept ? `Could not authorize ${client.name ?? "this app"}. Try again.` : "Could not deny this request. Try again."));
      return;
    }
    if (url) {
      window.location.href = url;
      return;
    }
    if (!accept) {
      setDenied(true);
      setBusy(null);
      return;
    }
    window.location.reload();
  }

  const frame = (children: ReactNode) => (
    <SetupFrame
      title={story.title}
      description={story.description}
      aside={<McpStoryTiles client={client} workspaceName={workspaceName} appHost={redirect?.host ?? null} />}
      panelVisual={<OnboardingTexture />}
    >
      <div data-testid="mcp-consent">{children}</div>
    </SetupFrame>
  );

  if (denied) {
    return frame(<SetupStatus icon={<X className="size-5" strokeWidth={1.5} />} title="Nothing was authorized" line="You can close this tab." />);
  }

  const identity = mcpIdentityFacts(client, redirect);
  const appName = client.name ?? "this app";

  return frame(
    <SetupPanelBody>
      <SetupPanelTitle>{`Allow ${appName} to use ${workspaceName ?? "your workspace"}?`}</SetupPanelTitle>
      <div data-testid="mcp-client-identity">
        <SetupFacts
          rows={[
            identity.app,
            { label: "Workspace", value: workspaceName ?? "…" },
            identity.returnsTo,
            { label: "Account", value: email ?? "…" },
          ]}
        />
      </div>
      <McpConsentPermissions scope={scope} actor={actor} />
      <div className="flex flex-col gap-3.5">
        <McpUnverifiedAppWarning redirect={redirect} client={client} />
        <McpReturnLine client={client} redirect={redirect} />
        {error ? <SetupErrorLine>{error}</SetupErrorLine> : null}
        <button type="button" className="den-button-primary w-full" disabled={busy !== null} onClick={() => void decide(true)}>
          {busy === "accept" ? "Authorizing…" : client.name ? `Authorize ${client.name}` : "Authorize this app"}
        </button>
        <div className="flex items-start justify-between gap-4">
          <McpTechnicalDetails scope={scope} clientId={client.clientId} redirect={redirect} />
          <SetupQuietButton onClick={() => void decide(false)} disabled={busy !== null}>
            Deny
          </SetupQuietButton>
        </div>
      </div>
    </SetupPanelBody>,
  );
}
