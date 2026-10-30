"use client";

import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getAddConnectorRoute, getLibraryConnectorRoute, getMcpConnectionRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { managedAccessStatus } from "./access-summary";
import { usePrefetchConnectorCatalog } from "./connector-catalog-screen";
import { GOOGLE_WORKSPACE_QUICK_ADD_ID, MICROSOFT_365_QUICK_ADD_ID } from "./connector-catalog";
import { connectorAccountReady, displayedConnectorConnections } from "./connector-detail";
import { assignedConnectorForLibrary } from "./connector-library-navigation";
import { useDenToast } from "./den-toast";
import { ItemPage } from "./item-header";
import { FilterInput, ItemMenu, removeEntry, LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { ConnectorLogoStrip } from "./library-add-dialog";
import { LibraryCompactRow, LibraryCompactSection, LibraryCompactSkeleton, LibraryCompactSurface } from "./library-compact";
import { DenButton } from "../../_components/ui/button";
import { connectorNeedsFirstCheck, connectorReadinessState, connectorReadinessNote } from "./connector-readiness";
import { useCheckMcpConnection, useRefreshUncheckedConnections } from "./mcp-connections-data";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { connectorSetupUnfinished, finishSetupHref } from "./admin-connectors";
import { type ExternalMcpConnection, isNativeProviderConnectionId, useDeleteMcpConnection, useMcpConnections } from "./mcp-connections-data";

/** Show the name filter once more than this many connectors are listed. */
const FILTER_AFTER = 10;

function ConnectorsEmpty({ orgSlug }: { orgSlug: string | null }) {
  const prefetchCatalog = usePrefetchConnectorCatalog();
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center gap-5 rounded-2xl border border-gray-100 bg-white px-6 pb-14 pt-16 text-center" data-testid="connectors-empty">
        <ConnectorLogoStrip size="md" />
        <div className="flex flex-col gap-1.5">
          <p className="text-[15px] font-semibold leading-5 text-gray-900">No connectors yet</p>
          <p className="text-[13px] leading-[18px] text-gray-500">Apps your organization&apos;s AI can use. You choose who gets each one.</p>
        </div>
        <LinkButton variant="primary" href={getAddConnectorRoute(orgSlug)} onPointerEnter={prefetchCatalog} onFocus={prefetchCatalog}>
          <Plus className="h-4 w-4" aria-hidden />
          Add connector
        </LinkButton>
      </div>
      <p className="text-[12px] leading-4 text-gray-400">Members can still add apps for themselves in My Library.</p>
    </div>
  );
}

