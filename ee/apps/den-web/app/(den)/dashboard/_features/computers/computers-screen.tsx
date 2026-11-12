"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, Plus } from "lucide-react";
import { REMOTE_DEVICE_AVAILABILITIES, REMOTE_DEVICE_AVAILABILITY_LABELS, REMOTE_DEVICE_KINDS, REMOTE_DEVICE_REGISTERABLE_PROVIDERS, remoteDeviceTypeLabel, type RemoteDeviceKind, type RemoteDeviceProvider } from "@openwork/types/den/remote-devices";
import { DenButton } from "../../../_components/ui/button";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSelect } from "../../../_components/ui/select";
import { DenSegmented } from "../../../_components/ui/segmented";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getOrgAccessFlags, orgFeatureEnabled, permissionLockReason } from "../../../_lib/den-org";
import { useDenToast } from "../../_components/den-toast";
import { FilterInput } from "../../_components/item-list";
import { TeamsListLocked } from "../../_components/teams-list-row";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { FeatureIntroGate } from "../feature-intros/feature-intro-gate";
import { AddComputerDialog, ComputerActionButtons, ComputerMenu, type ComputerActionSet } from "./computer-action-controls";
import { disconnectLocked, disconnectOwnerName, disconnectTeamConfirm, disconnectedLine, removeConfirm, teamComputerActions } from "./computer-actions";
import { ComputerDetail } from "./computer-detail";
import { RefreshButton, hairline, secondaryText } from "./computer-parts";
import { LANE, ListRow, OwnerLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton, StatusLane, TimeLane, VersionLane, computerIcon } from "./computer-rows";
import { disconnectOrganizationComputer, removeOrganizationComputer, useComputers } from "./computers-data";
import { KIND_LABELS, PROVIDER_LABELS, clearComputerFilters, computerStatus, computersStateLine, devicePageCount, duplicateNameNotes, hasComputerFilters, parseDeviceAvailability, parseDeviceProvider, readComputerFilters, staleLine, teamOwnerKey, writeComputerFilters, type ComputerFilters, type OrganizationComputer } from "./computers-format";
import { RegisteredInstances } from "./registered-instances";
import { RemoteAccessSetting } from "./remote-access-setting";

const KIND_OPTIONS: Array<{ value: RemoteDeviceKind | "all"; label: string }> = [
  { value: "all", label: "All computers" },
  ...REMOTE_DEVICE_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
];
/** Who can run a virtual computer: Workbot's own, then the ones a member registers. */
const VIRTUAL_PROVIDERS: readonly RemoteDeviceProvider[] = ["workbot", ...REMOTE_DEVICE_REGISTERABLE_PROVIDERS];

/** What a computer is, then what else its lanes do not say. Spaced apart rather than punctuated. */
export function SecondLine({ parts }: { parts: ReadonlyArray<string | null | undefined | false> }) {
  const shown = parts.filter((part): part is string => Boolean(part));
  return <>{shown.map((part, index) => <span key={index} className="mr-2 last:mr-0">{part}</span>)}</>;
}

/** Team inventory stays in Den's organization scope; Desktop and Workbot keep their personal inventory. */
export function ComputersScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  if (!orgId || !orgContext) return <ComputersSkeleton />;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  if (!access.canViewComputers || !orgFeatureEnabled(orgContext, "remoteDevices")) return <section className="space-y-4" data-testid="computers-locked">
    <DenPageHeader size="compact" title="Computers" />
    <p className={`flex items-start gap-2 text-[13px] ${secondaryText}`}><LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />
      {!access.canViewComputers ? permissionLockReason("computers.view") : "Computers is not enabled for this organization. Ask an organization owner or admin about availability."}
    </p>
  </section>;
  return <ComputersList key={orgId} orgId={orgId} canDisconnectComputers={access.canDisconnectComputers} />;
}

function ComputersSkeleton() {
  return <div aria-busy="true" aria-label="Computers"><DenSkeleton className="mb-8 h-6 w-32" /><RowListSkeleton rows={5} /></div>;
}

