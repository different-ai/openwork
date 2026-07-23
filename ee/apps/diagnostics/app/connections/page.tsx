import type { StoredConnectDiagnosticIncident } from "@openwork/types/den/connect-diagnostics"
import {
  connectionIncidentFilters,
  filterConnectionIncidents,
} from "../../src/connection-incident-query"
import { listConnectDiagnosticIncidents } from "../../src/connection-incident-store"
import { IncidentFilters } from "./incident-filters"

export const dynamic = "force-dynamic"

function shortHash(value: string | null): string {
  return value ? value.slice(0, 12) : "unattributed"
}

function Incident({ incident }: { incident: StoredConnectDiagnosticIncident }) {
  const failure = incident.outcome === "failure"
  return <article className="incident">
    <header>
      <div>
        <p className="eyebrow">{incident.source} observation · {incident.observedAt}</p>
        <h2>{incident.phase.replaceAll("_", " ")}</h2>
      </div>
      <span className={`status ${failure ? "failure" : "success"}`}>{incident.outcome}</span>
    </header>
    <div className="incident-facts">
      <div><span>Customer</span><a href={`/connections?organization=${incident.organizationHash}&hours=168`}><code>{shortHash(incident.organizationHash)}</code></a></div>
      <div><span>Client</span>{incident.clientHash ? <a href={`/connections?organization=${incident.organizationHash}&client=${incident.clientHash}&hours=168`}><code>{shortHash(incident.clientHash)}</code></a> : <code>unattributed</code>}</div>
      <div><span>Error</span><strong>{incident.errorCode ?? "none"}</strong></div>
      <div><span>Network</span><strong>{incident.networkCode ?? "not observed"}</strong></div>
      <div><span>HTTP</span><strong>{incident.httpStatus ?? "no response"}</strong></div>
      <div><span>Duration</span><strong>{incident.durationMs === null ? "not observed" : `${incident.durationMs} ms`}</strong></div>
      <div><span>Consecutive failures</span><strong>{incident.consecutiveFailures}</strong></div>
      <div><span>Retryable</span><strong>{incident.retryable === null ? "unknown" : incident.retryable ? "yes" : "no"}</strong></div>
      <div><span>Device online</span><strong>{incident.deviceOnline === null ? "server observation" : incident.deviceOnline ? "yes" : "no"}</strong></div>
    </div>
    <details>
      <summary>Correlation and version details</summary>
      <dl className="incident-details">
        <div><dt>Event</dt><dd><code>{incident.eventId}</code></dd></div>
        <div><dt>Attempt</dt><dd><code>{incident.attemptId ?? "server observation"}</code></dd></div>
        <div><dt>Server request</dt><dd><code>{incident.serverRequestId ?? "not observed"}</code></dd></div>
        <div><dt>App</dt><dd>{incident.appVersion ?? "not observed"}</dd></div>
        <div><dt>OpenWork server</dt><dd>{incident.serverVersion ?? "not observed"}</dd></div>
        <div><dt>Engine</dt><dd>{incident.engineVersion ?? "not observed"}</dd></div>
        <div><dt>Platform</dt><dd>{incident.platform ?? "not observed"}</dd></div>
        <div><dt>Received</dt><dd>{incident.receivedAt}</dd></div>
      </dl>
    </details>
  </article>
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const filters = connectionIncidentFilters(params)
  const all = await listConnectDiagnosticIncidents()
  const incidents = filterConnectionIncidents(all, filters)
  const failures = incidents.filter((incident) => incident.outcome === "failure")
  const clients = new Set(incidents.map((incident) => incident.clientHash).filter(Boolean))
  const recoveries = incidents.filter((incident) => incident.outcome === "recovered")
  const clustered = [...failures.reduce((counts, incident) => {
    const key = incident.errorCode ?? incident.networkCode ?? (incident.httpStatus ? `http_${incident.httpStatus}` : "unknown")
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map<string, number>()).entries()].sort((left, right) => right[1] - left[1]).slice(0, 6)

  return <main>
    <header className="hero">
      <div>
        <p className="eyebrow">OpenWork Enterprise</p>
        <h1>Connect incidents</h1>
        <p>Correlate desktop and Den observations for the OpenWork Cloud MCP connection without email, member identity, URLs, tokens, or customer content.</p>
      </div>
      <div className="hero-actions">
        <nav className="diagnostic-nav"><a className="active" href="/connections">Connections</a><a href="/">Wire traces</a></nav>
        <form action="/api/dashboard-session" method="post"><input name="intent" type="hidden" value="logout" /><button className="logout-button" type="submit">Sign out</button></form>
      </div>
    </header>
    <section className="safety"><strong>Seven-day rolling record.</strong> Identities are keyed pseudonyms. Paste a raw organization ID into the filter only when needed; it is hashed for lookup and is never stored in an incident.</section>
    <IncidentFilters
      client={filters.clientHash ?? ""}
      code={filters.errorCode ?? ""}
      hours={filters.sinceHours}
      organization={filters.organizationHash ?? ""}
      outcome={filters.outcome ?? ""}
      phase={filters.phase ?? ""}
      source={filters.source ?? ""}
      unstableOnly={filters.unstableOnly}
    />
    <div className="question-links">
      <a href="/connections?outcome=failure&hours=24">What failed today?</a>
      <a href="/connections?view=unstable&hours=168">Which clients are unstable?</a>
      <a href="/connections?phase=transport_auth&outcome=failure&hours=168">Is authentication failing?</a>
      <a href="/connections?outcome=recovered&hours=168">What recovered?</a>
    </div>
    <section className="incident-summary">
      <div><span>Events</span><strong>{incidents.length}</strong></div>
      <div><span>Failures</span><strong>{failures.length}</strong></div>
      <div><span>Clients</span><strong>{clients.size}</strong></div>
      <div><span>Recoveries</span><strong>{recoveries.length}</strong></div>
    </section>
    {clustered.length > 0 ? <section className="incident-clusters"><h2>Top failure clusters</h2><div>{clustered.map(([code, count]) => <a key={code} href={`/connections?code=${encodeURIComponent(code)}&hours=${filters.sinceHours}`}><code>{code}</code><strong>{count}</strong></a>)}</div></section> : null}
    <section className="summary"><h2>{incidents.length} matching observation{incidents.length === 1 ? "" : "s"}</h2><p>Newest first. Pair matching customer/client timestamps to compare what the desktop saw with what reached Den.</p></section>
    {incidents.length === 0
      ? <section className="empty"><h2>No matching Connect incidents</h2><p>Broaden the filters, or wait for a desktop maintenance check or Den MCP lifecycle request.</p></section>
      : <div className="history">{incidents.map((incident) => <Incident incident={incident} key={`${incident.source}-${incident.eventId}`} />)}</div>}
  </main>
}