/** C1 and C5: every connector the organization manages, and who has each one. */
export function AdminConnectorsScreen() {
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const connections = useMcpConnections("manageable");
  const usable = useMcpConnections("usable");
  const deleteConnection = useDeleteMcpConnection();
  const checkConnection = useCheckMcpConnection();
  const canCheck = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canManageConnections : false;
  const prefetchCatalog = usePrefetchConnectorCatalog();
  const [query, setQuery] = useState("");
  const viewerId = orgContext?.currentMember.id ?? null;
  const all = displayedConnectorConnections(connections.data ?? [], usable.data ?? []);
  const needle = query.trim().toLowerCase();
  const visible = needle ? all.filter((connection) => connection.name.toLowerCase().includes(needle)) : all;
  const empty = !connections.isLoading && !connections.error && all.length === 0;

  // Connectors with no stored status are brought up to date once per visit:
  // a member's Ready check is copied, or the connector is checked now.
  const refreshUnchecked = useRefreshUncheckedConnections();
  const requested = useRef(new Set<string>());
  const [firstChecks, setFirstChecks] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!canCheck || !connections.data) return;
    const ids = connections.data.filter((connection) => connectorNeedsFirstCheck(connection) && !requested.current.has(connection.id)).map((connection) => connection.id);
    if (ids.length === 0) return;
    for (const id of ids) requested.current.add(id);
    setFirstChecks((current) => new Set([...current, ...ids]));
    refreshUnchecked.mutateAsync(ids).catch(() => undefined).finally(() => {
      setFirstChecks((current) => new Set([...current].filter((id) => !ids.includes(id))));
    });
  }, [canCheck, connections.data]);

  // Check again runs per row, so one slow service never blocks the others.
  const [rechecking, setRechecking] = useState<ReadonlySet<string>>(new Set());
  function checkAgain(connection: ExternalMcpConnection) {
    setRechecking((current) => new Set([...current, connection.id]));
    checkConnection.mutateAsync(connection.id)
      .catch(() => toast({ title: `Could not check ${connection.name}`, description: "Try again." }))
      .finally(() => setRechecking((current) => new Set([...current].filter((id) => id !== connection.id))));
  }

  async function remove(connection: ExternalMcpConnection) {
    await deleteConnection.mutateAsync(connection.id);
    toast({ title: `${connection.name} is removed`, description: "Nobody can use it anymore." });
  }

  function rowFor(connection: ExternalMcpConnection) {
    const href = getMcpConnectionRoute(orgSlug, connection.id);
    const assignedConnection = assignedConnectorForLibrary( connection.id, usable.data);
    const readinessView = { organization: true, checking: firstChecks.has(connection.id) || rechecking.has(connection.id) };
    const readinessState = connectorReadinessState(connection, readinessView);
    const checkLabel = readinessState === "Not checked" ? "Check now" : "Check again";
    const unfinished = connectorSetupUnfinished(connection);
    const status = unfinished
      ? "Setup not finished"
      : !connection.access && isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)
        ? "Everyone"
        : orgContext ? managedAccessStatus(connection.access, orgContext, viewerId) : "";
    const signInNote = connection.credentialMode === "per_member" && connection.authType === "oauth"
      ? "Each person signs in"
      : connection.authType === "none" ? "No sign-in needed" : connectorAccountReady(connection) ? "One account for everyone" : undefined;
    const menu = (
      <ItemMenu
        label={`More for ${connection.name}`}
        entries={[
          { label: "Open", href },
          ...(assignedConnection ? [{ label: "Open in My Library", href: getLibraryConnectorRoute(orgSlug, assignedConnection.id) }] : []),
          ...(readinessState && canCheck && (connection.credentialMode === "shared" || connection.connectedForMe) ? [{ label: "Check again", onSelect: () => checkAgain(connection) }] : []),
          ...(connection.id === GOOGLE_WORKSPACE_QUICK_ADD_ID || connection.id === MICROSOFT_365_QUICK_ADD_ID
            ? []
            : [removeEntry(connection.name, () => remove(connection))]),
        ]}
      />
    );
    const checkButton = (
      <DenButton size="xs" variant="secondary" loading={readinessState === "Checking…"} disabled={!canCheck || readinessState === "Checking…"} title={!canCheck ? "An admin can check this connection." : undefined}
        onClick={() => checkAgain(connection)}>{checkLabel}</DenButton>
    );
    const action = readinessState === "Couldn't verify" || readinessState === "Not checked" || readinessState === "Checking…" ? checkButton
      : readinessState === "Sign in" && connection.credentialMode === "shared" ? <LinkButton size="xs" href={href}>Reconnect</LinkButton>
      : unfinished ? <LinkButton size="xs" href={finishSetupHref(orgSlug, connection)}>Finish</LinkButton>
      : menu;
    // What an admin must act on. A per-person connector the admin hasn't signed in to
    // themselves is not an organization problem.
    const attention = unfinished || readinessState === "Couldn't verify" || readinessState === "Not checked" || readinessState === "Set up"
      || (readinessState === "Sign in" && connection.credentialMode === "shared");
    const personalSignInPending = readinessState === "Sign in" && connection.credentialMode !== "shared";
    return { href, readinessView, readinessState, status, signInNote, action, attention, personalSignInPending, menu };
  }

  // A short list is read at a glance; the filter earns its place once it runs long.
  const showFilter = all.length > FILTER_AFTER || query !== "";
  const needsAttention = visible.filter((connection) => rowFor(connection).attention);
  const working = visible.filter((connection) => !rowFor(connection).attention);

  function compactRow(connection: ExternalMcpConnection) {
    const row = rowFor(connection);
    const note = row.attention
      ? (connectorReadinessNote(connection, row.readinessView) ?? (row.readinessState === "Sign in" ? "The shared account was signed out." : row.status))
      : row.personalSignInPending ? "Each person signs in (you haven't yet)" : row.signInNote;
    return (
      <div key={connection.id} data-connector-row={connection.name} title={row.readinessState === "Ready" ? connectorReadinessNote(connection, row.readinessView) : undefined}>
        <LibraryCompactRow
          href={row.href}
          kind="connection"
          testName={connection.name}
          logo={<ConnectorLogo name={connection.name} url={connection.url} size="xs" />}
          name={connection.name}
          description={note}
          source={row.attention ? undefined : row.status}
          action={row.attention ? row.action : row.menu}
          revealAction={!row.attention}
        />
      </div>
    );
  }

  return (
    <ItemPage testId="admin-connectors" wide>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3" data-testid="connectors-compact-toolbar">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">Connectors</h1>
        {empty ? null : (
          // One toolbar: find and add sit together on the title's row (DESIGN P6, S2).
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {showFilter && !connections.error ? <FilterInput value={query} onChange={setQuery} className="min-w-0 flex-1 sm:w-56 sm:flex-none" /> : null}
            <DenButton size="sm" icon={Plus} href={getAddConnectorRoute(orgSlug)} onPointerEnter={prefetchCatalog} onFocus={prefetchCatalog}>Add</DenButton>
          </div>
        )}
      </div>

      {connections.error ? (
        <p className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-[13px] text-red-600">
          {connections.error instanceof Error ? connections.error.message : "Connectors did not load."}
        </p>
      ) : null}

      {empty ? <ConnectorsEmpty orgSlug={orgSlug} /> : null}

      {!empty && !connections.error ? (
        <>
          {connections.isLoading ? <LibraryCompactSurface><LibraryCompactSkeleton label="Loading connectors" /></LibraryCompactSurface> : null}
          {visible.length > 0 ? <LibraryCompactSurface testId="connectors-list">
            {needsAttention.length > 0 ? (
              <LibraryCompactSection title="Needs attention" count={needsAttention.length} tone="attention" testId="connectors-section-attention">
                {needsAttention.map(compactRow)}
              </LibraryCompactSection>
            ) : null}
            {working.length > 0 && needsAttention.length > 0 ? (
              <LibraryCompactSection title="Connected" count={working.length} testId="connectors-section-connected">
                {working.map(compactRow)}
              </LibraryCompactSection>
            ) : null}
            {/* With nothing to fix there is one group, so it needs no heading or count. */}
            {working.length > 0 && needsAttention.length === 0 ? (
              <div className="flex flex-col" data-testid="connectors-section-connected">{working.map(compactRow)}</div>
            ) : null}
          </LibraryCompactSurface> : null}
          {!connections.isLoading && visible.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-gray-500">Nothing matches.</p>
          ) : null}
        </>
      ) : null}
    </ItemPage>
  );
}
