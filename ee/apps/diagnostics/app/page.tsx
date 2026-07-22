import { diagnosticsConfig, validateProductionConfig } from "../src/config"
import { listWireHistory } from "../src/history-store"
import type { WireBody, WireExchange } from "../src/contracts"
import { egressDiagnosticRunSchema } from "@openwork/types/den/egress-diagnostics"

export const dynamic = "force-dynamic"

function Body({ body }: { body: WireBody | null }) {
  if (!body) return <p className="muted">No body.</p>
  return <div className="body-summary">
    <p><strong>{body.summary}</strong> · {body.bytes} bytes · {body.mediaType}{body.truncated ? " · preview truncated" : ""}</p>
    {body.preview ? <pre>{body.preview}</pre> : <p className="muted">Content withheld; only size and media type were retained.</p>}
  </div>
}

function Headers({ headers }: { headers: Readonly<Record<string, string>> }) {
  return <dl className="headers">{Object.entries(headers).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
}

function Exchange({ exchange }: { exchange: WireExchange }) {
  const success = exchange.response.status >= 200 && exchange.response.status < 400
  return <article className="exchange">
    <header>
      <div><p className="eyebrow">{exchange.profile} · {exchange.receivedAt}</p><h2>{exchange.request.method} {exchange.request.path}</h2></div>
      <span className={success ? "status success" : "status failure"}>HTTP {exchange.response.status}</span>
    </header>
    <div className="proof-grid">
      <div><span>Diagnostic run</span><code>{exchange.runId ?? "Standalone request"}</code></div>
      <div><span>Diagnostic step</span><strong>{exchange.step ?? "Unspecified"}</strong></div>
      <div><span>Allowlist proof</span><code>{exchange.sourceProof}</code></div>
      <div><span>Diagnostic reference</span><code>{exchange.correlationId}</code></div>
      <div><span>Duration</span><strong>{exchange.durationMs} ms</strong></div>
      <div><span>Query names</span><strong>{exchange.request.queryKeys.join(", ") || "None"}</strong></div>
    </div>
    <details>
      <summary>Inspect safely redacted request and response</summary>
      <div className="wire-grid">
        <section><h3>Request headers</h3><Headers headers={exchange.request.headers} /><h3>Request body</h3><Body body={exchange.request.body} /></section>
        <section><h3>Response headers</h3><Headers headers={exchange.response.headers} /><h3>Response body</h3><Body body={exchange.response.body} /></section>
      </div>
    </details>
  </article>
}

export default async function DiagnosticsPage({ searchParams }: { searchParams: Promise<{ runId?: string | string[] }> }) {
  const params = await searchParams
  const suppliedRunId = typeof params.runId === "string" ? params.runId : ""
  const parsedRunId = egressDiagnosticRunSchema.shape.runId.safeParse(suppliedRunId)
  const runId = parsedRunId.success ? parsedRunId.data : null
  const history = await listWireHistory(runId ?? undefined)
  const config = diagnosticsConfig()
  const missing = validateProductionConfig()
  const origin = config.publicOrigin
  return <main>
    <meta httpEquiv="refresh" content="5" />
    <header className="hero">
      <div><p className="eyebrow">OpenWork Enterprise</p><h1>Diagnostics</h1><p>Prove that an enterprise allowlist reaches us, then inspect the client handshake request by request.</p></div>
      <div className="hero-actions">
        <div className="endpoint"><span>Active {config.profile} MCP endpoint</span><code>{origin}/mcp</code></div>
        <form action="/api/dashboard-session" method="post"><input name="intent" type="hidden" value="logout" /><button className="logout-button" type="submit">Sign out</button></form>
      </div>
    </header>
    <section className="safety">
      <strong>Safe by default.</strong> Every exchange is retained for at most 24 hours. Credentials, OAuth codes, tokens, cookies, session IDs, unknown headers, and tool argument values are redacted before storage.
    </section>
    {missing.length > 0 ? <section className="warning"><strong>Deployment configuration required:</strong> {missing.join(", ")}</section> : null}
    {runId ? <section className="run-filter"><strong>Support trace:</strong> <code>{runId}</code><a href="/">Show all requests</a></section> : null}
    <section className="summary"><h2>{history.length} recent exchange{history.length === 1 ? "" : "s"}</h2><p>The page refreshes every five seconds. A new row proves the request reached this deployment.</p></section>
    {history.length === 0
      ? <section className="empty"><h2>Waiting for a client</h2><p>Point the client to <code>{origin}/mcp</code> with the configured synthetic Bearer token.</p></section>
      : <div className="history">{history.map((exchange) => <Exchange exchange={exchange} key={exchange.id} />)}</div>}
  </main>
}
