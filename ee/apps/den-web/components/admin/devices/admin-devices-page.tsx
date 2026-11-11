"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Search, X } from "lucide-react";
import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_AVAILABILITY_LABELS,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_PROVIDERS,
  adminRemoteDeviceListResponseSchema,
  remoteDeviceTypeLabel,
  type AdminRemoteDevice,
  type AdminRemoteDeviceListResponse,
  type RemoteDeviceKind,
} from "@openwork/types/den/remote-devices";
import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenChip } from "../../../app/(den)/_components/ui/chip";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { DenSkeleton } from "../../../app/(den)/_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "../admin-access-screen";
import { requestAdmin } from "../admin-request";
import { AdminDeviceDetail, type DeviceAccessFailure } from "./admin-device-detail";
import { StatusDot, TimeAgo, focusRing, hairline, secondaryText } from "./device-parts";
import {
  AVAILABILITY_TONE,
  DEVICE_QUERY_KEYS,
  KIND_LABELS,
  ORGANIZATION_DEVICE_QUERY_KEYS,
  PROVIDER_LABELS,
  clearDeviceFilters,
  countLabel,
  deviceListPath,
  devicePageCount,
  hasDeviceFilters,
  ownerLabel,
  parseDeviceAvailability,
  parseDeviceProvider,
  readDeviceFilters,
  writeDeviceFilters,
  type DeviceFilters,
} from "./devices-format";

type DeviceList = AdminRemoteDeviceListResponse;
const parseList = (payload: unknown): DeviceList | null => {
  const result = adminRemoteDeviceListResponseSchema.safeParse(payload);
  return result.success ? result.data : null;
};

const SEARCH_DEBOUNCE_MS = 300;
const KIND_OPTIONS: Array<{ value: RemoteDeviceKind | "all"; label: string }> = [
  { value: "all", label: "All" },
  ...REMOTE_DEVICE_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
];
const SKELETON_ROWS = ["1", "2", "3", "4", "5", "6"].map((id) => ({ id }));
const detailId = (deviceId: string) => `admin-device-detail-${deviceId}`;

/** /admin › Devices: every computer members can reach through OpenWork, across organizations. */
export function AdminDevicesPage() {
  const [access, setAccess] = useState<DeviceAccessFailure | null>(null);
  if (access) return <AdminAccessScreen state={access.access} message={access.message} onRetry={() => setAccess(null)} />;
  return <AdminDevicesList onAccessFailure={setAccess} />;
}

/**
 * The computers list with its filters in the address bar. With `organizationId` it is one organization's
 * tab: the organization column and filter go, and the page around it owns the title and Refresh.
 */
