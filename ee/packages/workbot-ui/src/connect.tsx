"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useWorkbotConnections, type WorkbotConnection } from "./data";
import { workbotHost } from "./host";
import { readConnectionResult } from "./connect-result";

const startedSchema = z.object({ authorizeUrl: z.string().url().nullable(), callbackOrigin: z.string().url() });
type Attempt = { id: string; requestId: string; inline: boolean; popup: Window | null; callbackOrigin: string | null; result: boolean | null; startedAt: number; closedReads: number };
const buttonClass = "h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-colors duration-150 hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

/** Provider completion is only a wake-up signal: Connected always comes from Den's fresh readiness read. */
export function useWorkbotConnect() {
  const client = useQueryClient();
  const attempt = useRef<Attempt | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [sameTabUrl, setSameTabUrl] = useState<string | null>(null);
  const connections = useWorkbotConnections({ enabled: true, waiting: pendingId !== null });
  const refresh = (resources = false) => {
    void client.invalidateQueries({ queryKey: ["workbot", "connections"] });
    if (resources) {
      void client.invalidateQueries({ queryKey: ["workbot", "calendar"] });
      void client.invalidateQueries({ queryKey: ["documents"] });
    }
  };
  const finish = (message?: string) => {
    const current = attempt.current;
    if (current && message) setError({ id: current.id, message });
    attempt.current = null;
    setPendingId(null);
    setSameTabUrl(null);
  };
  useEffect(() => {
    const current = attempt.current;
    const returned = current && (!current.inline || current.result === true || (current.popup?.closed && !sameTabUrl));
    if (current && returned && pendingId && connections.dataUpdatedAt >= current.startedAt && connections.data?.find(connection => connection.id === pendingId)?.ready) {
      refresh(true);
      finish();
    }
  }, [connections.data, connections.dataUpdatedAt, pendingId, sameTabUrl]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const current = attempt.current;
      if (!current) return;
      const result = readConnectionResult(event, current);
      if (!result) return;
      current.result = result.ok;
      current.startedAt = Date.now();
      refresh();
      if (!result.ok) finish("Connection wasn't completed. Try again, or ask an admin to review the app's permissions.");
    };
    window.addEventListener("message", receive);
    const timer = window.setInterval(() => {
      const current = attempt.current;
      if (!current) return;
      if (current.popup?.closed && current.result === null && !sameTabUrl) {
        current.closedReads += 1;
        if (current.closedReads >= 2) { refresh(); finish("Connection wasn't completed or expired. Try again."); }
      }
      if (Date.now() - current.startedAt > (current.result === true ? 30_000 : 10 * 60_000)) finish("Couldn't verify the connection. Check your access and try again.");
    }, 1000);
    return () => { window.removeEventListener("message", receive); window.clearInterval(timer); };
  }, [sameTabUrl]);
  const start = async (connection: WorkbotConnection) => {
    if (attempt.current) { attempt.current.popup?.focus(); return; }
    setError(null);
    if (connection.connectMode === "admin") { setError({ id: connection.id, message: "An admin must finish setting up this app before you can connect." }); return; }
    if (connection.connectMode !== "inline") {
      if (!connection.connectUrl) return;
      window.open(connection.connectUrl, "_blank", "noopener,noreferrer");
      attempt.current = { id: connection.id, requestId: crypto.randomUUID(), inline: false, popup: null, callbackOrigin: null, result: null, startedAt: Date.now(), closedReads: 0 };
      setPendingId(connection.id);
      return;
    }
    const requestId = crypto.randomUUID();
    // Open while handling the click, before the network request, so browser popup blocking is predictable.
    const popup = window.open("", `workbot-connect-${requestId}`, "popup,width=520,height=720");
    const current: Attempt = { id: connection.id, requestId, inline: true, popup, callbackOrigin: null, result: null, startedAt: Date.now(), closedReads: 0 };
    attempt.current = current;
    setPendingId(connection.id);
    try {
      const { response, payload } = await workbotHost().requestJson(`/v1/workbot/connections/${encodeURIComponent(connection.id)}/connect/start`, { method: "POST", body: JSON.stringify({ requestId, returnPath: `${window.location.pathname}${window.location.search}${window.location.hash}` }) }, 30_000);
      if (!response.ok) {
        refresh();
        throw new Error(response.status === 403 ? "Your sign-in or team access doesn't allow this connection. Sign in again, or ask an admin to review access." : response.status === 404 || response.status === 409 ? "Connection isn't available here. An admin can review the app's setup; you can also finish from your workspace connections page." : "Couldn't start connecting. Try again, or ask an admin to review access.");
      }
      const started = startedSchema.parse(payload);
      if (attempt.current !== current) { popup?.close(); return; }
      current.callbackOrigin = new URL(started.callbackOrigin).origin;
      if (!started.authorizeUrl) { popup?.close(); current.result = true; current.startedAt = Date.now(); refresh(); return; }
      const authorize = new URL(started.authorizeUrl);
      if (authorize.protocol !== "https:" && !(authorize.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(authorize.hostname))) throw new Error("The app's consent address is not secure. Ask an admin to review it.");
      if (popup && !popup.closed) popup.location.replace(authorize.toString());
      else setSameTabUrl(authorize.toString());
    } catch (failure) {
      popup?.close();
      finish(failure instanceof Error ? failure.message : "Couldn't start connecting. Try again.");
    }
  };
  return { connections, pendingId, error, sameTabUrl, start, cancel: () => { attempt.current?.popup?.close(); finish(); }, continueInTab: () => { if (sameTabUrl) window.location.assign(sameTabUrl); } };
}

