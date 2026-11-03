"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { adminOrganizationDetailSchema, adminOrganizationInsightsSchema, adminOrganizationUsageSchema, type AdminOrganizationDetail, type AdminOrganizationInsights as InsightReport, type AdminOrganizationUsage, type AdminOrganizationUsageTotals } from "@openwork/types/den/admin-organization";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { AdminOrganizationFeatureControls, type AdminFeatureAccessFailure } from "./admin-organization-feature-controls";
import { AdminOrganizationFeatureUsageView } from "./admin-organization-feature-usage";
import { AdminAccessScreen } from "./admin-access-screen";
import { AdminBreadcrumbs } from "./admin-breadcrumbs";
import { ADMIN_LIST_PAGE_SIZE, useAdminListLocation } from "./admin-list-location";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";
import { useAdminSessionCookie } from "./admin-shell";
import { recordAdminOrganizationVisit } from "./admin-recent-organizations";
import { AdminOrganizationBilling } from "./admin-organization-billing";
import { formatPlanDate, planName } from "../../app/(den)/_lib/plan-display";

const AdminOrganizationInsights = lazy(() => import("./admin-organization-insights").then((module) => ({ default: module.AdminOrganizationInsights })));

type Section = "members" | "usage" | "insights" | "features" | "billing";
type DataSection = Extract<Section, "members" | "usage" | "insights">;
type Organization = AdminOrganizationDetail["organization"];
type PageData = AdminOrganizationDetail & { usage?: AdminOrganizationUsage["usage"]; insights?: InsightReport["insights"] };
type Member = AdminOrganizationDetail["members"][number];
const SECTIONS: { id: Section; label: string }[] = [
  { id: "members", label: "Members" }, { id: "usage", label: "Usage" }, { id: "insights", label: "Insights" },
  { id: "features", label: "Features" }, { id: "billing", label: "Billing" },
];
const zeroUsage: AdminOrganizationUsageTotals = { requests: 0, tokens: 0, costMicroUsd: 0, unreportedRequests: 0, unpricedRequests: 0 };
const count = (value: number) => new Intl.NumberFormat().format(value);
const requests = (value: number) => `${count(value)} ${value === 1 ? "request" : "requests"}`;
const cost = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value / 1_000_000);
const date = (value: string) => new Date(value).toLocaleDateString();
const organizationPath = (organizationId: string) => `/v1/admin/organizations/${encodeURIComponent(organizationId)}`;

function Coverage({ totals }: { totals: AdminOrganizationUsageTotals }) {
  if (totals.unreportedRequests === 0 && totals.unpricedRequests === 0) return null;
  return <p className="mt-1 text-xs text-gray-500">{totals.unreportedRequests === null ? "Token coverage unknown" : `${requests(totals.unreportedRequests)} without reported tokens`}; {totals.unpricedRequests === null ? "price coverage unknown" : `${requests(totals.unpricedRequests)} without a recorded price`}.</p>;
}

/** "Enterprise · set by admin", "Team · paid in Stripe" or "Free". */
function planSummary(organization: Organization) {
  const plan = organization.plan;
  if (!plan) return planName(organization.planTier === "team" || organization.planTier === "enterprise" ? organization.planTier : "free");
  if (plan.paidBy !== "none") return `${planName("team")} · paid in Stripe`;
  if (plan.tier === "free") return "Free";
  return `${planName(plan.tier)} · ${plan.source === "grandfathered" ? "grandfathered" : "set by admin"}`;
}

/** "7 of 20" or "31 · no limit". */
function usersSummary(organization: Organization) {
  const plan = organization.plan;
  if (!plan) return `${count(organization.memberCount)} / ${count(organization.seatLimit)}`;
  return plan.userLimit === null ? `${count(plan.users)} · no limit` : `${count(plan.users)} of ${count(plan.userLimit)}`;
}

function sectionPath(organizationId: string, section: Section, search: string, offset: number) {
  if (section === "features" || section === "billing") return null;
  const listed = section !== "insights";
  const query = new URLSearchParams({ limit: listed ? String(ADMIN_LIST_PAGE_SIZE) : "1", offset: listed ? String(offset) : "0" });
  if (listed && search.trim()) query.set("search", search.trim());
  return `${organizationPath(organizationId)}${section === "members" ? "" : `/${section}`}?${query}`;
}

