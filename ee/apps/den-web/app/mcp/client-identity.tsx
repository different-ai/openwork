"use client";

import { SetupLine, type SetupFact } from "../(den)/_components/setup-frame-parts";
import { describeMcpRedirect, type McpRedirectDescription } from "./client-identity-model";
import { McpAppFact } from "./mcp-story";
import type { McpClient } from "./use-mcp-client";
import { knownMcpCimdDomain, mcpCimdDomain } from "./client-trust-constants";

/** Where the approval is sent, from the signed authorize query. */
export function useMcpRedirect(oauthQuery: string): McpRedirectDescription | null {
  return describeMcpRedirect(oauthQuery ? new URLSearchParams(oauthQuery).get("redirect_uri") : null);
}

/** The App and Returns to rows that lead every consent panel (P9). */
export function mcpIdentityFacts(client: McpClient, redirect: McpRedirectDescription | null): { app: SetupFact; returnsTo: SetupFact } {
  const domain = mcpCimdDomain(client.clientId);
  return {
    app: { label: "App", value: (
      <span className="flex min-w-0 flex-col items-end gap-1">
        <span className="flex min-w-0 items-center gap-2"><McpAppFact client={client} /></span>
        {domain ? <span dir="ltr" className="break-all whitespace-normal font-mono text-xs" data-testid="mcp-client-domain">{domain}</span> : null}
      </span>
    ) },
    returnsTo: { label: "Returns to", value: redirect?.host ?? "Unknown", mono: true, testId: "mcp-redirect-host" },
  };
}

/** Registration and a signed OAuth request do not verify the app's publisher. */
export function McpUnverifiedAppWarning({ redirect, client }: { redirect: McpRedirectDescription | null; client?: McpClient }) {
  // Wait for the signed-query public-client lookup to succeed before recognizing
  // a domain. Never infer trust from a DCR callback, name, or logo.
  const knownDomain = client?.loaded && client.metadataResolved ? knownMcpCimdDomain(client.clientId) : null;
  if (knownDomain) {
    return (
      <section aria-label="Application identity" className="flex min-w-0 flex-col gap-2" data-testid="mcp-known-app-identity">
        <SetupLine>Application information provided by <span className="font-medium" data-testid="mcp-identity-domain">{knownDomain}</span>.</SetupLine>
        <SetupLine>Only authorize if you started this connection and trust the app with the permissions shown.</SetupLine>
      </section>
    );
  }
  return (
    <section aria-label="Unverified application" className="flex min-w-0 flex-col gap-2 border-l-2 border-[var(--dls-text-secondary)] pl-3" data-testid="mcp-unverified-app-warning">
      <SetupLine><strong className="font-semibold">Unverified application</strong></SetupLine>
      <SetupLine>
        OpenWork has not verified who is requesting this access. Only authorize if you started this connection and trust the app to act on your behalf with the permissions shown.
      </SetupLine>
      {redirect ? (
        <div className="flex min-w-0 flex-col gap-1">
          <SetupLine>Check the return host supplied by this app:</SetupLine>
          <span dir="ltr" className="break-all font-mono text-xs leading-5 text-[var(--dls-text-primary)]" data-testid="mcp-warning-redirect-host">{redirect.host}</span>
        </div>
      ) : (
        <SetupLine>Return address unavailable. Cancel and restart the connection from the app you intended to use.</SetupLine>
      )}
    </section>
  );
}

/**
 * One plain line above the button when the return address needs a second
 * look: a loopback-only redirect (anything on this computer could use the
 * access) or an app that shared no name (name the host to check).
 */
export function McpReturnLine({ client, redirect, short = false }: { client: McpClient; redirect: McpRedirectDescription | null; short?: boolean }) {
  if (!client.loaded) return null;
  if (redirect?.loopbackOnly) {
    return (
      <p className="m-0 text-[13px] leading-5 text-[var(--setup-ink-soft)]" role="status" data-testid="mcp-loopback-warning">
        {short
          ? "This app returns to your own computer. Only continue if you started this sign-in here just now."
          : "This app returns to your own computer. Anything running on it could use this access, so only continue if you started this sign-in here just now."}
      </p>
    );
  }
  if (!client.name && redirect) {
    return (
      <p className="m-0 text-[13px] leading-5 text-[var(--setup-ink-soft)]" role="status" data-testid="mcp-unnamed-app-line">
        This app did not share its name. Only continue if you know {redirect.host} and started this sign-in.
      </p>
    );
  }
  return null;
}
