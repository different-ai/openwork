"use client";

import { ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { FEATURE_CATEGORIES, FEATURE_CATEGORY_KEYS, FEATURES, isFeatureKey, type FeatureCategory, type FeatureKey } from "@openwork/features";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSegmented } from "../../app/(den)/_components/ui/segmented";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";
import { requestAdmin } from "./admin-request";
import { describeFeatureChange, parseFeatureChange, type AdminFeatureChange } from "./feature-change";

export type AdminFeatureUsageMember = {
  memberId: string;
  name: string | null;
  email: string | null;
  enabled: boolean;
  firstUsedAt: string;
  lastUsedAt: string;
  daysUsed: number;
};

export type AdminFeatureUsage = {
  key: FeatureKey;
  enabledMembers: number;
  usedLast7Days: number;
  usedLast30Days: number;
  /** Latest change that could affect this organization; null when never changed or from older servers. */
  lastChange: AdminFeatureChange | null;
  members: AdminFeatureUsageMember[];
};

export type AdminOrganizationFeatureUsage = {
  activeMembers: number;
  features: AdminFeatureUsage[];
  generatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const optionalText = (value: unknown) => typeof value === "string" && value ? value : null;

function parseMember(value: unknown): AdminFeatureUsageMember | null {
  if (!isRecord(value) || typeof value.memberId !== "string" || typeof value.lastUsedAt !== "string") return null;
  return {
    memberId: value.memberId,
    name: optionalText(value.name),
    email: optionalText(value.email),
    enabled: value.enabled === true,
    firstUsedAt: typeof value.firstUsedAt === "string" ? value.firstUsedAt : value.lastUsedAt,
    lastUsedAt: value.lastUsedAt,
    daysUsed: count(value.daysUsed),
  };
}

/** GET /v1/admin/organizations/:id/feature-usage; unknown feature keys (newer server) are dropped. */
export function parseAdminOrganizationFeatureUsage(payload: unknown): AdminOrganizationFeatureUsage | null {
  if (!isRecord(payload) || !Array.isArray(payload.features)) return null;
  const features = payload.features.flatMap((entry): AdminFeatureUsage[] => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !isFeatureKey(entry.key)) return [];
    const members = Array.isArray(entry.members) ? entry.members.flatMap((member) => parseMember(member) ?? []) : [];
    return [{ key: entry.key, enabledMembers: count(entry.enabledMembers), usedLast7Days: count(entry.usedLast7Days), usedLast30Days: count(entry.usedLast30Days), lastChange: parseFeatureChange(entry.lastChange), members }];
  });
  return { activeMembers: count(payload.activeMembers), features, generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : new Date().toISOString() };
}

/** Most used first, then most enabled; registry order breaks ties. */
export function sortFeatureUsage(features: readonly AdminFeatureUsage[]): AdminFeatureUsage[] {
  return features.map((feature, index) => ({ feature, index }))
    .sort((a, b) => b.feature.usedLast30Days - a.feature.usedLast30Days || b.feature.members.length - a.feature.members.length || b.feature.enabledMembers - a.feature.enabledMembers || a.index - b.index)
    .map(({ feature }) => feature);
}

/** "On for" cell: "3 of 12 members", "1 of 1 member". */
export const onFor = (enabled: number, total: number) => `${enabled} of ${total} ${total === 1 ? "member" : "members"}`;

const day = (value: string) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export type FeatureUsageGrouping = "feature" | "member" | "turnedOn" | "added";
export type FeatureUsageStatus = "all" | "used" | "unused" | "everyone" | "some" | "off";
export type FeatureUsageFilter = { search: string; status: FeatureUsageStatus; category: FeatureCategory | "all" };
export type FeatureUsageGroup = { id: string; label: string; features: AdminFeatureUsage[] };
export type MemberFeatureUse = Omit<AdminFeatureUsageMember, "memberId" | "name" | "email"> & { key: FeatureKey };
export type MemberFeatureUsage = { memberId: string; name: string | null; email: string | null; lastUsedAt: string; uses: MemberFeatureUse[] };

