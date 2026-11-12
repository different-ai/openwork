"use client";

import { ChevronLeft, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DenBadge, type DenBadgeTone } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getRequestError, isReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, parseOrgSsoConnectionsPayload, type DenOrgSsoConnection } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { SsoConnectionPanel, ssoConnectionEndpoints } from "./sso-connection-panel";

/** What a connection needs next, or that it signs people in. Neutral unless it needs attention (DESIGN.md V2). */
export function ssoConnectionState(connection: DenOrgSsoConnection): { label: string; tone: DenBadgeTone } {
  if (connection.status === "enabled") return { label: "On", tone: "success" };
  if (!connection.domainVerified) return { label: connection.domains.length > 1 ? "Verify domains" : "Verify domain", tone: "warning" };
  if (connection.testStatus === "testing") return { label: "Testing", tone: "neutral" };
  if (connection.testStatus === "failed") return { label: "Test failed", tone: "danger" };
  if (connection.testStatus === "succeeded") return { label: "Ready to enable", tone: "neutral" };
  return { label: "Not tested", tone: "neutral" };
}

type Selection = { kind: "list" } | { kind: "new" } | { kind: "connection"; id: string; token: string | null };

export type SsoConnectionsManagerProps = {
  /** `?setup=1`: with no connection yet, open the form to add the first one. */
  setupMode?: boolean;
  /** Every connection after each load, for the page's intro facts. */
  onConnectionsChange?: (connections: DenOrgSsoConnection[]) => void;
};

/** multipleSsoConnections: every SSO connection with its state, one row each, and one connection at a time to set up. */
export function SsoConnectionsManager({ setupMode = false, onConnectionsChange }: SsoConnectionsManagerProps) {
  const { orgId, orgContext, runReauthableAction } = useOrgDashboard();
  const [connections, setConnections] = useState<DenOrgSsoConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "list" });
  const access = useMemo(
    () => getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.currentMember.permissions],
  );

  async function loadConnections(isCurrent = () => true) {
    if (!orgId) return;
    try {
      const { response, payload } = await requestJson("/v1/sso/connections", { method: "GET", headers: { "x-openwork-legacy-org-id": orgId } }, 12000);
      if (!response.ok) throw getRequestError(payload, response, `Failed to load SSO connections (${response.status}).`);
      const next = parseOrgSsoConnectionsPayload(payload);
      if (!isCurrent()) return;
      setConnections(next);
      setError(null);
      onConnectionsChange?.(next);
    } catch (nextError) {
      if (isReauthRequiredError(nextError)) throw nextError;
      if (isCurrent()) setError(nextError instanceof Error ? nextError.message : "Failed to load SSO connections.");
    }
  }

  useEffect(() => {
    let active = true;
    void runReauthableAction("load-sso-connections", () => loadConnections(() => active)).catch((nextError) => {
      if (active) setError(nextError instanceof Error ? nextError.message : "Failed to load SSO connections.");
    });
    return () => {
      active = false;
    };
  }, [orgId]);

  useEffect(() => {
    if (setupMode && connections?.length === 0 && access.canManageSso) setSelection({ kind: "new" });
  }, [setupMode, connections?.length, access.canManageSso]);

  /** A change inside one connection: keep the list (and the page's intro facts) current. */
  function replaceConnection(connection: DenOrgSsoConnection | null, id: string) {
    const current = connections ?? [];
    const next = connection
      ? current.some((entry) => entry.id === id) ? current.map((entry) => entry.id === id ? connection : entry) : [...current, connection]
      : current.filter((entry) => entry.id !== id);
    setConnections(next);
    onConnectionsChange?.(next);
  }

  function backToList() {
    setSelection({ kind: "list" });
    void loadConnections();
  }

  if (selection.kind !== "list") {
    const selected = selection.kind === "connection" ? connections?.find((entry) => entry.id === selection.id) ?? null : null;
    return (
      <div data-testid="sso-connection-detail">
        <div className="mb-4 flex items-center gap-2">
          <DenButton variant="ghost" size="sm" icon={ChevronLeft} onClick={backToList}>All connections</DenButton>
          <span className="truncate text-[14px] font-semibold text-gray-900">{selection.kind === "new" ? "New SSO connection" : selected?.displayName ?? ""}</span>
        </div>
        {selection.kind === "new" ? (
          <SsoConnectionPanel
            key="new"
            multiple
            endpoints={ssoConnectionEndpoints(null)}
            onCreated={(connection, token) => {
              replaceConnection(connection, connection.id);
              setSelection({ kind: "connection", id: connection.id, token });
            }}
          />
        ) : (
          <SsoConnectionPanel
            key={selection.id}
            multiple
            endpoints={ssoConnectionEndpoints(selection.id)}
            initialDomainVerificationToken={selection.token}
            onConnectionChange={(connection) => {
              if (connection) replaceConnection(connection, selection.id);
            }}
            onDeleted={() => {
              replaceConnection(null, selection.id);
              backToList();
            }}
          />
        )}
      </div>
    );
  }

  const enabledCount = connections?.filter((connection) => connection.status === "enabled").length ?? 0;

  return (
    <div data-testid="sso-connections">
      {error ? <DenNotice message={error} className="mb-6" /> : null}
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[14px] text-gray-500" data-testid="sso-connections-summary">
          {connections === null ? "" : connections.length === 0 ? "No SSO connections yet" : `${enabledCount} of ${connections.length} ${connections.length === 1 ? "connection" : "connections"} on`}
        </p>
        <DenButton variant="primary" icon={Plus} onClick={() => setSelection({ kind: "new" })} disabled={!access.canManageSso || !orgContext?.entitlements.sso}>
          Add SSO connection
        </DenButton>
      </div>
      {connections === null ? (
        <DenList>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-3 px-6 py-4">
              <div className="flex-1 space-y-2"><DenSkeleton className="h-4 w-40" /><DenSkeleton className="h-3 w-56" /></div>
              <DenSkeleton className="h-6 w-20 rounded-full" />
            </div>
          ))}
        </DenList>
      ) : connections.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white px-6 py-8 text-[14px] text-gray-500">
          Add a connection for each identity provider your people sign in with.
        </div>
      ) : (
        <DenList>
          {connections.map((connection) => {
            const state = ssoConnectionState(connection);
            return (
              <DenListRow
                key={connection.id}
                dataAttributes={{ "data-testid": "sso-connection-row", "data-connection-id": connection.id }}
                title={connection.displayName}
                chips={<DenBadge size="sm" tone="neutral">{connection.kind.toUpperCase()}</DenBadge>}
                meta={connection.domains.join(", ") || connection.domain}
                ariaLabel={`Manage ${connection.displayName}`}
                onClick={() => setSelection({ kind: "connection", id: connection.id, token: null })}
                action={<DenBadge tone={state.tone}>{state.label}</DenBadge>}
              />
            );
          })}
        </DenList>
      )}
    </div>
  );
}
