"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronRight, LockKeyhole } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { getWebRoute } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  disconnectGatewayMemberConnection, gatewayMemberConnectionKey, gatewayMemberAuthorizationCompleted,
  loadGatewayMemberConnections, startGatewayMemberConnection, type GatewayMemberConnection,
} from "./gateway-member-connections-data";

const WAIT_MS = 10 * 60 * 1000;

type Pending = { key: string; startedAt: number; authUrl: string; authorizationRevision: string | null };

export function GatewayMemberConnectionsScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { user } = useDenFlow();
  return <GatewayMemberConnectionsPanel key={`${orgId}:${user?.id}`} orgId={orgId} userId={user?.id ?? null} orgSlug={orgSlug} />;
}

export function GatewayMemberConnectionsPanel({ orgId, userId, orgSlug }: { orgId: string | null; userId: string | null; orgSlug: string | null }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<GatewayMemberConnection | null>(null);
  const action = useRef<AbortController | null>(null);
  const query = useQuery({
    queryKey: ["gateway-member-connections", orgId, userId],
    enabled: Boolean(orgId && userId),
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error("Select an organization first.");
      return loadGatewayMemberConnections(orgId, signal);
    },
    refetchInterval: pending ? 5000 : false,
    refetchOnWindowFocus: "always",
  });
  const rows = query.data ?? [];

  useEffect(() => () => { action.current?.abort(); }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(null);
      setMessage("Sign-in not confirmed. Refresh status or retry Connect / Reconnect.");
    }, Math.max(0, WAIT_MS - (Date.now() - pending.startedAt)));
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!pending || !query.data || query.isFetching || query.isError) return;
    const current = query.data.find((row) => gatewayMemberConnectionKey(row) === pending.key);
    if (!current?.hasAccess) {
      setPending(null);
      setError(null);
      setMessage("Access removed. Ask your administrator to restore access; Disconnect is still available for retained credentials.");
    } else if (current.configurationRequired) {
      setPending(null);
      setError(null);
      setMessage("Administrator action required. Repair the Google OAuth client, then refresh status.");
    } else if (gatewayMemberAuthorizationCompleted(current, pending.authorizationRevision)) {
      setPending(null);
      setMessage("Google authorization completed. Token ready; model access not verified.");
    }
  }, [pending, query.data, query.isFetching, query.isError]);

  async function connect(row: GatewayMemberConnection) {
    if (!orgId || busy || !row.hasAccess || row.configurationRequired) return;
    action.current?.abort();
    const controller = new AbortController();
    action.current = controller;
    setBusy(gatewayMemberConnectionKey(row));
    setError(null);
    setMessage(null);
    setPending(null);
    try {
      const snapshot = await query.refetch({ throwOnError: true });
      if (controller.signal.aborted) return;
      const current = snapshot.data?.find((connection) => gatewayMemberConnectionKey(connection) === gatewayMemberConnectionKey(row));
      if (!current?.hasAccess) throw new Error("Access to this credential set was removed. Ask your administrator to restore access before connecting.");
      const authUrl = await startGatewayMemberConnection(orgId, current, controller.signal);
      if (controller.signal.aborted) return;
      setPending({ key: gatewayMemberConnectionKey(current), startedAt: Date.now(), authUrl, authorizationRevision: current.authorizationRevision });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not start sign-in. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function disconnect(row: GatewayMemberConnection) {
    if (!orgId || busy) return;
    action.current?.abort();
    const controller = new AbortController();
    action.current = controller;
    setBusy(gatewayMemberConnectionKey(row));
    setPending(null);
    setError(null);
    setMessage(null);
    try {
      await disconnectGatewayMemberConnection(orgId, row, controller.signal);
      if (controller.signal.aborted) return;
      setDisconnecting(null);
      setMessage("Disconnected. Refresh models in Desktop or Web; shared Google connections may need reconnection.");
      await query.refetch();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Disconnect was not confirmed. Refresh status before retrying.");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  return <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 text-sm text-[var(--dls-text-primary)]">
    <DenPageHeader title="My model connections" className="[&_h1]:text-xl [&_h1]:leading-tight [&_h1]:text-[var(--dls-text-primary)]" action={<DenButton size="sm" variant="secondary" disabled={query.isFetching || Boolean(busy)} onClick={() => void query.refetch()}>Refresh status</DenButton>} />
    {query.isPending ? <div aria-busy="true" aria-label="Loading connections" className="flex h-12 items-center justify-between gap-3 border-b border-[var(--dls-border)] px-3"><span className="h-4 w-48 rounded bg-[var(--dls-hover)]" /><span className="h-8 w-28 rounded bg-[var(--dls-hover)]" /></div> : null}
    {query.error || error ? <DenNotice tone="error" message={error ?? query.error?.message} /> : null}
    {query.isError && query.dataUpdatedAt ? <p className="text-[var(--dls-text-secondary)]">Last checked {new Date(query.dataUpdatedAt).toLocaleTimeString()}. Refresh status to verify.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!query.isPending && !query.isError && !query.data?.length ? <p role="status">No model connections are currently assigned. Ask your administrator to assign access.</p> : null}
    <div className="divide-y divide-[var(--dls-border)]">
      {rows.map((row) => {
        const key = gatewayMemberConnectionKey(row);
        const blocked = !row.hasAccess || row.configurationRequired;
        const waiting = pending?.key === key && !blocked;
        return <section key={key} aria-label={`${row.providerName} / ${row.name}`} className="py-2">
          <div className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2">
            <h2 className="min-w-0 flex-1 break-words font-medium">{row.providerName} / {row.name}</h2>
            {blocked ? <LockKeyhole aria-hidden="true" className="size-4 text-[var(--dls-text-secondary)]" strokeWidth={1.5} /> : null}
            <DenBadge tone="neutral">{!row.hasAccess ? "Access removed" : row.configurationRequired ? "Administrator action required" : row.ready ? "Google token ready" : row.hasCredential ? "Reconnect required" : "Sign-in required"}</DenBadge>
            <DenButton size="sm" variant={row.hasCredential ? "secondary" : "primary"} aria-describedby={blocked ? `${key}-blocked` : undefined} disabled={Boolean(busy) || waiting || query.isError || blocked} loading={busy === key} onClick={() => void connect(row)}>{row.hasCredential ? "Reconnect with Google" : "Connect with Google"}</DenButton>
          </div>
          {blocked ? <p id={`${key}-blocked`} className="px-3 pb-2 text-[var(--dls-text-secondary)]">{!row.hasAccess ? "Ask your administrator to restore model access." : "Ask your administrator to repair the Google OAuth client, then refresh status."}</p> : null}
          {row.hasCredential || waiting ? <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-3 py-2">
            <p className="break-words text-[var(--dls-text-secondary)]">{row.hasCredential && row.accountEmail ? `Connected as ${row.accountEmail}` : row.hasCredential ? "Google credential retained" : "Sign-in pending"}</p>
            <DenButton size="sm" variant="ghost" disabled={Boolean(busy) || query.isError} onClick={() => setDisconnecting(row)}>Disconnect</DenButton>
          </div> : null}
          {waiting && pending ? <div className="flex flex-col gap-3 px-3 py-3">
            <p role="status">Waiting for Google sign-in. Use the OpenWork account that started Connect.</p>
            <p>Authorize Google Cloud access for OpenWork; failed sign-in cleanup may revoke previous or other connections using the same OAuth client.</p>
            <div className="flex flex-wrap gap-3">
              <a className={buttonVariants({ size: "sm" })} href={pending.authUrl} target="_blank" rel="noopener noreferrer">Continue sign-in in browser</a>
              <DenButton size="sm" variant="secondary" onClick={() => { setPending(null); setMessage("Stopped waiting; authorization not revoked. Refresh status after browser sign-in, or retry Connect / Reconnect."); }}>Stop waiting</DenButton>
            </div>
          </div> : null}
          {disconnecting && gatewayMemberConnectionKey(disconnecting) === key ? <DenNotice tone="warning" message={<span className="flex flex-col gap-3"><span>Disconnect Google for {row.name} and cancel pending sign-ins? Other connections sharing this Google grant may be revoked too; reconnect to restore access.</span><span className="flex flex-wrap gap-3"><DenButton size="sm" variant="destructive" disabled={Boolean(busy)} onClick={() => void disconnect(row)}>Confirm disconnect</DenButton><DenButton size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => setDisconnecting(null)}>Keep connection</DenButton></span></span>} /> : null}
        </section>;
      })}
    </div>
    <details className="group border-t border-[var(--dls-border)] py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-[var(--dls-accent)] [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" strokeWidth={1.5} className="size-4 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />Technical details</summary>
      <div className="flex flex-col gap-3 pt-3 text-[var(--dls-text-secondary)]">
        <p>Use the same OpenWork account and organization in the browser. Your Google email may differ, but that account needs access to the configured Vertex project. Google tokens stay on the server; this is separate from Google Workspace tool connections.</p>
        <p>Google session policies can require sign-in again; unattended operation is not guaranteed. A ready token does not verify Vertex IAM or model access, and an existing token does not confirm a replacement sign-in.</p>
        <p>If sign-in fails after Google issues tokens, cleanup revocation may affect your previous connection and other connections sharing the OAuth client. Reconnect any affected accounts. Disconnect also cancels pending sign-ins; it does not delete the organization’s OAuth app.</p>
        <p>For redirect_uri_mismatch or invalid_client, ask an administrator to check the Web OAuth client and exact callback. For model access denied after consent, check Vertex IAM, project/location and partner-model access. For Google reauthentication, reconnect.</p>
        <p>After connecting or disconnecting, refresh models in OpenWork Web or sync AI Providers in Desktop.</p>
      </div>
    </details>
    <Link className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })} href={getWebRoute(orgSlug)}>Return to OpenWork Web</Link>
  </div>;
}
