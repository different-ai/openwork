"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { denApiCredentials, denBrowserEndpoint } from "../(den)/_lib/den-api-origin";
import { getRuntimeConfig } from "../(den)/_lib/runtime-config";
import { describeMcpRedirect, fallbackClientName } from "./client-identity-model";

type PublicClient = { name: string | null; logoUri: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function loadPublicClient(clientId: string, oauthQuery: string): Promise<PublicClient | null> {
  await getRuntimeConfig();
  // The prelogin variant is authorized by the signed OAuth query itself, so it
  // works the same whether or not this browser's session cookie is readable.
  const endpoint = denBrowserEndpoint("/api/auth/oauth2/public-client-prelogin");
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: denApiCredentials(endpoint),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, oauth_query: oauthQuery }),
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) return null;
  return {
    name: typeof payload.client_name === "string" && payload.client_name.trim() ? payload.client_name.trim() : null,
    logoUri: typeof payload.logo_uri === "string" && payload.logo_uri.startsWith("https://") ? payload.logo_uri : null,
  };
}

/**
 * Who is asking and where the approval is sent. Consent is only meaningful
 * when the person can see both, so they lead the card (P9), and a loopback-only
 * return address gets an explicit warning.
 */
export function McpClientIdentity({ clientId, redirectUri, oauthQuery }: { clientId: string | null; redirectUri: string | null; oauthQuery: string }) {
  const [client, setClient] = useState<PublicClient | null>(null);
  const [loaded, setLoaded] = useState(false);
  const redirect = describeMcpRedirect(redirectUri);

  useEffect(() => {
    if (!clientId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void loadPublicClient(clientId, oauthQuery).then((result) => {
      if (cancelled) return;
      setClient(result);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId, oauthQuery]);

  const name = client?.name ?? (clientId ? fallbackClientName(clientId) : "An app without a name");

  return (
    <div className="grid gap-3" data-testid="mcp-client-identity">
      <div className="grid divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]">
        <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
          <span className="text-[var(--dls-text-secondary)]">App</span>
          <span className="flex min-w-0 items-center gap-2 font-medium text-[var(--dls-text-primary)]">
            {client?.logoUri ? <img src={client.logoUri} alt="" className="size-4 shrink-0 rounded-sm" /> : null}
            <span className="truncate" data-testid="mcp-client-name">{loaded ? name : "…"}</span>
          </span>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-4 py-2 text-[13px]">
          <span className="text-[var(--dls-text-secondary)]">Returns to</span>
          <span className="truncate font-mono text-[12px] text-[var(--dls-text-primary)]" data-testid="mcp-redirect-host">
            {redirect?.host ?? "Unknown"}
          </span>
        </div>
      </div>
      {redirect?.loopbackOnly ? (
        <div
          role="status"
          data-testid="mcp-loopback-warning"
          className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-4 py-3 text-[13px] text-[var(--dls-text-primary)]"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--ow-warning)]" aria-hidden />
          <span>
            This app returns to your own computer ({redirect.host}). Anything running on this computer could use this access, so only continue if you started this sign-in here just now.
          </span>
        </div>
      ) : null}
    </div>
  );
}
