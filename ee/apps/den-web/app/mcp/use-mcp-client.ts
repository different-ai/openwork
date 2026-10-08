"use client";

import { useEffect, useState } from "react";
import { denApiCredentials, denBrowserEndpoint } from "../(den)/_lib/den-api-origin";
import { getRuntimeConfig } from "../(den)/_lib/runtime-config";

export type McpClient = {
  /** The name the app registered, or null when it shared none. */
  name: string | null;
  logoUri: string | null;
  clientId: string | null;
  loaded: boolean;
  /** The server accepted the signed query and returned public client metadata. */
  metadataResolved?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A readable name when the app registered none: the host of a metadata-document client id. */
export function fallbackMcpClientName(clientId: string | null): string | null {
  if (!clientId) return null;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/** Parses Better Auth's public client response (DCR or Client ID Metadata Document). */
export function readPublicMcpClient(payload: unknown): { name: string | null; logoUri: string | null } {
  if (!isRecord(payload)) return { name: null, logoUri: null };
  const name = typeof payload.client_name === "string" && payload.client_name.trim() ? payload.client_name.trim().slice(0, 80) : null;
  const logoUri = typeof payload.logo_uri === "string" && payload.logo_uri.startsWith("https://") ? payload.logo_uri : null;
  return { name, logoUri };
}

async function loadPublicClient(clientId: string, oauthQuery: string) {
  await getRuntimeConfig();
  // The prelogin variant is authorized by the signed OAuth query itself, so it
  // works before the person has an account.
  const endpoint = denBrowserEndpoint("/api/auth/oauth2/public-client-prelogin");
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: denApiCredentials(endpoint),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, oauth_query: oauthQuery }),
  }).catch(() => null);
  if (!response?.ok) return { name: null, logoUri: null, metadataResolved: false };
  const payload: unknown = await response.json().catch(() => null);
  return { ...readPublicMcpClient(payload), metadataResolved: isRecord(payload) };
}

/**
 * Which app is asking, from the signed authorize query the page was opened
 * with. Pass "" until the query is known; the result stays unloaded until then.
 */
export function useMcpClient(oauthQuery: string): McpClient {
  const clientId = oauthQuery ? new URLSearchParams(oauthQuery).get("client_id") : null;
  const [loadedClient, setLoadedClient] = useState<{ clientId: string; name: string | null; logoUri: string | null; metadataResolved: boolean } | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void loadPublicClient(clientId, oauthQuery).then((client) => {
      if (cancelled) return;
      setLoadedClient({ clientId, name: client.name ?? fallbackMcpClientName(clientId), logoUri: client.logoUri, metadataResolved: client.metadataResolved });
    });
    return () => {
      cancelled = true;
    };
  }, [clientId, oauthQuery]);

  if (clientId && loadedClient?.clientId === clientId) {
    return { name: loadedClient.name, logoUri: loadedClient.logoUri, clientId, loaded: true, metadataResolved: loadedClient.metadataResolved };
  }
  return { name: null, logoUri: null, clientId, loaded: Boolean(oauthQuery) && !clientId };
}