export function AdminDevicesList({ organizationId, refreshKey = 0, onAccessFailure }: {
  organizationId?: string;
  refreshKey?: number;
  onAccessFailure: (failure: DeviceAccessFailure) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const embedded = organizationId !== undefined;
  const keys = embedded ? ORGANIZATION_DEVICE_QUERY_KEYS : DEVICE_QUERY_KEYS;
  const query = params.toString();
  const filters = useMemo(() => readDeviceFilters(new URLSearchParams(query), keys, organizationId), [query, keys, organizationId]);
  const listPath = deviceListPath(filters);

  // A change builds on the last one written, even before that one reaches the address bar.
  const latestQuery = useRef(query);
  useEffect(() => { latestQuery.current = query; }, [query]);
  const apply = useCallback((changes: Partial<DeviceFilters>) => {
    const current = readDeviceFilters(new URLSearchParams(latestQuery.current), keys, organizationId);
    const written = writeDeviceFilters(latestQuery.current, { ...current, ...changes }, keys, embedded);
    latestQuery.current = written;
    router.replace(`${pathname}${written ? `?${written}` : ""}`, { scroll: false });
  }, [embedded, keys, organizationId, pathname, router]);
  /** A new filter starts at page 1 and closes the open computer, which may not be in the new list. */
  const narrow = useCallback((changes: Partial<DeviceFilters>) => apply({ page: 1, device: "", ...changes }), [apply]);

  // The search box keeps what is typed and writes it to the address bar after a pause.
  const [draftSearch, setDraftSearch] = useState(filters.search);
  const writtenSearch = useRef(filters.search);
  useEffect(() => {
    if (filters.search === writtenSearch.current) return;
    writtenSearch.current = filters.search;
    setDraftSearch(filters.search);
  }, [filters.search]);
  useEffect(() => {
    if (draftSearch === writtenSearch.current) return;
    const timeout = window.setTimeout(() => {
      writtenSearch.current = draftSearch;
      narrow({ search: draftSearch });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [draftSearch, narrow]);

  const [data, setData] = useState<DeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const reloadKey = attempt + refreshKey;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void requestAdmin(listPath, parseList, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") { setData(result.data); setError(null); }
      else if (result.access === "signed-out" || result.access === "forbidden") onAccessFailure({ access: result.access, message: result.message });
      else setError(result.message);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load computers.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [listPath, reloadKey, onAccessFailure]);

  const devices = data?.devices ?? [];
  const openInList = devices.some((device) => device.id === filters.device);
  // A link to one computer lands on its row.
  const linkedDevice = useRef(filters.device);
  useEffect(() => {
    if (!data || !linkedDevice.current) return;
    document.getElementById(detailId(linkedDevice.current))?.scrollIntoView({ block: "nearest" });
    linkedDevice.current = "";
  }, [data]);

  const filtered = hasDeviceFilters(filters, embedded);
  const clear = () => {
    writtenSearch.current = "";
    setDraftSearch("");
    apply({ ...clearDeviceFilters(filters, embedded), device: "" });
  };
  const toggle = (deviceId: string) => apply({ device: filters.device === deviceId ? "" : deviceId });
  const now = Date.now();
  const pages = data ? devicePageCount(data.total, data.pageSize) : 1;
  const organizationName = devices.find((device) => device.organization.id === filters.organizationId)?.organization.name;

  const columns: DenTableColumn<AdminRemoteDevice>[] = [
    {
      key: "computer", header: "Computer", render: (device) => {
        const open = device.id === filters.device;
        return <button type="button" aria-expanded={open} aria-controls={detailId(device.id)} onClick={() => toggle(device.id)}
          data-testid={`admin-device-row-${device.id}`} className={`flex min-w-[12rem] max-w-xs items-start gap-2 rounded-sm text-left ${focusRing}`}>
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className={`mt-0.5 shrink-0 ${secondaryText} transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0">
            <span className="block break-words font-medium text-[color:var(--dls-text-primary)]">{device.label}</span>
            <span className={`mt-0.5 flex flex-wrap items-center gap-2 text-xs ${secondaryText}`}>{remoteDeviceTypeLabel(device)}{device.removedAt ? <DenChip>Removed</DenChip> : null}</span>
          </span>
        </button>;
      },
    },
    ...(embedded ? [] : [{
      key: "organization", header: "Organization", render: (device: AdminRemoteDevice) =>
        <Link href={`/admin/organizations/${encodeURIComponent(device.organization.id)}`} prefetch={false} className="break-words underline-offset-2 hover:underline">{device.organization.name}</Link>,
    }]),
    { key: "owner", header: "Owner", render: (device) => <span className="break-words" title={device.owner?.name?.trim() && device.owner.email ? device.owner.email : undefined}>{ownerLabel(device)}</span> },
    {
      key: "availability", header: "Availability", render: (device) => <div className="min-w-[8rem] max-w-xs">
        <span className="inline-flex items-center gap-2"><StatusDot tone={AVAILABILITY_TONE[device.availability]} />{REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>
        {device.statusDetail ? <p className={`mt-0.5 text-xs ${secondaryText}`}>{device.statusDetail}</p> : null}
      </div>,
    },
    { key: "lastSeen", header: "Last heard from", width: "136px", render: (device) => <TimeAgo iso={device.lastSeenAt} now={now} className="whitespace-nowrap tabular-nums" /> },
    { key: "appVersion", header: "App version", width: "112px", render: (device) => device.appVersion ? <span className="tabular-nums">{device.appVersion}</span> : null },
    {
      key: "problems", header: "Last 24 hours", width: "120px", align: "right", render: (device) => device.recentProblems > 0
        ? <DenBadge size="sm" tone="danger">{countLabel(device.recentProblems, "problem")}</DenBadge> : null,
    },
  ];
  const skeletonColumns: DenTableColumn<{ id: string }>[] = columns.map(({ key, header, width, align }) => ({
    key, header, width, align,
    render: () => key === "computer"
      ? <span className="flex min-w-[12rem] flex-col gap-1.5 pl-6"><DenSkeleton className="h-4 w-36" /><DenSkeleton className="h-3 w-16" /></span>
      : key === "problems" ? null : <DenSkeleton className={`h-4 ${key === "lastSeen" || key === "appVersion" ? "w-16" : "w-28"}`} />,
  }));

  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="admin-devices" aria-busy={loading} aria-label={embedded ? "Devices" : undefined}>
    {embedded ? null : <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-base font-medium">Devices</h1>
      <DenButton size="sm" variant="secondary" icon={RefreshCw} loading={loading} onClick={() => setAttempt((value) => value + 1)} data-testid="admin-devices-refresh">Refresh</DenButton>
    </div>}

    <div className={`flex min-h-8 flex-wrap items-center gap-x-6 gap-y-1 text-sm ${embedded ? "mt-5" : ""}`} data-testid="admin-devices-summary">
      {data ? <>
        {embedded
          ? <span className="tabular-nums">{countLabel(data.total, filtered ? "matching computer" : "computer")}</span>
          : <><span className="tabular-nums">{countLabel(data.summary.total, "computer")}</span><span className="tabular-nums">{data.summary.online.toLocaleString("en-US")} online</span></>}
        <ProblemsToggle count={embedded ? null : data.summary.withProblems} pressed={filters.problems} onToggle={() => narrow({ problems: !filters.problems })} />
      </> : error ? null : <><DenSkeleton className="h-4 w-28" /><DenSkeleton className="h-4 w-20" /><DenSkeleton className="h-4 w-56" /></>}
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <div className="w-full max-w-sm">
        <DenInput icon={Search} type="search" aria-label="Search computers" maxLength={160} value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)}
          placeholder={embedded ? "Name, provider id or owner" : "Name, provider id, organization or owner"} data-testid="admin-devices-search" />
      </div>
      <DenSegmented aria-label="Kind of computer" options={KIND_OPTIONS} value={filters.kind} onChange={(kind) => narrow({ kind })} optionTestId={(value) => `admin-devices-kind-${value}`} />
      <div className="w-48">
        <DenSelect aria-label="Provider" value={filters.provider} onChange={(event) => narrow({ provider: parseDeviceProvider(event.target.value) })}>
          <option value="all">All providers</option>
          {REMOTE_DEVICE_PROVIDERS.map((provider) => <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>)}
        </DenSelect>
      </div>
      <div className="w-48">
        <DenSelect aria-label="Availability" value={filters.availability} onChange={(event) => narrow({ availability: parseDeviceAvailability(event.target.value) })}>
          <option value="all">All availability</option>
          {REMOTE_DEVICE_AVAILABILITIES.map((availability) => <option key={availability} value={availability}>{REMOTE_DEVICE_AVAILABILITY_LABELS[availability]}</option>)}
        </DenSelect>
      </div>
      {!embedded && filters.organizationId ? <span className="inline-flex min-w-0 items-center gap-1 text-sm" data-testid="admin-devices-organization-filter">
        <span className="min-w-0 break-words">{organizationName ? `Only ${organizationName}` : "Only one organization"}</span>
        <button type="button" aria-label="Show every organization" onClick={() => narrow({ organizationId: "" })}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md ${secondaryText} hover:bg-[var(--dls-hover)] hover:text-[color:var(--dls-text-primary)] ${focusRing}`}>
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </span> : null}
    </div>

    {error ? <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm" data-testid="admin-devices-error">
      <p className="text-[color:var(--ow-danger)]">{error}{data ? " Showing the last list that loaded." : ""}</p>
      <DenButton variant="secondary" size="sm" loading={loading} onClick={() => setAttempt((value) => value + 1)}>Try again</DenButton>
      {filtered ? <DenButton variant="ghost" size="sm" onClick={clear}>Clear filters</DenButton> : null}
    </div> : null}

    {data && filters.device && !openInList ? <div className={`mt-4 border-t ${hairline} pt-4`} id={detailId(filters.device)}>
      <AdminDeviceDetail key={filters.device} deviceId={filters.device} refreshKey={reloadKey} onClose={() => toggle(filters.device)} onAccessFailure={onAccessFailure} />
    </div> : null}

    <div className="mt-4 min-w-0">
      {!data ? (error ? null : <div aria-hidden="true"><DenTable columns={skeletonColumns} rows={SKELETON_ROWS} getRowKey={(row) => row.id} density="compact" /></div>)
        : devices.length === 0 ? <div className={`flex flex-wrap items-center gap-3 border-t ${hairline} py-6 text-sm`} data-testid="admin-devices-empty">
          {filtered
            ? <><p className={secondaryText}>No computers match these filters.</p><DenButton variant="secondary" size="sm" onClick={clear}>Clear filters</DenButton></>
            : <p className={secondaryText}>No computers yet. They appear here when a signed-in desktop or Workbot reports one.</p>}
        </div>
        : <div className={loading ? "opacity-60 transition-opacity duration-150 motion-reduce:transition-none" : undefined}>
          <DenTable columns={columns} rows={devices} getRowKey={(device) => device.id} density="compact"
            renderRowDetail={(device) => device.id === filters.device
              ? <div id={detailId(device.id)} className="pb-2 pl-6 pt-2"><AdminDeviceDetail key={device.id} deviceId={device.id} refreshKey={reloadKey} onAccessFailure={onAccessFailure} /></div>
              : null} />
        </div>}
    </div>

    {data && pages > 1 ? <nav aria-label="Pages" className={`mt-4 flex flex-wrap items-center justify-end gap-3 text-xs ${secondaryText}`}>
      <span className="tabular-nums" data-testid="admin-devices-page">Page {data.page} of {pages}</span>
      <DenButton size="sm" variant="secondary" disabled={loading || data.page <= 1} onClick={() => apply({ page: Math.max(1, data.page - 1), device: "" })}>Previous</DenButton>
      <DenButton size="sm" variant="secondary" disabled={loading || data.page >= pages} onClick={() => apply({ page: data.page + 1, device: "" })}>Next</DenButton>
    </nav> : null}
  </section>;
}

/** "3 with problems in the last 24 hours", which also narrows the list to them. `count` is null when the number shown would not be this list's. */
function ProblemsToggle({ count, pressed, onToggle }: { count: number | null; pressed: boolean; onToggle: () => void }) {
  const label = count === null ? "With problems in the last 24 hours" : `${count.toLocaleString("en-US")} with problems in the last 24 hours`;
  if (count === 0 && !pressed) return <span className={secondaryText}>No problems in the last 24 hours</span>;
  return <button type="button" aria-pressed={pressed} onClick={onToggle} data-testid="admin-devices-problems"
    className={`-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 tabular-nums ${focusRing} ${pressed ? "bg-[var(--dls-hover)] font-medium" : "underline decoration-dotted underline-offset-4 hover:bg-[var(--dls-hover)]"} ${count ? "text-[color:var(--ow-danger)]" : ""}`}>
    {label}{pressed ? <X size={16} strokeWidth={1.5} aria-hidden="true" /> : null}
  </button>;
}