type ConnectFlow = ReturnType<typeof useWorkbotConnect>;
export function WorkbotConnectionButton({ connection, flow, label = "Connect" }: { connection: WorkbotConnection; flow: ConnectFlow; label?: string }) {
  const waiting = flow.pendingId === connection.id;
  return <span className="inline-flex flex-wrap items-center gap-2">
    {connection.connectMode === "admin" ? <span role="status" className="text-[13px] text-[var(--wb-muted)]">Needs admin setup</span>
      : <button type="button" className={buttonClass} disabled={Boolean(flow.pendingId) || (!connection.connectUrl && connection.connectMode !== "inline")} onClick={() => void flow.start(connection)}>{label}</button>}
    {waiting && <><span role="status" className="text-[13px] text-[var(--wb-muted)]">{flow.sameTabUrl ? "Consent window was blocked" : connection.connectMode === "inline" ? "Finish in the consent window" : "Finish in the new tab"}</span>{flow.sameTabUrl && <button type="button" className={buttonClass} onClick={flow.continueInTab}>Continue in this tab</button>}<button type="button" className={buttonClass} onClick={flow.cancel}>Cancel</button></>}
    {flow.error?.id === connection.id && <span role="alert" className="text-[13px] text-[var(--wb-muted)]">{flow.error.message}</span>}
  </span>;
}

/** Match the actual assigned connector, not a dashboard-wide link or another provider's account. */
export function WorkbotConnectAction({ flow, provider, connectionId, label, fallbackHref }: { flow: ConnectFlow; provider: "google-workspace" | "microsoft-365"; connectionId?: string; label: string; fallbackHref?: string | null }) {
  const matches = flow.connections.data?.filter(connection => connectionId ? connection.id === connectionId : connection.nativeProviderKey === provider) ?? [];
  if (flow.connections.isPending) return <span role="status">Checking connection</span>;
  if (flow.connections.isError) return <span role="status">Couldn&apos;t verify your connections. <button type="button" onClick={() => void flow.connections.refetch()}>Try again</button></span>;
  if (matches.length === 0) return <span role="status" className="inline-flex flex-wrap items-center gap-2">
    <span>Couldn&apos;t verify an account to connect here.</span>
    {fallbackHref ? <a href={fallbackHref} target="_blank" rel="noopener noreferrer">Open connection settings</a> : <span>Ask an admin to review setup and access.</span>}
  </span>;
  return <span className="inline-flex flex-wrap items-center gap-2">{matches.map(connection => <WorkbotConnectionButton key={connection.id} connection={connection} flow={flow} label={matches.length > 1 ? `${label}: ${connection.name}` : label} />)}</span>;
}