// Tab snapshots live in memory for this tab only. A revisited tab renders its
// last snapshot at once and refreshes it; a hovered tab starts its request
// early. Cached records are never shown before this visit's access check.
const sectionCache = new Map<string, PageData>();
const sectionRequests = new Map<string, Promise<AdminResult<PageData>>>();

function rememberSection(path: string, data: PageData) {
  sectionCache.delete(path);
  sectionCache.set(path, data);
  if (sectionCache.size > 24) sectionCache.delete(sectionCache.keys().next().value!);
}

function loadSection(path: string, section: DataSection) {
  const pending = sectionRequests.get(path);
  if (pending) return pending;
  const schema = section === "insights" ? adminOrganizationInsightsSchema : section === "usage" ? adminOrganizationUsageSchema : adminOrganizationDetailSchema;
  const request = requestAdmin<PageData>(path, (payload) => {
    const result = schema.safeParse(payload);
    return result.success ? result.data : null;
  }).then((result) => {
    if (result.access === "ready") rememberSection(path, result.data);
    else if (result.access !== "error") sectionCache.clear();
    return result;
  }, (error: unknown): AdminResult<PageData> => ({ access: "error", message: error instanceof Error ? error.message : "Could not load this organization." }))
    .finally(() => sectionRequests.delete(path));
  sectionRequests.set(path, request);
  return request;
}

type OrganizationContextValue = {
  organization: Organization | null;
  verified: boolean;
  refreshKey: number;
  refresh: () => void;
  fail: (failure: AdminFeatureAccessFailure) => void;
  setSectionBusy: (busy: boolean) => void;
};
const OrganizationContext = createContext<OrganizationContextValue | null>(null);

function useOrganization() {
  const context = useContext(OrganizationContext);
  if (!context) throw new Error("Organization sections render inside AdminOrganizationLayout.");
  return context;
}

/**
 * Header, tabs and identity stay mounted while the admin switches tabs. Only
 * the identity is required to draw the header; each tab loads its own data
 * in parallel and never blocks the header or the other tabs.
 */
