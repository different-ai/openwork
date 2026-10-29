"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { adminOpportunitiesSchema, type AdminOpportunities } from "@openwork/types/den/admin-organization";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "./admin-access-screen";
import { readAdminListLocation } from "./admin-list-location";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";
import { useAdminSessionCookie } from "./admin-shell";
import { AdminOpportunityNav } from "./admin-opportunity-nav";
import { BillingCell, OutreachCell } from "./admin-opportunity-labels";

type State = (AdminResult<AdminOpportunities> & { query: string }) | { access: "checking"; query: string };
type Opportunity = AdminOpportunities["organizations"][number];
const count = (value: number) => new Intl.NumberFormat().format(value);

function relativeDate(value: string, now: string) {
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1_440)} days ago`;
}

export function AdminOpportunitiesPage() {
  const params = useSearchParams();
  const hasSessionCookie = useAdminSessionCookie();
  const { search, page, offset } = readAdminListLocation(params);
  const days = ["7", "30", "90"].find(value => value === params.get("days")) ?? "30";
  const minMembers = ["1", "2", "5", "10"].find(value => value === params.get("minMembers")) ?? "2";
  const companyEmail = params.get("companyEmail") === "1" ? "1" : "0";
  const setup = ["any", "skills", "mcp", "both"].find(value => value === params.get("setup")) ?? "any";
  const outreach = ["any", "not_contacted", "contacted"].find(value => value === params.get("outreach")) ?? "any";
  const sort = ["recent", "active", "members"].find(value => value === params.get("sort")) ?? "recent";
  const query = new URLSearchParams({ days, minMembers, companyEmail, setup, outreach, sort, search: search.slice(0, 160), limit: "50", offset: String(offset) }).toString();
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
      void requestAdmin(`/v1/admin/opportunities?${query}`, payload => {
        const parsed = adminOpportunitiesSchema.safeParse(payload);
        return parsed.success ? parsed.data : null;
      }, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        if (result.access === "error") setError(result.message);
        // Keep a verified snapshot only for a failed refresh of these filters.
        // A lost session or allowlist grant clears every row immediately.
        setState(current => result.access === "error" && current.access === "ready" && current.query === query ? current : { ...result, query });
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : "Could not load opportunities.";
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
    const href = `/admin/opportunities/adoption${next.size ? `?${next}` : ""}`;
    if (key === "search") window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }

  if (state.access !== "ready" && state.access !== "checking") {
    return <AdminAccessScreen state={state.access} message={state.message} onRetry={() => setAttempt(value => value + 1)} />;
  }
  const data = state.access === "ready" && state.query === query ? state.data : null;
  const columns: DenTableColumn<Opportunity>[] = [
    { key: "organization", header: "Organization", render: row => <div className="min-w-40 max-w-xs break-words" data-testid={`admin-opportunity-${row.id}`}>
      <Link prefetch={false} href={`/admin/organizations/${encodeURIComponent(row.id)}`} className="font-medium text-[var(--dls-text-primary)] hover:underline">{row.name}</Link>
      <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{row.slug}</p>
    </div> },
    { key: "people", header: "People", align: "right", render: row => <div className="whitespace-nowrap tabular-nums">{count(row.members)} joined<p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{count(row.activeMembers)} active</p></div> },
    { key: "company", header: "Company-email signal", render: row => <div className="min-w-36 max-w-xs break-words">
      {row.companyDomain ? <><span>{row.companyDomain}{row.companyDomainCount > 1 ? ` +${row.companyDomainCount - 1}` : ""}</span><p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{count(row.companyEmailMembers)} verified {row.companyEmailMembers === 1 ? "address" : "addresses"}</p></> : <span className="text-[var(--dls-text-secondary)]">No verified company-email signal</span>}
    </div> },
    { key: "setup", header: "Cloud setup", render: row => <div className="whitespace-nowrap tabular-nums">{count(row.skills)} {row.skills === 1 ? "skill" : "skills"}<p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{count(row.mcpConnections)} {row.mcpConnections === 1 ? "MCP" : "MCPs"}</p></div> },
    { key: "billing", header: "Plan", render: row => <BillingCell billing={row.billing} /> },
    { key: "outreach", header: "Outreach", render: row => <OutreachCell outreach={row.outreach} /> },
    { key: "activity", header: "Last observed activity", align: "right", render: row => <time className="whitespace-nowrap" dateTime={row.lastActiveAt} title={new Date(row.lastActiveAt).toLocaleString()}>{relativeDate(row.lastActiveAt, data?.generatedAt ?? row.lastActiveAt)}</time> },
  ];
  return <section data-testid="admin-opportunities" className="min-w-0 text-[var(--dls-text-primary)]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--dls-border)] py-5">
      <h1 className="text-lg font-semibold">Adoption opportunities</h1>
      <DenButton size="sm" variant="secondary" disabled={refreshing} onClick={() => setAttempt(value => value + 1)}>Refresh</DenButton>
    </header>
    <AdminOpportunityNav active="adoption" />
    <div className="grid gap-4 border-b border-[var(--dls-border)] py-5 sm:grid-cols-2 xl:grid-cols-4" aria-label="Opportunity filters">
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Search organizations or domains<DenInput aria-label="Search organizations or domains" maxLength={160} value={search} onChange={event => change("search", event.target.value)} placeholder="Organization or company domain" /></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Activity window<DenSelect aria-label="Activity window" value={days} onChange={event => change("days", event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Joined users<DenSelect aria-label="Joined users" value={minMembers} onChange={event => change("minMembers", event.target.value)}><option value="1">1 or more</option><option value="2">2 or more</option><option value="5">5 or more</option><option value="10">10 or more</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Email signal<DenSelect aria-label="Email signal" value={companyEmail} onChange={event => change("companyEmail", event.target.value)}><option value="0">Any email</option><option value="1">Company-email signal</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Cloud setup<DenSelect aria-label="Cloud setup" value={setup} onChange={event => change("setup", event.target.value)}><option value="any">Any setup</option><option value="skills">Has skills</option><option value="mcp">Has MCPs</option><option value="both">Has skills and MCPs</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Outreach<DenSelect aria-label="Outreach" value={outreach} onChange={event => change("outreach", event.target.value)}><option value="any">Any</option><option value="not_contacted">Not contacted</option><option value="contacted">Contacted</option></DenSelect></label>
      <label className="grid gap-2 text-xs text-[var(--dls-text-secondary)]">Sort by<DenSelect aria-label="Sort by" value={sort} onChange={event => change("sort", event.target.value)}><option value="recent">Most recently active</option><option value="active">Most active users</option><option value="members">Most joined users</option></DenSelect></label>
    </div>
    {error && data ? <div role="alert" className="py-4 text-sm text-red-700">Could not refresh opportunities. Showing the snapshot from {new Date(data.generatedAt).toLocaleString()}. {error}</div> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 py-4 text-xs text-[var(--dls-text-secondary)]" aria-live="polite">
      <p>{data ? `${count(data.page.total)} matching organizations · page ${page}` : "Checking opportunities"}</p>
      <div className="flex gap-2"><DenButton size="sm" variant="secondary" disabled={refreshing || page === 1} onClick={() => change("page", String(page - 1))}>Previous</DenButton><DenButton size="sm" variant="secondary" disabled={refreshing || !data?.page.hasMore} onClick={() => change("page", String(page + 1))}>Next</DenButton></div>
    </div>
    {data ? <DenTable columns={columns} rows={data.organizations} getRowKey={row => row.id} density="compact" emptyLabel="No organizations match these signals. Try a longer activity window or broader filters." /> : <div aria-busy="true" aria-label="Checking opportunities" className="grid gap-3 py-3">{[0, 1, 2, 3].map(row => <div key={row} className="h-12 rounded-sm bg-[var(--dls-hover)]" />)}</div>}
    <details className="mt-6 border-t border-[var(--dls-border)] py-4 text-xs text-[var(--dls-text-secondary)]">
      <summary className="w-fit font-medium">How signals are counted</summary>
      <ul className="mt-3 grid max-w-3xl list-disc gap-2 pl-5">
        <li>People are joined, current human users. Invitations, removed members and setup agents are excluded.</li>
        <li>Activity is recorded app telemetry for this organization during the selected window. Missing telemetry, including opt-outs, does not establish inactivity; sign-in alone is not counted.</li>
        <li>Company-email signals use verified addresses outside known personal email providers. A domain does not establish employment; organizations are never combined by domain.</li>
        <li>Cloud setup counts active, non-deleted skills and MCP entries. Configuration does not prove recent use or a working connection.</li>
        <li>Plan is the stored plan tier. Paying means a current active subscription; trials are not paying. Contacted means a platform admin recorded outreach, a reply or a meeting in This week.</li>
      </ul>
    </details>
    {data ? <p className="mt-2 text-xs text-[var(--dls-text-secondary)]">Snapshot {new Date(data.generatedAt).toLocaleString()}</p> : null}
  </section>;
}
