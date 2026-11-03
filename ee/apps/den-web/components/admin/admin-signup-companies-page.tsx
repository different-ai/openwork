"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { adminSignupCompaniesSchema, type AdminSignupCompanies } from "@openwork/types/den/admin-organization";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "./admin-access-screen";
import { readAdminListLocation } from "./admin-list-location";
import { BillingCell, OutreachCell, shortDate } from "./admin-opportunity-labels";
import { AdminOpportunityNav } from "./admin-opportunity-nav";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";
import { useAdminSessionCookie } from "./admin-shell";

type State = (AdminResult<AdminSignupCompanies> & { query: string }) | { access: "checking"; query: string };
type Company = AdminSignupCompanies["companies"][number];
const count = (value: number) => new Intl.NumberFormat().format(value);
const PATH = "/admin/opportunities/companies";
// The two saved views of the sales team's signup sheet.
const VIEWS = [{ id: "active", label: "Active (30d)" }, { id: "all", label: "All companies" }] as const;

export function AdminSignupCompaniesPage() {
  const params = useSearchParams();
  const hasSessionCookie = useAdminSessionCookie();
  const { search, page, offset } = readAdminListLocation(params);
  const activity = params.get("activity") === "all" ? "all" : "active";
  const outreach = ["not_contacted", "contacted", "any"].find(value => value === params.get("outreach")) ?? "not_contacted";
  const billing = ["any", "paying", "not_paying"].find(value => value === params.get("billing")) ?? "any";
  const sort = ["active", "signups", "recent", "signin"].find(value => value === params.get("sort")) ?? "active";
  const query = new URLSearchParams({ activity, outreach, billing, sort, search: search.slice(0, 160), limit: "50", offset: String(offset) }).toString();
  const [state, setState] = useState<State>(() => ({ access: hasSessionCookie ? "checking" : "signed-out", query, message: "" }));
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSessionCookie && !withStoredBearer({}).Authorization) {
      setState({ access: "signed-out", query, message: "" });
      return;
    }
    const controller = new AbortController();
    setState(current => current.access === "ready" && current.query === query ? current : { access: "checking", query });
    setRefreshing(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void requestAdmin(`/v1/admin/opportunities/companies?${query}`, payload => {
        const parsed = adminSignupCompaniesSchema.safeParse(payload);
        return parsed.success ? parsed.data : null;
      }, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        if (result.access === "error") setError(result.message);
        // Keep a verified snapshot only for a failed refresh of these filters.
        setState(current => result.access === "error" && current.access === "ready" && current.query === query ? current : { ...result, query });
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : "Could not load signup companies.";
        setError(message);
        setState(current => current.access === "ready" && current.query === query ? current : { access: "error", query, message });
      }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [attempt, hasSessionCookie, query]);

  function change(key: string, value: string) {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    const href = `${PATH}${next.size ? `?${next}` : ""}`;
    if (key === "search") window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }

  if (state.access !== "ready" && state.access !== "checking") {
    return <AdminAccessScreen state={state.access} message={state.message} onRetry={() => setAttempt(value => value + 1)} />;
  }
  const data = state.access === "ready" && state.query === query ? state.data : null;
  const columns: DenTableColumn<Company>[] = [
    { key: "company", header: "Company", render: row => <div className="min-w-40 max-w-xs break-words" data-testid={`admin-signup-company-${row.domain}`}>
      <p className="font-medium">{row.domain}</p>
      {row.workspaces.length ? <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{row.workspaces.map((workspace, index) => <span key={workspace.id}>
        {index ? ", " : ""}<Link prefetch={false} href={`/admin/organizations/${encodeURIComponent(workspace.id)}/insights`} className="hover:underline">{workspace.name}</Link>
      </span>)}{row.organizations > row.workspaces.length ? ` +${count(row.organizations - row.workspaces.length)}` : ""}</p> : <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">No organization joined</p>}
    </div> },
    { key: "signups", header: "Signups", align: "right", render: row => <div className="whitespace-nowrap tabular-nums">{count(row.signups)}<p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{count(row.organizations)} {row.organizations === 1 ? "org" : "orgs"}</p></div> },
    { key: "active", header: "Active users (30d)", align: "right", render: row => <span className="tabular-nums">{count(row.activeUsers)}</span> },
    { key: "signin", header: "First / last sign-in", render: row => <div className="whitespace-nowrap">
      <time dateTime={row.firstSignupAt}>{shortDate(row.firstSignupAt)}</time>
      <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{row.lastSignInAt ? <>Last <time dateTime={row.lastSignInAt}>{shortDate(row.lastSignInAt)}</time></> : "No sign-in on record"}</p>
    </div> },
    { key: "billing", header: "Plan", render: row => <BillingCell billing={row.billing} /> },
    { key: "outreach", header: "Outreach", render: row => <OutreachCell outreach={row.outreach} /> },
  ];
  return <section data-testid="admin-signup-companies" className="min-w-0 text-[var(--dls-text-primary)]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--dls-border)] py-5">
      <h1 className="text-lg font-semibold">Signups by company</h1>
      <DenButton size="sm" variant="secondary" disabled={refreshing} onClick={() => setAttempt(value => value + 1)}>Refresh</DenButton>
    </header>
    <AdminOpportunityNav active="companies" />
    <div role="group" aria-label="Saved views" className="flex flex-wrap gap-2 pt-5">
      {VIEWS.map(view => <DenButton key={view.id} size="sm" variant={activity === view.id ? "primary" : "secondary"} aria-pressed={activity === view.id} onClick={() => change("activity", view.id === "active" ? "" : view.id)}>{view.label}</DenButton>)}
    </div>
    <div className="grid gap-4 border-b border-[var(--dls-border)] py-5 sm:grid-cols-2 xl:grid-cols-4" aria-label="Company filters">
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Search company domains<DenInput aria-label="Search company domains" maxLength={160} value={search} onChange={event => change("search", event.target.value)} placeholder="example.com" /></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Outreach<DenSelect aria-label="Outreach" value={outreach} onChange={event => change("outreach", event.target.value)}><option value="not_contacted">Not contacted</option><option value="contacted">Contacted</option><option value="any">Any</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Billing<DenSelect aria-label="Billing" value={billing} onChange={event => change("billing", event.target.value)}><option value="any">Paying or not</option><option value="paying">Paying</option><option value="not_paying">Not paying</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Sort by<DenSelect aria-label="Sort by" value={sort} onChange={event => change("sort", event.target.value)}><option value="active">Most active users</option><option value="signups">Most signups</option><option value="recent">Newest first signup</option><option value="signin">Latest sign-in</option></DenSelect></label>
    </div>
    {error && data ? <div role="alert" className="py-4 text-sm text-red-700">Could not refresh companies. Showing the snapshot from {new Date(data.generatedAt).toLocaleString()}. {error}</div> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 py-4 text-xs text-[var(--dls-text-secondary)]" aria-live="polite">
      <p>{data ? `${count(data.page.total)} matching companies · page ${page}` : "Checking companies"}</p>
      <div className="flex gap-2"><DenButton size="sm" variant="secondary" disabled={refreshing || page === 1} onClick={() => change("page", String(page - 1))}>Previous</DenButton><DenButton size="sm" variant="secondary" disabled={refreshing || !data?.page.hasMore} onClick={() => change("page", String(page + 1))}>Next</DenButton></div>
    </div>
    {data ? <DenTable columns={columns} rows={data.companies} getRowKey={row => row.domain} density="compact" emptyLabel="No companies match these filters. Try All companies or a different outreach filter." /> : <div aria-busy="true" aria-label="Checking companies" className="grid gap-3 py-3">{[0, 1, 2, 3].map(row => <div key={row} className="h-12 rounded-sm bg-[var(--dls-hover)]" />)}</div>}
    <details className="mt-6 border-t border-[var(--dls-border)] py-4 text-xs text-[var(--dls-text-secondary)]">
      <summary className="w-fit font-medium">How companies are counted</summary>
      <ul className="mt-3 grid max-w-3xl list-disc gap-2 pl-5">
        <li>A company is a verified email domain outside known personal email providers. A domain does not establish employment, and its organizations stay separate.</li>
        <li>Signups are accounts on the domain. Orgs are the organizations those people joined. Last sign-in is the latest session still on record.</li>
        <li>Active users are people seen using the app in any of those organizations in the last 30 days. Self-hosted use and turned-off telemetry are not counted.</li>
        <li>Plan is the highest stored plan across the organizations. Paying means a current active subscription; trials are not paying.</li>
        <li>Contacted means a platform admin recorded outreach, a reply or a meeting for any of the organizations in This week.</li>
      </ul>
    </details>
    {data ? <p className="mt-2 text-xs text-[var(--dls-text-secondary)]">Snapshot {new Date(data.generatedAt).toLocaleString()}</p> : null}
  </section>;
}