export function AdminOrganizationLayout({ organizationId, children }: { organizationId: string; children: ReactNode }) {
  const hasSessionCookie = useAdminSessionCookie();
  const pathname = usePathname();
  const { search, page, offset, organizationsHref } = useAdminListLocation();
  const base = `/admin/organizations/${encodeURIComponent(organizationId)}`;
  const section = SECTIONS.find(({ id }) => id !== "members" && pathname === `${base}/${id}`)?.id ?? "members";
  const [state, setState] = useState<AdminResult<Organization> | { access: "checking" }>(() => hasSessionCookie ? { access: "checking" } : { access: "signed-out", message: "" });
  const [failure, setFailure] = useState<AdminFeatureAccessFailure | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [sectionBusy, setSectionBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fail = useCallback((next: AdminFeatureAccessFailure) => {
    sectionCache.clear();
    setFailure(next);
  }, []);

  useEffect(() => {
    if (!hasSessionCookie && !withStoredBearer({}).Authorization && refreshKey === 0) {
      setState({ access: "signed-out", message: "" });
      return;
    }
    const controller = new AbortController();
    setState((current) => current.access === "ready" ? current : { access: "checking" });
    setErrorMessage(null);
    setRefreshing(true);
    const accept = (result: AdminResult<Organization>) => {
      if (controller.signal.aborted) return;
      if (result.access === "error") setErrorMessage(result.message);
      if (result.access === "signed-out" || result.access === "forbidden") sectionCache.clear();
      // Preserve the organization during a failed refresh. Authentication and
      // access failures still discard every record and control immediately.
      setState((current) => result.access === "error" && current.access === "ready" ? current : result);
    };
    void requestAdmin<Organization>(`${organizationPath(organizationId)}?limit=1&offset=0`, (payload) => {
      const result = adminOrganizationDetailSchema.safeParse(payload);
      return result.success ? result.data.organization : null;
    }, controller.signal).then(accept).catch((error: unknown) => {
      accept({ access: "error", message: error instanceof Error ? error.message : "Could not load this organization." });
    }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [hasSessionCookie, organizationId, refreshKey]);

  const organization = state.access === "ready" && state.data.id === organizationId ? state.data : null;
  const visitedName = organization?.name;
  const visitedSlug = organization?.slug;
  useEffect(() => {
    if (visitedName !== undefined) recordAdminOrganizationVisit({ id: organizationId, name: visitedName, slug: visitedSlug });
  }, [organizationId, visitedName, visitedSlug]);

  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (page > 1) query.set("page", String(page));
  if (organizationsHref !== "/admin/organizations") query.set("returnTo", organizationsHref);
  const suffix = query.size ? `?${query}` : "";
  const breadcrumbs = <AdminBreadcrumbs items={[
    { id: "admin", label: "Admin", href: "/admin" },
    { id: "organizations", label: "Organizations", href: organizationsHref },
    { id: "organization", label: organization?.name ?? "Organization", href: section !== "members" ? `${base}${suffix}` : undefined },
    ...(section !== "members" ? [{ id: section, label: SECTIONS.find(({ id }) => id === section)!.label }] : []),
  ]} />;

  const denied = failure ?? (state.access === "signed-out" || state.access === "forbidden" ? state : null);
  if (denied) return <>{breadcrumbs}<AdminAccessScreen state={denied.access} message={denied.message} onRetry={() => { setFailure(null); setRefreshKey((value) => value + 1); }} /></>;
  if (state.access === "error") return <>{breadcrumbs}<AdminAccessScreen state="error" message={state.message} onRetry={() => setRefreshKey((value) => value + 1)} /></>;

  const warm = (target: Section) => {
    const path = organization ? sectionPath(organizationId, target, search, offset) : null;
    if (path && target !== section && !sectionCache.has(path)) void loadSection(path, target as DataSection);
  };

  return (
    <OrganizationContext.Provider value={{ organization, verified: organization !== null, refreshKey, refresh: () => setRefreshKey((value) => value + 1), fail, setSectionBusy }}>
    {breadcrumbs}
    <section data-testid="admin-organization-page" aria-busy={refreshing || sectionBusy} className="min-w-0 bg-white">
      {errorMessage ? <p role="alert" className="border-b border-gray-200 p-4 text-sm text-red-700">{errorMessage} Use Refresh to try again. Showing the last successful snapshot.</p> : null}
      <header className="border-b border-gray-200 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {organization ? <h1 className="min-w-0 break-words text-lg font-semibold text-gray-900">{organization.name}</h1> : <div aria-busy="true" aria-label="Loading organization" className="h-7 w-56 rounded-sm bg-gray-100" />}
          <DenButton size="sm" variant="secondary" loading={refreshing || sectionBusy} onClick={() => setRefreshKey((value) => value + 1)}>Refresh</DenButton>
        </div>
        {organization ? <>
          <p className="mt-2 break-all text-xs text-gray-500">{organization.slug || organization.id}</p>
          <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div data-testid="admin-organization-plan"><dt className="text-gray-500">Plan</dt><dd className="mt-1 text-gray-900">{planSummary(organization)}</dd></div>
            <div data-testid="admin-organization-users"><dt className="text-gray-500">Users</dt><dd className="mt-1 tabular-nums text-gray-900">{usersSummary(organization)}</dd></div>
            {organization.plan?.endsAt ? <div data-testid="admin-organization-ends"><dt className="text-gray-500">{organization.plan.ended ? "Ended" : "Ends"}</dt><dd className={`mt-1 ${organization.plan.ended ? "text-amber-800" : "text-gray-900"}`}>{formatPlanDate(organization.plan.endsAt, { year: true })}</dd></div> : null}
            <div><dt className="text-gray-500">Created</dt><dd className="mt-1 text-gray-900">{date(organization.createdAt)}</dd></div>
          </dl>
        </> : <div className="mt-3 h-16 w-80 max-w-full rounded-sm bg-gray-100" />}
        <nav aria-label="Organization sections" className="mt-5 flex flex-wrap gap-x-5 gap-y-1">
          {SECTIONS.map(({ id, label }) => (
            <Link key={id} href={`${base}${id === "members" ? "" : `/${id}`}${suffix}`} prefetch={false} aria-current={section === id ? "page" : undefined}
              onPointerEnter={() => warm(id)} onFocus={() => warm(id)}
              className={`border-b-2 px-1 py-2 text-sm font-medium ${section === id ? "border-slate-900 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-950"}`}>{label}</Link>
          ))}
        </nav>
      </header>
      {children}
    </section>
    </OrganizationContext.Provider>
  );
}

function SectionSkeleton({ label }: { label: string }) {
  return <div aria-busy="true" aria-label={label} className="py-5"><div className="h-5 w-40 rounded-sm bg-gray-100" /><div className="mt-4 h-10 rounded-sm bg-gray-100" /><div className="mt-4 h-56 rounded-sm bg-gray-100" /></div>;
}

export function AdminOrganizationPage({ organizationId, section }: { organizationId: string; section: Section }) {
  const { organization, verified, refreshKey, refresh, fail, setSectionBusy } = useOrganization();
  const { search, draftSearch, page, offset, setSearch, setPage } = useAdminListLocation();
  const path = sectionPath(organizationId, section, search, offset);
  // `trusted` is false only for a snapshot read from memory before this
  // visit's access check finished.
  const [snapshot, setSnapshot] = useState<{ data: PageData; trusted: boolean } | null>(() => {
    const cached = path ? sectionCache.get(path) : undefined;
    return cached ? { data: cached, trusted: false } : null;
  });
  const [loading, setLoading] = useState(Boolean(path));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [featureMember, setFeatureMember] = useState<Member | null>(null);

  useEffect(() => setSectionBusy(loading), [loading, setSectionBusy]);
  useEffect(() => () => setSectionBusy(false), [setSectionBusy]);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const cached = sectionCache.get(path);
    if (cached) setSnapshot((current) => current?.data === cached ? current : { data: cached, trusted: false });
    setLoading(true);
    setErrorMessage(null);
    // Debounce search typing only; tab switches and pages start at once.
    const timeout = window.setTimeout(() => {
      void loadSection(path, section as DataSection).then((result) => {
        if (cancelled) return;
        if (result.access === "ready") setSnapshot({ data: result.data, trusted: true });
        else if (result.access === "error") setErrorMessage(result.message);
        else fail({ access: result.access, message: result.message });
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 75 : 0);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [path, section, search, refreshKey, fail]);

  if (section === "features") return <>
    <AdminOrganizationFeatureUsageView key={`usage:${organizationId}`} organizationId={organizationId} refreshKey={refreshKey} onAccessFailure={fail} />
    <AdminOrganizationFeatureControls key={organizationId} organizationId={organizationId} refreshKey={refreshKey} onAccessFailure={fail} />
  </>;
  if (section === "billing") return organization ? <AdminOrganizationBilling key={organizationId} organization={organization} onSaved={refresh} onAccessFailure={fail} /> : <SectionSkeleton label="Loading billing" />;

  const data = snapshot && (snapshot.trusted || verified) ? snapshot.data : null;
  const errorNotice = errorMessage ? <p role="alert" className="border-b border-gray-200 p-4 text-sm text-red-700">{errorMessage} Use Refresh to try again.{data ? " Showing the last successful snapshot." : ""}</p> : null;
  if (!data) return <>{errorNotice}{errorMessage ? null : <SectionSkeleton label={`Loading ${section}`} />}</>;

  if (section === "insights") return <>{errorNotice}{data.insights ? <Suspense fallback={<p role="status" className="py-6 text-sm text-slate-500">Loading insights charts…</p>}><AdminOrganizationInsights organization={organization ?? data.organization} insights={data.insights} /></Suspense> : <SectionSkeleton label="Loading insights" />}</>;

  const usage = data.usage;
  const usageByMember = new Map(usage?.members.map((entry) => [entry.memberId, entry]));
  const personColumn: DenTableColumn<Member> = {
    key: "person", header: "Member", render: (member) => <div className="min-w-0 max-w-xs break-words" data-testid={`admin-organization-member-${member.id}`}>
      {member.userId ? <Link href={`/admin/users?${new URLSearchParams({ search: member.userId })}`} prefetch={false} className="font-medium text-gray-900 hover:underline">{member.name || member.email || "Unnamed member"}</Link> : <span className="font-medium text-gray-900">Pending member</span>}
      {member.email ? <p className="mt-1 text-xs text-gray-500">{member.email}</p> : null}
    </div>,
  };
  const columns: DenTableColumn<Member>[] = section === "members" ? [
    personColumn,
    { key: "role", header: "Role", render: (member) => member.role },
    { key: "features", header: "Features", render: (member) => member.userId ? <DenButton variant="ghost" size="inline" data-testid={`admin-member-features-${member.id}`} onClick={() => setFeatureMember(member)}>Edit features</DenButton> : <span className="text-gray-500">Invitation pending</span> },
    { key: "joined", header: "Joined", render: (member) => member.joinedAt ? date(member.joinedAt) : "Invitation pending" },
  ] : [
    personColumn,
    { key: "requests", header: "Requests", align: "right", render: (member) => count((usageByMember.get(member.id) ?? zeroUsage).requests) },
    { key: "tokens", header: "Reported tokens", align: "right", render: (member) => count((usageByMember.get(member.id) ?? zeroUsage).tokens) },
    { key: "cost", header: "Recorded cost", align: "right", render: (member) => {
      const totals = usageByMember.get(member.id) ?? zeroUsage;
      return <div data-testid={`admin-organization-member-usage-${member.id}`}>
        {totals.costMicroUsd === 0 && totals.unpricedRequests !== 0 ? "Unknown" : cost(totals.costMicroUsd)}
        <Coverage totals={totals} />
      </div>;
    } },
  ];

  return (
    <>
      {errorNotice}
      {section === "usage" && usage ? <section aria-label="Organization usage" data-testid="admin-organization-usage" className="border-b border-gray-200 py-5">
        <h2 className="text-sm font-semibold text-gray-900">Gateway usage</h2>
        <p className="mt-1 text-xs text-gray-500">{usage.from} – {usage.to} UTC</p>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <div><dt className="text-gray-500">Requests</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{count(usage.totals.requests)}</dd></div>
          <div><dt className="text-gray-500">Reported tokens</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{count(usage.totals.tokens)}</dd></div>
          <div><dt className="text-gray-500">Recorded cost</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{usage.totals.costMicroUsd === 0 && usage.totals.unpricedRequests !== 0 ? "Unknown" : cost(usage.totals.costMicroUsd)}</dd></div>
        </dl>
        <Coverage totals={usage.totals} />
        {usage.totals.requests === 0 ? <p className="mt-4 text-sm text-gray-500">No recorded gateway requests in this period.</p> : null}
      </section> : null}

      {section === "members" && featureMember ? <div className="border-b border-gray-200 py-4" data-testid="admin-member-feature-editor">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-900">{featureMember.name || featureMember.email || "Member"}</h2>
          <DenButton variant="ghost" size="inline" onClick={() => setFeatureMember(null)}>Close member features</DenButton>
        </div>
        <AdminOrganizationFeatureControls key={`${organizationId}:${featureMember.id}`} organizationId={organizationId} memberId={featureMember.id} refreshKey={refreshKey} onAccessFailure={fail} />
      </div> : null}
      <div className="py-5">
        <h2 className="text-sm font-semibold text-gray-900">{section === "usage" ? "Usage by member" : "Members"}</h2>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <label className="grid w-full max-w-md gap-2 text-sm text-gray-600">Search members<DenInput aria-label="Search members" maxLength={160} value={draftSearch} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, or role" /></label>
          <div className="flex gap-2">
            <DenButton size="sm" variant="secondary" disabled={loading || offset === 0} onClick={() => setPage(Math.max(1, page - 1))}>Previous</DenButton>
            <DenButton size="sm" variant="secondary" disabled={loading || !data.page.hasMore} onClick={() => setPage(page + 1)}>Next</DenButton>
          </div>
        </div>
        <p className="my-4 text-xs text-gray-500">Page {Math.floor(data.page.offset / ADMIN_LIST_PAGE_SIZE) + 1} · {count(data.page.total)} matching members</p>
        <DenTable columns={columns} rows={data.members} getRowKey={(member) => member.id} density="compact" emptyLabel={search ? "No matching members. Try another name, email, or role." : "No active members in this organization."} />
        <p className="mt-5 text-xs text-gray-500">Updated {new Date(data.generatedAt).toLocaleString()}</p>
      </div>
    </>
  );
}
