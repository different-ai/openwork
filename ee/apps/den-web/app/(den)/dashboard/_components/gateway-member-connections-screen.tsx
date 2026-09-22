"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
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
      setMessage("Sign-in has not been confirmed. Check the browser, then Refresh status. If it expired or was canceled, choose Connect or Reconnect to retry.");
    }, Math.max(0, WAIT_MS - (Date.now() - pending.startedAt)));
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!pending || !query.data || query.isFetching || query.isError) return;
    const current = query.data.find((row) => gatewayMemberConnectionKey(row) === pending.key);
    if (!current?.hasAccess) {
      setPending(null);
      setError("Access to this credential set was removed. You can still disconnect a retained credential. Ask your administrator to restore access before connecting again.");
    } else if (current.configurationRequired) {
      setPending(null);
      setError("Administrator action required. Ask your administrator to repair the Google OAuth client, then refresh status before connecting again.");
    } else if (gatewayMemberAuthorizationCompleted(current, pending.authorizationRevision)) {
      setPending(null);
      setMessage("Google authorization completed; your token is ready. Vertex IAM and model access have not been verified. Return to OpenWork Web to refresh its models, or sync AI Providers in Desktop.");
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
      setMessage("Disconnected from this set. Refresh models in any open Desktop or Web session. Other connections using the same Google grant may also need to reconnect.");
      await query.refetch();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Disconnect was not confirmed. Refresh status before retrying.");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  return <DashboardPageTemplate title="My Model Connections" description="Your personal AI Gateway sign-ins, including assigned sets with no token and retained credentials after access changes. This is separate from Google Workspace tool connections." colors={["#DBEAFE", "#1E3A8A", "#2563EB", "#93C5FD"]}>
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-3">
        <DenButton variant="secondary" disabled={query.isFetching || Boolean(busy)} onClick={() => void query.refetch()}>Refresh status</DenButton>
        <Link className={buttonVariants({ variant: "secondary" })} href={getWebRoute(orgSlug)}>Return to OpenWork Web</Link>
      </div>
      <DenNotice tone="info" message="Sign in to the browser with the same OpenWork account and organization. Then choose a Google account with access to the configured Vertex project; its email need not match OpenWork. Tokens stay on the server. Google session policies can require sign-in again, so this connection does not guarantee unattended operation." />
      {query.isPending ? <p role="status">Loading your connections…</p> : null}
      {query.error || error ? <DenNotice tone="error" message={error ?? query.error?.message} /> : null}
      {message ? <DenNotice tone="info" message={message} /> : null}
      {!query.isPending && !query.isError && !query.data?.length ? <DenNotice tone="neutral" message="No model connections are currently assigned to you. Ask your administrator to assign a model group and credential set; you do not need a ready model to connect." /> : null}
      {rows.map((row) => {
        const key = gatewayMemberConnectionKey(row);
        const waiting = pending?.key === key && !row.configurationRequired;
        return <section key={key} aria-label={`${row.providerName} / ${row.name}`} className="flex flex-col gap-3 border-b pb-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{row.providerName} / {row.name}</h2><DenBadge tone={row.hasAccess && row.ready && !row.configurationRequired ? "success" : "neutral"}>{!row.hasAccess ? "Access removed" : row.configurationRequired ? "Administrator action required" : row.ready ? "Google token ready" : row.hasCredential ? "Reconnect required" : "Sign-in required"}</DenBadge></div>
          {row.hasCredential && row.accountEmail ? <p className="text-sm">Connected as {row.accountEmail}</p> : null}
          {row.configurationRequired ? <DenNotice tone="warning" message="Administrator action required. Ask your administrator to repair the Google OAuth client, then refresh status. Signing in again cannot repair the client configuration. You can still disconnect your retained credential." /> : null}
          {!row.hasAccess ? <DenNotice tone="warning" message="Your model grant or provider is no longer active. You cannot connect or use this set; you can still disconnect your retained Google credential." /> : null}
          <div className="flex flex-wrap gap-3">
            {row.hasAccess ? <DenButton disabled={Boolean(busy) || waiting || query.isError || row.configurationRequired} loading={busy === key} onClick={() => void connect(row)}>{row.hasCredential ? "Reconnect with Google" : "Connect with Google"}</DenButton> : null}
            {row.hasCredential || waiting ? <DenButton variant="secondary" disabled={Boolean(busy) || query.isError} onClick={() => setDisconnecting(row)}>Disconnect</DenButton> : null}
          </div>
          {waiting && pending ? <DenNotice tone="info" message={<span className="flex flex-col gap-3">
            <span>Waiting for Google sign-in to complete. Open the browser link below, finish consent, then return here. Status refreshes automatically; an existing ready token does not confirm a new sign-in or continued Google access. If sign-in fails after Google issues tokens, cleanup revocation may affect your previous connection and other Google connections using the same OAuth client. You may need to reconnect them.</span>
            <a className={buttonVariants({ variant: "secondary" })} href={pending.authUrl} target="_blank" rel="noopener noreferrer">Continue sign-in in browser</a>
            <DenButton variant="secondary" onClick={() => { setPending(null); setMessage("Stopped waiting, not revoked. You can refresh status after finishing in the browser, or retry Connect/Reconnect. Disconnect cancels pending sign-ins and revokes this set's credential."); }}>Stop waiting</DenButton>
          </span>} /> : null}
          {disconnecting && gatewayMemberConnectionKey(disconnecting) === key ? <DenNotice tone="warning" message={<span className="flex flex-col gap-3"><span>Disconnect your credential for {row.name} and cancel pending sign-ins? Google may also revoke other connections sharing the same grant. This does not delete the organization’s OAuth app.</span><span className="flex gap-3"><DenButton variant="destructive" disabled={Boolean(busy)} onClick={() => void disconnect(row)}>Confirm disconnect</DenButton><DenButton variant="secondary" disabled={Boolean(busy)} onClick={() => setDisconnecting(null)}>Keep connection</DenButton></span></span>} /> : null}
        </section>;
      })}
      <DenNotice tone="neutral" message="If Google reports redirect_uri_mismatch or invalid_client, ask an administrator to check the Web OAuth client and exact callback. If a model request is denied after consent, check Vertex IAM, project/location and partner-model access. If Google requests reauthentication, reconnect rather than repeatedly retrying inference." />
    </div>
  </DashboardPageTemplate>;
}
