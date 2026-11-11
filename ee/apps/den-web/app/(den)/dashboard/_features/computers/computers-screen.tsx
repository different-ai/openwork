"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, LockKeyhole, RefreshCw, Search } from "lucide-react";
import { REMOTE_DEVICE_AVAILABILITIES, REMOTE_DEVICE_AVAILABILITY_LABELS, REMOTE_DEVICE_KINDS, REMOTE_DEVICE_PROVIDERS, remoteDeviceTypeLabel, type RemoteDeviceKind } from "@openwork/types/den/remote-devices";
import { DenButton, buttonVariants } from "../../../_components/ui/button";
import { DenInput } from "../../../_components/ui/input";
import { DenSelect } from "../../../_components/ui/select";
import { DenSegmented } from "../../../_components/ui/segmented";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../_components/ui/table";
import { getOrgAccessFlags, orgFeatureEnabled, permissionLockReason, type DenOrgContext } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { FeatureIntroGate } from "../feature-intros/feature-intro-gate";
import { ComputerDetail } from "./computer-detail";
import { RegisteredInstances } from "./registered-instances";
import { OrgSessionAccessSetting } from "../sessions/session-access-setting";
import { StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./computer-parts";
import { useComputers } from "./computers-data";
import { AVAILABILITY_TONE, KIND_LABELS, PROVIDER_LABELS, clearComputerFilters, countLabel, devicePageCount, hasComputerFilters, ownerLabel, parseDeviceAvailability, parseDeviceProvider, readComputerFilters, writeComputerFilters, type ComputerFilters, type OrganizationComputer } from "./computers-format";

const KIND_OPTIONS: Array<{ value: RemoteDeviceKind | "all"; label: string }> = [
  { value: "all", label: "All computers" },
  ...REMOTE_DEVICE_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
];
const SKELETON_ROWS = ["1", "2", "3", "4", "5"].map((id) => ({ id }));

/** Team inventory stays in Den's organization scope; Desktop and Workbot keep their personal inventory. */
export function ComputersScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  if (!orgId || !orgContext) return <ComputersSkeleton />;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  if (!access.canViewComputers || !orgFeatureEnabled(orgContext, "remoteDevices")) return <section className="space-y-4" data-testid="computers-locked">
    <h1 className="text-base font-medium">Computers</h1>
    <p className={`flex items-start gap-2 text-sm ${secondaryText}`}><LockKeyhole size={16} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />
      {!access.canViewComputers ? permissionLockReason("computers.view") : "Computers is not enabled for this organization. Ask an organization owner or admin about availability."}
    </p>
  </section>;
  return <ComputersList key={orgId} orgId={orgId} orgContext={orgContext} />;
}

function ComputersSkeleton() {
  return <div aria-busy="true" aria-label="Computers"><DenSkeleton className="mb-6 h-5 w-28" />{SKELETON_ROWS.map(({ id }) => <DenSkeleton key={id} className="mb-3 h-10 w-full" />)}</div>;
}