/** A computers page's title, one line of state under it, and how to add a computer. */
export function ComputersPageHeader({ title, state, refreshing, onRefresh, onAdd }: {
  title: string;
  /** Null while the list is loading. */
  state: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onAdd: () => void;
}) {
  return <DenPageHeader size="compact" title={title} className="mb-6"
    state={state ?? <DenSkeleton className="mt-1 h-3 w-24" />}
    action={<div className="flex items-center gap-1">
      {/* The list is read when the page opens and after each change; this reads it again on request. */}
      <RefreshButton refreshing={refreshing} onRefresh={onRefresh} testId="computers-refresh" />
      {/* On a phone the button keeps its plus and its name for assistive tech; the words come back when there is room. */}
      <DenButton size="sm" variant="secondary" icon={Plus} onClick={onAdd} aria-label="Add a computer" data-testid="computers-add"><span className="hidden sm:inline">Add a computer</span></DenButton>
    </div>} />;
}

/**
 * A team row's one control: the `…` menu when the viewer may act on the
 * computer; a lock with the reason on a connected desktop they could
 * disconnect with the permission; otherwise nothing.
 */
export function TeamComputerControl({ device, set, canDisconnectComputers, actionsReported = true }: {
  device: OrganizationComputer;
  set: ComputerActionSet;
  canDisconnectComputers: boolean;
  /** False while the API is one from before computers could be disconnected: there is no permission to point at yet. */
  actionsReported?: boolean;
}) {
  if (set.actions.length) return <ComputerMenu set={set} idPrefix="computer" id={device.id} />;
  if (actionsReported && disconnectLocked(device, canDisconnectComputers)) return <span data-testid={`computer-locked-${device.id}`}><TeamsListLocked reason={permissionLockReason("computers.disconnect")} /></span>;
  return null;
}

/** The team's computers as rows: who owns each, its status, last contact and version, and what the viewer may do to it. */
export function TeamComputerRows({ devices, now, openId, onToggle, action, detail }: {
  devices: readonly OrganizationComputer[];
  now: number;
  openId: string;
  onToggle: (deviceId: string) => void;
  /** The row's control, in its fixed lane. */
  action: (device: OrganizationComputer) => ReactNode;
  detail: (device: OrganizationComputer) => ReactNode;
}) {
  const notes = duplicateNameNotes(devices, teamOwnerKey, now);
  return <RowList label="Computers" header={<RowListHeader lead="Computer" menu chevron>
    <RowLaneLabel lane={LANE.owner}>Owner</RowLaneLabel>
    <RowLaneLabel lane={LANE.status}>Status</RowLaneLabel>
    <RowLaneLabel lane={LANE.teamTime}>Last contact</RowLaneLabel>
    <RowLaneLabel lane={LANE.teamVersion}>App version</RowLaneLabel>
  </RowListHeader>}>
    {devices.map((device) => {
      const status = computerStatus(device);
      const open = device.id === openId;
      return <ListRow key={device.id} icon={computerIcon(device)} name={device.label} testId={`computer-row-${device.id}`}
        secondLine={<SecondLine parts={[remoteDeviceTypeLabel(device), device.removedAt ? "Removed" : null, notes.get(device.id)]} />}
        toggle={{ expanded: open, controls: `computer-detail-region-${device.id}`, onToggle: () => onToggle(device.id) }}
        lanes={<>
          <OwnerLane device={device} />
          <StatusLane {...status} />
          <TimeLane lane={LANE.teamTime} iso={device.lastSeenAt} now={now} />
          <VersionLane lane={LANE.teamVersion} version={device.appVersion} />
        </>}
        action={action(device) ?? null}>
        {open ? detail(device) : null}
      </ListRow>;
    })}
  </RowList>;
}