const GROUPINGS = [
  { value: "feature", label: "Feature" }, { value: "member", label: "Member" },
  { value: "turnedOn", label: "Turned on" }, { value: "added", label: "Date added" },
] as const satisfies readonly { value: FeatureUsageGrouping; label: string }[];
const STATUSES = [
  { value: "all", label: "Any status" }, { value: "used", label: "Used in the last 30 days" }, { value: "unused", label: "No recorded use" },
  { value: "everyone", label: "On for every member" }, { value: "some", label: "On for some members" }, { value: "off", label: "Off for every member" },
] as const satisfies readonly { value: FeatureUsageStatus; label: string }[];
export const NO_FEATURE_FILTER: FeatureUsageFilter = { search: "", status: "all", category: "all" };

const matches = (query: string, ...values: (string | null)[]) => values.some((value) => value?.toLowerCase().includes(query));

function hasStatus(feature: AdminFeatureUsage, status: FeatureUsageStatus, activeMembers: number) {
  switch (status) {
    case "all": return true;
    case "used": return feature.usedLast30Days > 0;
    case "unused": return feature.members.length === 0;
    case "everyone": return activeMembers > 0 && feature.enabledMembers >= activeMembers;
    case "some": return feature.enabledMembers > 0 && feature.enabledMembers < activeMembers;
    case "off": return feature.enabledMembers === 0;
  }
}

/** Status and category always apply; search matches a feature's name or key, or a member who used it. */
export function filterFeatureUsage(features: readonly AdminFeatureUsage[], filter: FeatureUsageFilter, activeMembers: number): AdminFeatureUsage[] {
  const query = filter.search.trim().toLowerCase();
  return features.filter((feature) => hasStatus(feature, filter.status, activeMembers)
    && (filter.category === "all" || FEATURES[feature.key].category === filter.category)
    && (!query || matches(query, FEATURES[feature.key].label, feature.key) || feature.members.some((member) => matches(query, member.name, member.email))));
}

/** When the feature was turned on for this organization: its latest change, when that turned it on and it is still on. */
export function turnedOnAt(feature: AdminFeatureUsage): string | null {
  const change = feature.lastChange;
  return change && feature.enabledMembers > 0 && (change.action === "on" || change.action === "restored") ? change.at : null;
}

const monthLabel = (iso: string) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
const addedAt = (key: FeatureKey) => `${FEATURES[key].added}T00:00:00.000Z`;