function ComputersList({ orgId, orgContext }: { orgId: string; orgContext: Pick<DenOrgContext, "features"> }) {
  const queryClient = useQueryClient();
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

  const query = useComputers(orgId, filters, true);
  const data = query.data;
  const devices = data?.devices ?? [];
  const filtered = hasComputerFilters(filters);
  const clear = () => { writtenSearch.current = ""; setSearch(""); apply(clearComputerFilters()); };
  const toggle = (device: string) => apply({ device: filters.device === device ? "" : device });
  const pages = data ? devicePageCount(data.total, data.pageSize) : 1;
  const now = Date.now();
  const columns: DenTableColumn<OrganizationComputer>[] = [
    { key: "computer", header: "Computer", render: (device) => <button type="button" aria-expanded={device.id === filters.device} aria-controls={`computer-detail-${device.id}`} onClick={() => toggle(device.id)}
      data-testid={`computer-row-${device.id}`} className={`flex min-w-48 max-w-xs items-start gap-2 rounded-sm text-left ${focusRing}`}>
      <ChevronRight size={16} strokeWidth={1.5} aria-hidden className={`mt-0.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${device.id === filters.device ? "rotate-90" : ""}`} />
      <span className="min-w-0"><span className="block break-words font-medium">{device.label}</span><span className={`mt-0.5 block text-xs ${secondaryText}`}>{remoteDeviceTypeLabel(device)}{device.removedAt ? " (removed)" : ""}</span></span>
    </button> },
    { key: "owner", header: "Owner", render: (device) => <span title={device.owner?.email ?? undefined}>{ownerLabel(device)}</span> },
    { key: "availability", header: "Availability", render: (device) => <div className="min-w-32 max-w-xs"><span className="inline-flex items-center gap-2"><StatusDot tone={AVAILABILITY_TONE[device.availability]} />{REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>{device.statusDetail ? <p className={`mt-0.5 text-xs ${secondaryText}`}>{device.statusDetail}</p> : null}</div> },
    { key: "lastSeen", header: "Last contact", render: (device) => <TimeAgo iso={device.lastSeenAt} now={now} className="whitespace-nowrap tabular-nums" /> },
    { key: "version", header: "App version", render: (device) => device.appVersion ?? "Not reported" },
  ];
  const skeletonColumns: DenTableColumn<{ id: string }>[] = columns.map(({ key, header }) => ({ key, header, render: () => <DenSkeleton className="h-4 w-24" /> }));
  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="computers" aria-busy={query.isFetching}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h1 className="text-base font-medium">Computers</h1>
      <DenButton size="sm" variant="secondary" icon={RefreshCw} loading={query.isFetching} onClick={() => void refresh()}>Refresh</DenButton>
    </div>
    <details className={`mb-5 border-b ${hairline} pb-3 text-sm`}>
      <summary className={`w-fit cursor-pointer rounded-sm ${focusRing}`}>Register a computer</summary>
      <div className={`mt-3 max-w-xl space-y-3 ${secondaryText}`}>
        <p>Sign in to OpenWork Desktop with this organization, add an existing virtual computer in Desktop Settings → Devices, or let Workbot use its cloud computer. Reported computers appear here.</p>
        <p>Registration does not create a virtual machine or grant remote access. The owner sets up access in Desktop or Workbot.</p>
        <a href="openwork://open" className={buttonVariants({ variant: "secondary", size: "sm", className: focusRing })}>Open OpenWork Desktop</a>
      </div>
    </details>
    {query.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm"><p>{query.error.message}{data ? " Showing the last known list." : ""}</p><DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton></div> : null}
    <FeatureIntroGate introKey="computers" facts={data && !filtered ? { computers: data.total + data.instancesTotal } : null}>
      <div className="mb-5 w-full max-w-sm"><DenInput icon={Search} type="search" aria-label="Search computers and instances" placeholder="Name or computer owner" maxLength={160} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <h2 className="mb-3 text-sm font-medium">Desktop and virtual computers</h2>
      <div className="flex flex-wrap items-center gap-2" aria-label="Computer filters">
        <DenSegmented aria-label="Kind of computer" options={KIND_OPTIONS} value={filters.kind} onChange={(kind) => narrow({ kind })} />
        <div className="w-44"><DenSelect aria-label="Provider" value={filters.provider} onChange={(event) => narrow({ provider: parseDeviceProvider(event.target.value) })}><option value="all">All providers</option>{REMOTE_DEVICE_PROVIDERS.map((provider) => <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>)}</DenSelect></div>
        <div className="w-44"><DenSelect aria-label="Availability" value={filters.availability} onChange={(event) => narrow({ availability: parseDeviceAvailability(event.target.value) })}><option value="all">All availability</option>{REMOTE_DEVICE_AVAILABILITIES.map((availability) => <option key={availability} value={availability}>{REMOTE_DEVICE_AVAILABILITY_LABELS[availability]}</option>)}</DenSelect></div>
        {filtered ? <DenButton size="sm" variant="ghost" onClick={clear}>Clear filters</DenButton> : null}
      </div>
      {data ? <p className={`mt-4 text-xs tabular-nums ${secondaryText}`}>{countLabel(data.total, filtered ? "matching computer" : "computer")}</p> : null}
      {data && filters.device && !devices.some((device) => device.id === filters.device) ? <div className={`mt-4 border-t ${hairline} pt-4`}><ComputerDetail orgId={orgId} deviceId={filters.device} onClose={() => toggle(filters.device)} /></div> : null}
      <div className="mt-3 min-w-0">
        {!data ? query.isPending ? <DenTable columns={skeletonColumns} rows={SKELETON_ROWS} getRowKey={(row) => row.id} density="compact" /> : null
          : devices.length ? <DenTable columns={columns} rows={devices} getRowKey={(device) => device.id} density="compact" renderRowDetail={(device) => device.id === filters.device ? <div id={`computer-detail-${device.id}`} className="pb-2 pl-6 pt-2"><ComputerDetail orgId={orgId} deviceId={device.id} /></div> : null} />
            : <p className={`py-6 text-sm ${secondaryText}`}>{filtered ? "No computers match these filters. Clear filters to see all team computers." : "Computers appear after a signed-in desktop or Workbot reports them. Open registration above to get started."}</p>}
      </div>
      {data && pages > 1 ? <nav aria-label="Computer pages" className={`mt-4 flex items-center justify-end gap-3 text-xs ${secondaryText}`}>
        <span>Page {data.page} of {pages}</span><DenButton size="sm" variant="secondary" disabled={query.isFetching || data.page <= 1} onClick={() => apply({ page: data.page - 1, device: "" })}>Previous</DenButton><DenButton size="sm" variant="secondary" disabled={query.isFetching || data.page >= pages} onClick={() => apply({ page: data.page + 1, device: "" })}>Next</DenButton>
      </nav> : null}
      {data ? <RegisteredInstances instances={data.instances} total={data.instancesTotal} page={data.instancePage} pageSize={data.instancePageSize} busy={query.isFetching} onPage={(instancePage) => apply({ instancePage })} now={now} /> : null}
    </FeatureIntroGate>
    {/* The organization's ceiling for what members may let their other devices reach; renders only with remoteSessionAccess on. */}
    <OrgSessionAccessSetting orgId={orgId} orgContext={orgContext} />
  </section>;
}
