"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, Globe, LayoutDashboard, Loader2, Plus, Trash2, Users } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenSwitch } from "../../_components/ui/switch";
import { getManagedDashboardsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMcpConnections } from "./mcp-connections-data";
import { connectionCanListMcpApps, dashboardCapabilityKey, dashboardElementKey } from "./dashboard-mcp-app-catalog";
import { OrgMemberIdentity } from "./org-member-identity";
import {
  type ConnectionMcpAppCatalogItem,
  type DashboardAccessGrant,
  type DashboardElement,
  filterConnectionsWithMcpApps,
  useConnectionMcpAppCatalog,
  useDashboardAccess,
  useDeleteDashboard,
  useGrantDashboardAccess,
  useManagedDashboard,
  useRevokeDashboardAccess,
  useUpdateDashboard,
} from "./org-dashboards-data";

/** Required launch-input keys the author left out (or set to undefined). */
export function missingRequiredInputKeys(
  requiredInputKeys: string[],
  launchArguments: Record<string, unknown>,
): string[] {
  return requiredInputKeys.filter((key) => !Object.hasOwn(launchArguments, key) || launchArguments[key] === undefined);
}

export function OrgDashboardDetailScreen({ dashboardId }: { dashboardId: string }) {
  const { orgSlug } = useOrgDashboard();
  const router = useRouter();
  const dashboardQuery = useManagedDashboard(dashboardId);
  const accessQuery = useDashboardAccess(dashboardId);
  const updateMutation = useUpdateDashboard();
  const deleteMutation = useDeleteDashboard();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const dashboard = dashboardQuery.data ?? null;
  const elements = dashboard?.elements ?? [];
  const existingKeys = useMemo(() => new Set(elements.map(dashboardElementKey)), [elements]);
  const busy = updateMutation.isPending || deleteMutation.isPending;

  function saveElements(next: DashboardElement[]) {
    updateMutation.mutate({ dashboardId, elements: next });
  }

  /** Adds a tile unless an identical one (same app, same launch input) is already on the dashboard. */
  function addElement(element: DashboardElement): boolean {
    if (existingKeys.has(dashboardElementKey(element))) return false;
    saveElements([...elements, element]);
    return true;
  }

  function moveElement(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= elements.length) return;
    const next = [...elements];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    saveElements(next);
  }

  async function saveName() {
    const trimmed = nameDraft?.trim();
    if (!trimmed || !dashboard || trimmed === dashboard.name) {
      setNameDraft(null);
      return;
    }
    try {
      await updateMutation.mutateAsync({ dashboardId, name: trimmed });
      setNameDraft(null);
    } catch {
      // The mutation error is rendered below.
    }
  }

  async function deleteDashboard() {
    if (!window.confirm("Delete this dashboard? Members lose its tiles the next time their desktop refreshes.")) return;
    try {
      await deleteMutation.mutateAsync({ dashboardId });
      router.push(getManagedDashboardsRoute(orgSlug));
    } catch {
      // The mutation error is rendered below.
    }
  }

  if (dashboardQuery.isLoading) {
    return (
      <DashboardPageTemplate icon={LayoutDashboard} title="Dashboards" description="Loading dashboard…" colors={["#E0F2FE", "#0C4A6E", "#0EA5E9", "#BAE6FD"]}>
        <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-[14px] text-gray-500">Loading dashboard…</div>
      </DashboardPageTemplate>
    );
  }

  if (dashboardQuery.error || !dashboard) {
    return (
      <DashboardPageTemplate icon={LayoutDashboard} title="Dashboards" description="This dashboard could not be loaded." colors={["#E0F2FE", "#0C4A6E", "#0EA5E9", "#BAE6FD"]}>
        <DenNotice
          tone="error"
          message={dashboardQuery.error instanceof Error ? dashboardQuery.error.message : "The dashboard was not found."}
        />
        <Link href={getManagedDashboardsRoute(orgSlug)} className="mt-4 inline-flex items-center gap-1 text-[13px] text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to Dashboards
        </Link>
      </DashboardPageTemplate>
    );
  }

  return (
    <DashboardPageTemplate
      icon={LayoutDashboard}
      title={dashboard.name}
      description="Members with access see this dashboard's apps on their desktop Dashboard. Apps use member consent unless an admin explicitly enables automatic launch."
      colors={["#E0F2FE", "#0C4A6E", "#0EA5E9", "#BAE6FD"]}
    >
      <Link href={getManagedDashboardsRoute(orgSlug)} className="mb-5 inline-flex items-center gap-1 text-[13px] text-gray-500 hover:text-gray-900">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All dashboards
      </Link>

      <section className="mb-8">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">Name</h2>
        <div className="flex max-w-md items-center gap-2">
          <DenInput
            value={nameDraft ?? dashboard.name}
            onChange={(event) => setNameDraft(event.target.value)}
            placeholder="Dashboard name"
          />
          {nameDraft !== null && nameDraft.trim() !== dashboard.name ? (
            <DenButton size="sm" disabled={!nameDraft.trim() || busy} onClick={() => void saveName()}>
              Save
            </DenButton>
          ) : null}
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">Apps</h2>
          <DenButton size="sm" icon={Plus} onClick={() => setPickerOpen(true)}>
            Add app
          </DenButton>
        </div>
        {elements.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center">
            <p className="text-[13px] font-medium text-gray-900">No apps yet</p>
            <p className="mt-1 text-[12px] text-gray-500">Add MCP apps from your organization&apos;s connectors.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
            {elements.map((element, index) => (
              <div key={dashboardElementKey(element)} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-gray-900">{element.title}</p>
                  <p className="truncate text-[12px] text-gray-400">
                    {element.toolName}
                    {element.launchArguments ? ` · ${JSON.stringify(element.launchArguments)}` : ""}
                    {element.organizationAutoLaunch
                      ? " · runs automatically by organization policy"
                      : element.requiresApproval ? " · runs on request" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 pr-2">
                  <span className="text-[11.5px] text-gray-500">Auto-run</span>
                  <DenSwitch
                    size="sm"
                    checked={element.organizationAutoLaunch === true}
                    disabled={busy}
                    onChange={(checked) => saveElements(elements.map((current, currentIndex) => (
                      currentIndex === index
                        ? { ...current, organizationAutoLaunch: checked || undefined }
                        : current
                    )))}
                    aria-label={`Run ${element.title} automatically, even if it modifies data`}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Move ${element.title} up`}
                    disabled={busy || index === 0}
                    onClick={() => moveElement(index, -1)}
                    className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${element.title} down`}
                    disabled={busy || index === elements.length - 1}
                    onClick={() => moveElement(index, 1)}
                    className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${element.title}`}
                    disabled={busy}
                    onClick={() => saveElements(elements.filter((_, current) => current !== index))}
                    className="rounded-lg p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <DashboardAccessSection
        dashboardId={dashboardId}
        grants={accessQuery.data ?? []}
        isLoading={accessQuery.isLoading}
        error={accessQuery.error}
      />

      {updateMutation.error || deleteMutation.error ? (
        <DenNotice
          tone="error"
          className="mt-4"
          message={(() => {
            const error = updateMutation.error ?? deleteMutation.error;
            return error instanceof Error ? error.message : "Failed to update the dashboard.";
          })()}
        />
      ) : null}

      <section className="mt-10 border-t border-gray-100 pt-6">
        <DenButton variant="destructive" disabled={busy} onClick={() => void deleteDashboard()}>
          Delete dashboard
        </DenButton>
      </section>

      {pickerOpen ? (
        <AddDashboardAppDialog
          elements={elements}
          onClose={() => setPickerOpen(false)}
          onAdd={addElement}
        />
      ) : null}
    </DashboardPageTemplate>
  );
}

function AddDashboardAppDialog({
  elements,
  onClose,
  onAdd,
}: {
  elements: DashboardElement[];
  onClose: () => void;
  onAdd: (element: DashboardElement) => boolean;
}) {
  const connectionsQuery = useMcpConnections("manageable");
  const connections = useMemo(
    () => (connectionsQuery.data ?? []).filter((connection) => (
      connection.nativeProviderKey == null && connectionCanListMcpApps(connection)
    )),
    [connectionsQuery.data],
  );
  const appsQuery = useConnectionMcpAppCatalog(connections);
  const appConnections = useMemo(
    () => filterConnectionsWithMcpApps(connections, appsQuery.data),
    [appsQuery.data, connections],
  );
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const selectedConnectionId = appConnections.some((connection) => connection.id === connectionId)
    ? connectionId
    : appConnections[0]?.id ?? null;
  const visibleApps = appsQuery.data.filter((app) => app.connectionId === selectedConnectionId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-dashboard-app-title"
        className="flex max-h-[80vh] w-full max-w-[520px] flex-col rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.4)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="add-dashboard-app-title" className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">
          Add app
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-500">
          Select an MCP, then choose one of its Apps. MCPs without Apps are hidden.
        </p>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">MCP</span>
          <DenSelect
            aria-label="MCP"
            value={selectedConnectionId ?? ""}
            onChange={(event) => setConnectionId(event.target.value || null)}
            disabled={appConnections.length === 0}
          >
            {appConnections.length === 0 ? <option value="">No MCPs with Apps available</option> : null}
            {appConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </DenSelect>
        </label>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {connectionsQuery.isLoading || appsQuery.isLoading ? (
            <p className="py-6 text-center text-[13px] text-gray-400">Loading apps…</p>
          ) : appsQuery.error ? (
            <DenNotice
              tone="error"
              message={appsQuery.error instanceof Error ? appsQuery.error.message : "Failed to load this connector's apps."}
            />
          ) : visibleApps.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-gray-400">
              No MCP Apps are available from your organization&apos;s connections.
            </p>
          ) : (
            <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
              {visibleApps.map((app) => (
                <ConnectionAppRow
                  key={dashboardCapabilityKey(app)}
                  app={app}
                  addedCount={elements.filter((element) => dashboardCapabilityKey(element) === dashboardCapabilityKey(app)).length}
                  onAdd={onAdd}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <DenButton variant="secondary" onClick={onClose}>Done</DenButton>
        </div>
      </div>
    </div>
  );
}

function ConnectionAppRow({
  app,
  addedCount,
  onAdd,
}: {
  app: ConnectionMcpAppCatalogItem;
  /** Tiles already using this app; the app stays addable with different launch input. */
  addedCount: number;
  onAdd: (element: DashboardElement) => boolean;
}) {
  const [argumentsText, setArgumentsText] = useState("");
  const [argumentsError, setArgumentsError] = useState<string | null>(null);
  const [organizationAutoLaunch, setOrganizationAutoLaunch] = useState(false);

  function add() {
    let launchArguments: Record<string, unknown> | undefined;
    if (app.requiresInput || argumentsText.trim()) {
      try {
        const parsed: unknown = JSON.parse(argumentsText || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setArgumentsError("Launch input must be a JSON object.");
          return;
        }
        launchArguments = parsed as Record<string, unknown>;
      } catch {
        setArgumentsError("Launch input must be valid JSON.");
        return;
      }
      // A tile whose input omits a key the tool requires fails on every
      // launch, so refuse it here and name the missing keys.
      const missingKeys = missingRequiredInputKeys(app.requiredInputKeys, launchArguments);
      if (missingKeys.length > 0) {
        setArgumentsError(`Launch input is missing required ${missingKeys.length === 1 ? "key" : "keys"}: ${missingKeys.join(", ")}.`);
        return;
      }
    }
    const added = onAdd({
      serverName: app.serverName,
      connectionId: app.connectionId,
      toolName: app.toolName,
      projectedToolName: app.projectedToolName,
      resourceUri: app.resourceUri,
      title: app.title,
      ...(launchArguments && Object.keys(launchArguments).length > 0 ? { launchArguments } : {}),
      ...(app.requiresApproval ? { requiresApproval: true } : {}),
      ...(organizationAutoLaunch ? { organizationAutoLaunch: true } : {}),
    });
    setArgumentsError(added ? null : "This app is already on the dashboard with the same launch input.");
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium text-gray-900">{app.title}</p>
          <p className="truncate text-[12px] text-gray-400">
            {app.description ?? app.toolName}
            {` · ${app.connectionName}`}
            {app.requiresApproval ? " · modifies data, runs on request" : ""}
          </p>
        </div>
        {addedCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-emerald-600">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {addedCount === 1 ? "Added" : `Added ×${addedCount}`}
          </span>
        ) : null}
        <DenButton size="sm" variant="secondary" onClick={add}>
          {addedCount > 0 ? "Add another" : "Add"}
        </DenButton>
      </div>
      {app.requiresInput ? (
        <p className="mt-2 text-[11.5px] leading-4 text-gray-500">
          Each launch input adds its own tile, so the same app can appear more than once with different input.
        </p>
      ) : null}
      <div className="mt-3 flex items-start justify-between gap-4 rounded-xl bg-amber-50 px-3 py-2.5">
        <div>
          <p className="text-[12px] font-medium text-amber-950">Run automatically</p>
          <p className="mt-0.5 text-[11.5px] leading-4 text-amber-800">
            Run on dashboard load and refresh, even if this app modifies data.
          </p>
        </div>
        <DenSwitch
          size="sm"
          checked={organizationAutoLaunch}
          onChange={setOrganizationAutoLaunch}
          aria-label={`Run ${app.title} automatically, even if it modifies data`}
        />
      </div>
      {app.requiresInput ? (
        <label className="mt-2 block">
          <span className="mb-1 block text-[11.5px] font-medium text-gray-600">Launch input (JSON, required by this app)</span>
          {app.requiredInputKeys.length > 0 ? (
            <span className="mb-1 block text-[11.5px] text-gray-500" data-testid="required-input-keys">
              Required {app.requiredInputKeys.length === 1 ? "key" : "keys"}: {app.requiredInputKeys.map((key) => (
                <code key={key} className="mr-1 rounded-sm bg-gray-100 px-1 font-mono text-[11px] text-gray-800">{key}</code>
              ))}
            </span>
          ) : null}
          <textarea
            value={argumentsText}
            onChange={(event) => setArgumentsText(event.target.value)}
            placeholder={app.requiredInputKeys.length > 0
              ? `{ ${app.requiredInputKeys.map((key) => `"${key}": "…"`).join(", ")} }`
              : '{ "example": "value" }'}
            rows={2}
            className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2 font-mono text-[12px] text-gray-900 outline-hidden transition placeholder:text-gray-300 focus:border-gray-400"
          />
        </label>
      ) : null}
      {argumentsError ? <p className="mt-1 text-[11.5px] text-red-600">{argumentsError}</p> : null}
    </div>
  );
}

type AccessCandidate = {
  id: string;
  searchText: string;
  content: ReactNode;
};

function formatAccessDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function TeamIdentity({ name, memberCount }: { name: string; memberCount: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gray-100 text-gray-500">
        <Users className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{name}</p>
        <p className="truncate text-[12px] text-gray-400">
          {memberCount} {memberCount === 1 ? "member" : "members"}, future members included
        </p>
      </div>
    </div>
  );
}

function AccessAddPicker({
  kind,
  candidates,
  disabled,
  onGrant,
}: {
  kind: "person" | "team";
  candidates: AccessCandidate[];
  disabled: boolean;
  onGrant: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !event.composedPath().includes(ref.current)) {
        setOpen(false);
        setQuery("");
        setSelectedId(null);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return candidates;
    return candidates.filter((candidate) => candidate.searchText.includes(normalized));
  }, [candidates, query]);

  function resetAndClose() {
    setOpen(false);
    setQuery("");
    setSelectedId(null);
  }

  async function handleGrant() {
    if (!selectedId) return;
    setSubmitting(true);
    try {
      await onGrant(selectedId);
      resetAndClose();
    } catch {
      // The mutation error is rendered below the access container.
    } finally {
      setSubmitting(false);
    }
  }

  const label = kind === "person" ? "person" : "team";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || candidates.length === 0}
        onClick={() => {
          if (open) {
            resetAndClose();
          } else {
            setOpen(true);
          }
        }}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-[11.5px] text-gray-500 transition hover:border-gray-500 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add {label}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 md:absolute md:inset-auto md:left-0 md:top-[calc(100%+6px)] md:z-20 md:block md:bg-transparent md:p-0"
          onClick={(event) => {
            if (event.target === event.currentTarget) resetAndClose();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${label} access`}
            className="w-full max-w-[340px] rounded-2xl border border-gray-200 bg-white md:w-[340px]"
          >
            <div className="border-b border-gray-100 p-3">
              <DenInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${kind === "person" ? "people" : "teams"}...`}
                autoFocus
              />
            </div>
            <div className="max-h-[220px] divide-y divide-gray-100 overflow-y-auto">
              {filteredCandidates.length === 0 ? (
                <p className="px-4 py-5 text-center text-[12px] text-gray-400">No matches</p>
              ) : (
                filteredCandidates.map((candidate) => {
                  const selected = candidate.id === selectedId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setSelectedId(candidate.id)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${selected ? "bg-gray-50" : "hover:bg-gray-50/70"}`}
                    >
                      <div className="min-w-0 flex-1">{candidate.content}</div>
                      <Check className={`h-4 w-4 shrink-0 ${selected ? "text-emerald-600" : "text-transparent"}`} aria-hidden />
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex justify-end border-t border-gray-100 p-3">
              <DenButton size="sm" disabled={!selectedId || submitting} onClick={() => void handleGrant()}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Grant
              </DenButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DashboardAccessSection({
  dashboardId,
  grants,
  isLoading,
  error,
}: {
  dashboardId: string;
  grants: DashboardAccessGrant[];
  isLoading: boolean;
  error: unknown;
}) {
  const { orgContext } = useOrgDashboard();
  const grantMutation = useGrantDashboardAccess();
  const revokeMutation = useRevokeDashboardAccess();
  const members = orgContext?.members ?? [];
  const teams = orgContext?.teams ?? [];
  const membersById = new Map(members.map((member) => [member.id, member]));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const orgWideGrant = grants.find((grant) => grant.orgWide) ?? null;
  const memberGrants = grants.filter((grant) => grant.orgMembershipId !== null);
  const teamGrants = grants.filter((grant) => grant.teamId !== null);
  const busy = grantMutation.isPending || revokeMutation.isPending;

  const memberCandidates: AccessCandidate[] = members
    .filter((member) => !memberGrants.some((grant) => grant.orgMembershipId === member.id))
    .map((member) => ({
      id: member.id,
      searchText: `${member.user.name} ${member.user.email}`.toLowerCase(),
      content: <OrgMemberIdentity member={member} />,
    }));
  const teamCandidates: AccessCandidate[] = teams
    .filter((team) => !teamGrants.some((grant) => grant.teamId === team.id))
    .map((team) => ({
      id: team.id,
      searchText: team.name.toLowerCase(),
      content: <TeamIdentity name={team.name} memberCount={team.memberIds.length} />,
    }));

  async function handleToggleOrgWide() {
    try {
      if (orgWideGrant) {
        await revokeMutation.mutateAsync({ dashboardId, grantId: orgWideGrant.id });
      } else {
        await grantMutation.mutateAsync({ dashboardId, body: { orgWide: true, role: "viewer" } });
      }
    } catch {
      // The mutation error is rendered below the access container.
    }
  }

  async function handleRevoke(grantId: string) {
    try {
      await revokeMutation.mutateAsync({ dashboardId, grantId });
    } catch {
      // The mutation error is rendered below the access container.
    }
  }

  const mutationError = grantMutation.error ?? revokeMutation.error;

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400">
        Who sees this dashboard
      </h2>

      {error ? (
        <DenNotice
          tone="error"
          message={error instanceof Error ? error.message : "Failed to load dashboard access."}
        />
      ) : (
        <div className="rounded-2xl border border-gray-100 bg-white">
          {isLoading ? (
            <p className="px-6 py-4 text-[13px] text-gray-400">Loading access…</p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void handleToggleOrgWide()}
                disabled={busy}
                className="flex w-full items-center gap-4 rounded-t-2xl px-6 py-4 text-left transition hover:bg-gray-50/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${orgWideGrant ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
                  <Globe className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                    Everyone in the organization
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                    {orgWideGrant
                      ? "All organization members see this dashboard on their desktop."
                      : "Only people and teams you add below see this dashboard on their desktop."}
                  </p>
                </div>
                <div
                  role="switch"
                  aria-checked={Boolean(orgWideGrant)}
                  className={`relative inline-flex h-6 w-[42px] shrink-0 items-center rounded-full transition-colors ${orgWideGrant ? "bg-[#0f172a]" : "bg-gray-200"}`}
                >
                  <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${orgWideGrant ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                </div>
              </button>

              <div className="divide-y divide-gray-100 border-t border-gray-100">
                {memberGrants.map((grant) => {
                  const member = grant.orgMembershipId ? membersById.get(grant.orgMembershipId) : null;
                  const sharedBy = grant.createdByOrgMembershipId === orgContext?.currentMember.id
                    ? "you"
                    : membersById.get(grant.createdByOrgMembershipId)?.user.name ?? "an organization member";
                  return (
                    <div key={grant.id} className="flex flex-col gap-3 px-4 py-4 md:flex-row md:flex-wrap md:items-center md:px-6 md:py-3.5">
                      <div className="w-full min-w-0 md:w-auto md:min-w-[220px] md:flex-1">
                        {member ? (
                          <OrgMemberIdentity member={member} />
                        ) : (
                          <p className="text-[13px] font-medium text-gray-500">Removed member</p>
                        )}
                      </div>
                      <p className="text-[11.5px] text-gray-400">
                        assigned by {sharedBy} · {formatAccessDate(grant.createdAt)}
                      </p>
                      <div className="flex w-full justify-end md:w-auto">
                        <DenButton size="sm" variant="destructive" disabled={busy} onClick={() => void handleRevoke(grant.id)}>
                          Revoke
                        </DenButton>
                      </div>
                    </div>
                  );
                })}

                {teamGrants.map((grant) => {
                  const team = grant.teamId ? teamsById.get(grant.teamId) : null;
                  const sharedBy = grant.createdByOrgMembershipId === orgContext?.currentMember.id
                    ? "you"
                    : membersById.get(grant.createdByOrgMembershipId)?.user.name ?? "an organization member";
                  return (
                    <div key={grant.id} className="flex flex-col gap-3 px-4 py-4 md:flex-row md:flex-wrap md:items-center md:px-6 md:py-3.5">
                      <div className="w-full min-w-0 md:w-auto md:min-w-[220px] md:flex-1">
                        {team ? (
                          <TeamIdentity name={team.name} memberCount={team.memberIds.length} />
                        ) : (
                          <p className="text-[13px] font-medium text-gray-500">Removed team</p>
                        )}
                      </div>
                      <p className="text-[11.5px] text-gray-400">
                        assigned by {sharedBy} · {formatAccessDate(grant.createdAt)}
                      </p>
                      <div className="flex w-full justify-end md:w-auto">
                        <DenButton size="sm" variant="destructive" disabled={busy} onClick={() => void handleRevoke(grant.id)}>
                          Revoke
                        </DenButton>
                      </div>
                    </div>
                  );
                })}

                {grants.length === 0 ? (
                  <div className="px-6 py-3.5">
                    <div className="rounded-xl border border-dashed border-gray-200 px-5 py-5 text-center">
                      <p className="text-[13px] font-medium text-gray-900">Nobody sees this dashboard yet</p>
                      <p className="mt-1 text-[12px] text-gray-500">
                        Assign it to a person or a team to put its apps on their desktop Dashboard.
                      </p>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 px-6 py-3.5">
                  <AccessAddPicker
                    kind="person"
                    candidates={memberCandidates}
                    disabled={busy}
                    onGrant={(memberId) => grantMutation.mutateAsync({ dashboardId, body: { orgMembershipId: memberId, role: "viewer" } }).then(() => undefined)}
                  />
                  <AccessAddPicker
                    kind="team"
                    candidates={teamCandidates}
                    disabled={busy}
                    onGrant={(grantTeamId) => grantMutation.mutateAsync({ dashboardId, body: { teamId: grantTeamId, role: "viewer" } }).then(() => undefined)}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {mutationError ? (
        <DenNotice
          tone="error"
          className="mt-3"
          message={mutationError instanceof Error ? mutationError.message : "Failed to update dashboard access."}
        />
      ) : null}
    </section>
  );
}