/** Under the list: desktops left out because nobody has heard from them for 30 days, and the way to see them. */
export function StaleComputersLine({ hidden, shown, onShow, onHide }: { hidden: number; shown: boolean; onShow: () => void; onHide: () => void }) {
  if (!shown && hidden <= 0) return null;
  return <p className={`mt-3 flex flex-wrap items-center gap-x-2 text-[12px] leading-4 ${secondaryText}`} data-testid="computers-stale">
    {shown ? "Showing computers not heard from in 30 days" : staleLine(hidden)}
    {shown
      ? <DenButton variant="ghost" size="inline" onClick={onHide} data-testid="computers-hide-stale">Hide</DenButton>
      : <DenButton variant="ghost" size="inline" onClick={onShow} data-testid="computers-show-stale">Show</DenButton>}
  </p>;
}

function ComputersList({ orgId, canDisconnectComputers }: { orgId: string; canDisconnectComputers: boolean }) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const toast = useDenToast();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["organization-computers", orgId] });
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryString = params.toString();
  const filters = useMemo(() => readComputerFilters(new URLSearchParams(queryString)), [queryString]);
  const latestFilters = useRef(filters);
  useEffect(() => { latestFilters.current = filters; }, [filters]);
  const apply = useCallback((changes: Partial<ComputerFilters>) => {
    const next = { ...latestFilters.current, ...changes };
    latestFilters.current = next;
    const query = writeComputerFilters(next);
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }, [pathname, router]);
  const narrow = useCallback((changes: Partial<ComputerFilters>) => apply({ ...changes, page: 1, instancePage: 1, device: "" }), [apply]);
  const [search, setSearch] = useState(filters.search);
  const writtenSearch = useRef(filters.search);
  useEffect(() => {
    if (filters.search !== writtenSearch.current) {
      writtenSearch.current = filters.search;
      setSearch(filters.search);
    }
  }, [filters.search]);
  useEffect(() => {
    if (search === writtenSearch.current) return;
    const timeout = window.setTimeout(() => { writtenSearch.current = search; narrow({ search }); }, 300);
    return () => window.clearTimeout(timeout);
  }, [search, narrow]);
  const [adding, setAdding] = useState(false);

  const query = useComputers(orgId, filters, true);
  const data = query.data;
  const devices = data?.devices ?? [];
  const filtered = hasComputerFilters(filters);
  const clear = () => { writtenSearch.current = ""; setSearch(""); apply({ ...clearComputerFilters(), stale: filters.stale }); };
  const toggle = (device: string) => apply({ device: filters.device === device ? "" : device });
  const pages = data ? devicePageCount(data.total, data.pageSize) : 1;
  const now = Date.now();
  // The provider only narrows virtual computers; it stays visible while one is still applied from the address bar.
  const showProvider = filters.kind === "vm" || filters.provider !== "all";

  const actionsFor = (device: OrganizationComputer): ComputerActionSet => ({
    actions: teamComputerActions(device),
    name: device.label,
    disconnectConfirm: disconnectTeamConfirm(device.label, disconnectOwnerName(device), device.organization.name),
    removeConfirm: removeConfirm(device.label),
    onDisconnect: async () => {
      const result: { signedOut: boolean | null } = { signedOut: null };
      // A sensitive permission: a sign-in that is no longer fresh is confirmed first, then this runs again.
      await runReauthableAction("disconnect-computer", async () => {
        result.signedOut = (await disconnectOrganizationComputer(orgId, device.id)).signedOut;
      });
      if (result.signedOut !== null) toast({ title: disconnectedLine(result.signedOut) });
      await refresh();
    },
    onRemove: async () => {
      await runReauthableAction("remove-computer", async () => { await removeOrganizationComputer(orgId, device.id); });
      toast({ title: `Removed ${device.label} from the list` });
      if (latestFilters.current.device === device.id) apply({ device: "" });
      await refresh();
    },
  });
  const detailActions = (device: OrganizationComputer) => <ComputerActionButtons set={actionsFor(device)} idPrefix="computer" id={device.id} />;

  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="computers" aria-busy={query.isFetching}>
    <ComputersPageHeader title="Computers" state={data ? computersStateLine({ online: data.online, total: data.total, filtered }) : null}
      refreshing={query.isFetching} onRefresh={() => void refresh()} onAdd={() => setAdding(true)} />
    <AddComputerDialog open={adding} onClose={() => setAdding(false)} />
    {/* The organization's limit on what other devices may do on members' computers; there whenever Den serves the setting. */}
    <RemoteAccessSetting orgId={orgId} />
    {query.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-[13px]"><p>{query.error.message}{data ? " Showing the last known list." : ""}</p><DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton></div> : null}
    <FeatureIntroGate introKey="computers" facts={data && !filtered ? { computers: data.total + data.staleHidden + data.instancesTotal } : null}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2" role="group" aria-label="Computer filters">
        <FilterInput className="w-64 max-w-full" placeholder="Filter by name or owner" value={search} onChange={(value) => setSearch(value.slice(0, 160))} />
        <div className="flex flex-wrap items-center gap-2">
          {filtered ? <DenButton size="sm" variant="ghost" onClick={clear}>Clear filters</DenButton> : null}
          <DenSegmented aria-label="Kind of computer" options={KIND_OPTIONS} value={filters.kind}
            onChange={(kind) => narrow({ kind, provider: kind === "vm" ? latestFilters.current.provider : "all" })} />
          {showProvider ? <div className="w-36"><DenSelect size="sm" aria-label="Provider" data-testid="computers-provider" value={filters.provider} onChange={(event) => narrow({ provider: parseDeviceProvider(event.target.value) })}>
            <option value="all">Any provider</option>
            {VIRTUAL_PROVIDERS.map((provider) => <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>)}
          </DenSelect></div> : null}
          <div className="w-36"><DenSelect size="sm" aria-label="Status" data-testid="computers-status" value={filters.availability} onChange={(event) => narrow({ availability: parseDeviceAvailability(event.target.value) })}>
            <option value="all">Any status</option>
            {REMOTE_DEVICE_AVAILABILITIES.map((availability) => <option key={availability} value={availability}>{REMOTE_DEVICE_AVAILABILITY_LABELS[availability]}</option>)}
          </DenSelect></div>
        </div>
      </div>
      {data && filters.device && !devices.some((device) => device.id === filters.device) ? <div className={`mb-4 border-y ${hairline} py-4`}>
        <ComputerDetail orgId={orgId} deviceId={filters.device} onClose={() => toggle(filters.device)} actions={detailActions} />
      </div> : null}
      <div className="min-w-0">
        {!data ? query.isPending ? <RowListSkeleton rows={5} /> : null
          : devices.length ? <TeamComputerRows devices={devices} now={now} openId={filters.device} onToggle={toggle}
              action={(device) => <TeamComputerControl device={device} set={actionsFor(device)} canDisconnectComputers={canDisconnectComputers} actionsReported={data.actionsReported} />}
              detail={(device) => <ComputerDetail orgId={orgId} deviceId={device.id} actions={detailActions} />} />
            : <p className={`border-y ${hairline} py-6 text-[13px] ${secondaryText}`}>{filtered ? "No computers match these filters." : "No computers yet. Sign in to OpenWork on a computer with this organization and it appears here."}</p>}
      </div>
      {data ? <StaleComputersLine hidden={data.staleHidden} shown={filters.stale} onShow={() => narrow({ stale: true })} onHide={() => narrow({ stale: false })} /> : null}
      {data && pages > 1 ? <nav aria-label="Computer pages" className={`mt-4 flex items-center justify-end gap-3 text-xs ${secondaryText}`}>
        <span>Page {data.page} of {pages}</span><DenButton size="sm" variant="secondary" disabled={query.isFetching || data.page <= 1} onClick={() => apply({ page: data.page - 1, device: "" })}>Previous</DenButton><DenButton size="sm" variant="secondary" disabled={query.isFetching || data.page >= pages} onClick={() => apply({ page: data.page + 1, device: "" })}>Next</DenButton>
      </nav> : null}
      {data ? <RegisteredInstances instances={data.instances} total={data.instancesTotal} filtered={Boolean(filters.search.trim())} page={data.instancePage} pageSize={data.instancePageSize} busy={query.isFetching} onPage={(instancePage) => apply({ instancePage })} now={now} /> : null}
    </FeatureIntroGate>
  </section>;
}