/** UTC calendar months, newest first; features without a date go last, still on before off. */
export function groupFeatureUsage(features: readonly AdminFeatureUsage[], grouping: "turnedOn" | "added"): FeatureUsageGroup[] {
  const dated = features.map((feature) => ({ feature, at: grouping === "added" ? addedAt(feature.key) : turnedOnAt(feature) }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const groups = new Map<string, FeatureUsageGroup>();
  for (const { feature, at } of dated) {
    const id = at ? at.slice(0, 7) : feature.enabledMembers > 0 ? "on" : "off";
    const label = at ? monthLabel(at) : id === "on" ? "On, with no recorded change" : "Off for every member";
    const group = groups.get(id) ?? { id, label, features: [] };
    group.features.push(feature);
    groups.set(id, group);
  }
  const rank = (id: string) => id === "on" ? 1 : id === "off" ? 2 : 0;
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

/** Each member who used a listed feature, most recent use first. A search on a member's name keeps all their features. */
export function groupUsageByMember(features: readonly AdminFeatureUsage[], search = ""): MemberFeatureUsage[] {
  const query = search.trim().toLowerCase();
  const people = new Map<string, MemberFeatureUsage>();
  for (const feature of features) {
    for (const { memberId, name, email, ...use } of feature.members) {
      const person = people.get(memberId) ?? { memberId, name, email, lastUsedAt: use.lastUsedAt, uses: [] };
      person.uses.push({ key: feature.key, ...use });
      if (use.lastUsedAt > person.lastUsedAt) person.lastUsedAt = use.lastUsedAt;
      people.set(memberId, person);
    }
  }
  return [...people.values()].flatMap((person) => {
    const uses = !query || matches(query, person.name, person.email) ? person.uses : person.uses.filter((use) => matches(query, FEATURES[use.key].label, use.key));
    if (uses.length === 0) return [];
    const sorted = uses.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    return [{ ...person, lastUsedAt: sorted[0]!.lastUsedAt, uses: sorted }];
  }).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

const memberName = (member: { name: string | null; email: string | null }) => member.name || member.email || "Unnamed member";

function MemberUsage({ feature }: { feature: AdminFeatureUsage }) {
  const columns: DenTableColumn<AdminFeatureUsageMember>[] = [
    { key: "member", header: "Member", render: (member) => <div className="min-w-0 break-words">
      <span className="font-medium text-gray-900">{memberName(member)}</span>
      {member.name && member.email ? <span className="ml-2 text-xs text-gray-500">{member.email}</span> : null}
    </div> },
    { key: "last", header: "Last used", width: "140px", render: (member) => day(member.lastUsedAt) },
    { key: "days", header: "Days used", width: "100px", align: "right", render: (member) => member.daysUsed },
    { key: "state", header: "Now", width: "90px", render: (member) => member.enabled ? "On" : <span className="text-gray-500">Off</span> },
  ];
  return <div className="pl-5" id={`admin-feature-usage-members-${feature.key}`} data-testid={`admin-feature-usage-members-${feature.key}`}>
    <DenTable columns={columns} rows={feature.members} getRowKey={(member) => member.memberId} density="compact" />
  </div>;
}

function MemberFeatures({ person }: { person: MemberFeatureUsage }) {
  const columns: DenTableColumn<MemberFeatureUse>[] = [
    { key: "feature", header: "Feature", render: (use) => <span className="font-medium text-gray-900">{FEATURES[use.key].label}</span> },
    { key: "first", header: "First used", width: "140px", render: (use) => day(use.firstUsedAt) },
    { key: "last", header: "Last used", width: "140px", render: (use) => day(use.lastUsedAt) },
    { key: "days", header: "Days used", width: "100px", align: "right", render: (use) => use.daysUsed },
    { key: "state", header: "Now", width: "90px", render: (use) => use.enabled ? "On" : <span className="text-gray-500">Off</span> },
  ];
  return <div className="pl-5" id={`admin-feature-usage-member-features-${person.memberId}`} data-testid={`admin-feature-usage-member-features-${person.memberId}`}>
    <DenTable columns={columns} rows={person.uses} getRowKey={(use) => use.key} density="compact" />
  </div>;
}

function ExpandButton({ id, open, onToggle, testId, children }: { id: string; open: boolean; onToggle: () => void; testId: string; children: string }) {
  return <DenButton variant="plain" size="inline" type="button" aria-expanded={open} data-testid={testId} aria-controls={id} onClick={onToggle} className="-my-1.5">
    <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
    {children}
  </DenButton>;
}

function toggled<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function AdminOrganizationFeatureUsageView({ organizationId, refreshKey, onAccessFailure }: {
  organizationId: string;
  refreshKey: number;
  onAccessFailure: (failure: AdminFeatureAccessFailure) => void;
}) {
  const [usage, setUsage] = useState<AdminOrganizationFeatureUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<FeatureKey>>(new Set());
  const [openMembers, setOpenMembers] = useState<ReadonlySet<string>>(new Set());
  const [grouping, setGrouping] = useState<FeatureUsageGrouping>("feature");
  const [filter, setFilter] = useState<FeatureUsageFilter>(NO_FEATURE_FILTER);
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/feature-usage`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void requestAdmin(path, parseAdminOrganizationFeatureUsage, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setUsage(result.data);
      else if (result.access === "signed-out" || result.access === "forbidden") onAccessFailure({ access: result.access, message: result.message });
      else setLoadError(result.message);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load feature usage.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, refreshKey, attempt, onAccessFailure]);

  const dateColumn: DenTableColumn<AdminFeatureUsage> | null = grouping === "turnedOn"
    ? { key: "turnedOn", header: "Turned on", width: "130px", render: (feature) => {
      const at = turnedOnAt(feature);
      return at && feature.lastChange ? <span title={describeFeatureChange(feature.lastChange, { showScope: true })}>{day(at)}</span> : <span className="text-gray-500">—</span>;
    } }
    : grouping === "added" ? { key: "added", header: "Added", width: "130px", render: (feature) => day(addedAt(feature.key)) } : null;

  const columns: DenTableColumn<AdminFeatureUsage>[] = [
    { key: "feature", header: "Feature", render: (feature) => feature.members.length > 0
      ? <ExpandButton id={`admin-feature-usage-members-${feature.key}`} testId={`admin-feature-usage-toggle-${feature.key}`} open={open.has(feature.key)} onToggle={() => setOpen((current) => toggled(current, feature.key))}>{FEATURES[feature.key].label}</ExpandButton>
      : <span className="pl-5 text-xs font-medium text-gray-900">{FEATURES[feature.key].label}</span> },
    ...(dateColumn ? [dateColumn] : []),
    { key: "enabled", header: "On for", width: "170px", render: (feature) => onFor(feature.enabledMembers, usage?.activeMembers ?? 0) },
    { key: "used", header: "Used", width: "210px", render: (feature) => feature.members.length === 0
      ? <span className="text-gray-500">No recorded use yet</span>
      : `${feature.usedLast30Days} in 30 days (${feature.usedLast7Days} in 7)` },
    { key: "last", header: "Last used", width: "130px", render: (feature) => feature.members[0] ? day(feature.members[0].lastUsedAt) : <span className="text-gray-500">Never</span> },
  ];

  const memberColumns: DenTableColumn<MemberFeatureUsage>[] = [
    { key: "member", header: "Member", render: (person) => <div className="min-w-0 break-words">
      <ExpandButton id={`admin-feature-usage-member-features-${person.memberId}`} testId={`admin-feature-usage-member-toggle-${person.memberId}`} open={openMembers.has(person.memberId)} onToggle={() => setOpenMembers((current) => toggled(current, person.memberId))}>{memberName(person)}</ExpandButton>
      {person.name && person.email ? <span className="ml-2 text-xs text-gray-500">{person.email}</span> : null}
    </div> },
    { key: "features", header: "Features used", width: "130px", align: "right", render: (person) => person.uses.length },
    { key: "last", header: "Last used", width: "130px", render: (person) => day(person.lastUsedAt) },
  ];

  const featureTable = (rows: readonly AdminFeatureUsage[]) => <DenTable columns={columns} rows={rows} getRowKey={(feature) => feature.key} density="compact"
    renderRowDetail={(feature) => open.has(feature.key) ? <MemberUsage feature={feature} /> : null} emptyLabel="No features match these filters." />;

  const anyUse = usage?.features.some((feature) => feature.members.length > 0) ?? false;
  const filtered = usage ? sortFeatureUsage(filterFeatureUsage(usage.features, filter, usage.activeMembers)) : [];
  const people = grouping === "member" ? groupUsageByMember(filtered, filter.search) : [];
  const filtering = filter.search.trim() !== "" || filter.status !== "all" || filter.category !== "all";
  const shown = grouping === "member"
    ? `${people.length} ${people.length === 1 ? "member" : "members"} with recorded use${usage ? ` of ${usage.activeMembers} active` : ""}`
    : `${filtered.length} of ${usage?.features.length ?? 0} features`;

  return (
    <section className="min-w-0 border-b border-gray-200 py-5" aria-label="Feature usage" aria-busy={loading} data-testid="admin-organization-feature-usage">
      <h2 className="text-sm font-semibold text-gray-900">Feature usage</h2>
      {loadError ? <div className="mt-3 text-sm text-red-700" role="alert">
        <p>{loadError}</p>
        <DenButton variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry feature usage</DenButton>
      </div> : null}
      {loading && !usage ? <div className="mt-3 grid gap-2" role="status" aria-label="Loading feature usage" data-testid="admin-feature-usage-loading">
        {[0, 1, 2, 3].map((row) => <div key={row} className="h-9 rounded-lg bg-gray-100" aria-hidden="true" />)}
      </div> : null}
      {usage ? <>
        {anyUse ? null : <p className="mt-3 text-sm text-gray-500" data-testid="admin-feature-usage-empty">No recorded use yet</p>}
        <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,14rem)]" data-testid="admin-feature-usage-filters">
          <label className="grid min-w-0 gap-2 text-xs text-gray-600">Search
            <DenInput icon={Search} aria-label="Search features or members" maxLength={160} value={filter.search} placeholder="Feature, member name or email"
              data-testid="admin-feature-usage-search" onChange={(event) => setFilter((current) => ({ ...current, search: event.target.value }))} />
          </label>
          <label className="grid min-w-0 gap-2 text-xs text-gray-600">Status
            <DenSelect aria-label="Feature status" value={filter.status} menuWidth="trigger" onChange={(event) => setFilter((current) => ({ ...current, status: STATUSES.find((status) => status.value === event.target.value)?.value ?? "all" }))}>
              {STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </DenSelect>
          </label>
          <label className="grid min-w-0 gap-2 text-xs text-gray-600">Category
            <DenSelect aria-label="Feature category" value={filter.category} menuWidth="trigger" onChange={(event) => setFilter((current) => ({ ...current, category: FEATURE_CATEGORY_KEYS.find((category) => category === event.target.value) ?? "all" }))}>
              <option value="all">Every category</option>
              {FEATURE_CATEGORY_KEYS.map((category) => <option key={category} value={category}>{FEATURE_CATEGORIES[category].label}</option>)}
            </DenSelect>
          </label>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-gray-600">
            <span>Group by</span>
            <DenSegmented aria-label="Group features by" options={GROUPINGS} value={grouping} onChange={setGrouping} className="max-w-full flex-wrap"
              optionTestId={(value) => `admin-feature-usage-group-${value}`} />
          </div>
          <p className="flex items-center gap-2 text-xs text-gray-500" aria-live="polite" data-testid="admin-feature-usage-count">
            {shown}
            {filtering ? <DenButton variant="ghost" size="inline" type="button" onClick={() => setFilter(NO_FEATURE_FILTER)}>Clear filters</DenButton> : null}
          </p>
        </div>
        <div className="mt-3">
          {grouping === "feature" ? featureTable(filtered) : null}
          {grouping === "member" ? <DenTable columns={memberColumns} rows={people} getRowKey={(person) => person.memberId} density="compact"
            renderRowDetail={(person) => openMembers.has(person.memberId) ? <MemberFeatures person={person} /> : null}
            emptyLabel={filtering ? "No member used a feature that matches these filters." : "No member has used a feature yet."} /> : null}
          {grouping === "turnedOn" || grouping === "added" ? (filtered.length === 0 ? featureTable([]) : groupFeatureUsage(filtered, grouping).map((group) =>
            <section key={group.id} className="mt-4 min-w-0 first:mt-0" aria-labelledby={`admin-feature-usage-group-${grouping}-${group.id}`} data-testid={`admin-feature-usage-group-${grouping}-${group.id}`}>
              <h3 id={`admin-feature-usage-group-${grouping}-${group.id}`} className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.label} · {group.features.length}</h3>
              {featureTable(group.features)}
            </section>)) : null}
        </div>
        <p className="mt-3 text-xs text-gray-500">Updated {new Date(usage.generatedAt).toLocaleString()}</p>
      </> : null}
    </section>
  );
}
