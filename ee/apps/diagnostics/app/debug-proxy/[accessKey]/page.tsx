import { notFound } from "next/navigation"
import { diagnosticsConfig } from "../../../src/config"
import {
  accessKeyMatches,
  connectDebugProxyConfig,
  encodeUpstreamParameter,
} from "../../../src/connect-debug-proxy-config"
import { listConnectDebugProxyRequests } from "../../../src/connect-debug-proxy-log"
import { CONNECT_DEBUG_PROXY_SCENARIOS } from "../../../src/connect-debug-proxy-scenarios"

export const dynamic = "force-dynamic"

function proxyBaseUrl(input: {
  accessKey: string
  origin: string
  scenario: string
  upstream: string
  defaultUpstream: string
}): string {
  const override = input.upstream === input.defaultUpstream ? "" : `/${encodeUpstreamParameter(input.upstream)}`
  return `${input.origin}/via/${input.scenario}/${input.accessKey}${override}`
}

export default async function ConnectDebugProxyPage(input: {
  params: Promise<{ accessKey: string }>
  searchParams: Promise<{ upstream?: string | string[] }>
}) {
  const params = await input.params
  const config = connectDebugProxyConfig()
  if (!accessKeyMatches(params.accessKey, config.accessKey)) notFound()
  const searchParams = await input.searchParams
  const suppliedUpstream = typeof searchParams.upstream === "string" ? searchParams.upstream : config.defaultUpstream
  const choices = [...new Set([config.defaultUpstream, ...config.allowedUpstreams].filter(Boolean))]
  if (!choices.includes(suppliedUpstream)) notFound()
  const origin = diagnosticsConfig().publicOrigin
  const requests = listConnectDebugProxyRequests()
  return <main className="debug-proxy-shell">
    <meta httpEquiv="refresh" content="5" />
    <header className="hero debug-proxy-hero">
      <div>
        <p className="eyebrow">OpenWork Connect</p>
        <h1>Connect debug proxy</h1>
        <p>Copy one scenario base URL into the desktop Den base URL field, then use the diagnostics trace to inspect the controlled failure.</p>
      </div>
      <div className="hero-actions">
        <div className="endpoint"><span>Selected upstream</span><code>{suppliedUpstream}</code></div>
        <a className="logout-button debug-proxy-link" href="/">Diagnostics dashboard</a>
      </div>
    </header>
    <section className="warning">
      <strong>Credentials transit this deployment.</strong> Use a staging or development Den whenever possible. Request headers, cookies, query values, and bodies are never retained by this request log.
    </section>
    {config.errors.length > 0
      ? <section className="warning"><strong>Connect debug proxy configuration required:</strong> {config.errors.join(", ")}</section>
      : null}
    <section className="proxy-controls">
      <div>
        <p className="eyebrow">Target</p>
        <h2>Upstream selector</h2>
        <p>Only the default and origins whose hosts are listed in <code>DEBUG_PROXY_ALLOWED_UPSTREAMS</code> are accepted.</p>
      </div>
      <form method="get">
        <label htmlFor="upstream">Den upstream</label>
        <select defaultValue={suppliedUpstream} id="upstream" name="upstream">
          {choices.map((choice) => <option key={choice} value={choice}>{choice}{choice === config.defaultUpstream ? " (default)" : ""}</option>)}
        </select>
        <button type="submit">Generate URLs</button>
      </form>
    </section>
    <section className="summary"><h2>Scenario test matrix</h2><p>Each URL is stateless and stable for this deployment.</p></section>
    <div className="scenario-grid">
      {CONNECT_DEBUG_PROXY_SCENARIOS.map((scenario) => {
        const url = proxyBaseUrl({
          accessKey: params.accessKey,
          defaultUpstream: config.defaultUpstream,
          origin,
          scenario: scenario.slug,
          upstream: suppliedUpstream,
        })
        return <article className="scenario-card" key={scenario.slug}>
          <header><h2>{scenario.slug}</h2><span className="status">{scenario.slug === "default" ? "pass-through" : "fault"}</span></header>
          <label>Copy-paste Den base URL</label>
          <code className="copy-url">{url}</code>
          <dl>
            <div><dt>What it breaks</dt><dd>{scenario.breaks}</dd></div>
            <div><dt>Expected client result</dt><dd>{scenario.expected}</dd></div>
          </dl>
        </article>
      })}
    </div>
    <section className="summary"><h2>Live request log</h2><p>Best effort, newest first, per running instance. Refreshes every five seconds.</p></section>
    {requests.length === 0
      ? <section className="empty"><h2>Waiting for proxied traffic</h2><p>No request metadata has been retained by this instance.</p></section>
      : <div className="proxy-log"><table><thead><tr><th>Received</th><th>Method</th><th>Path</th><th>Scenario</th><th>Applied fault</th><th>Status</th><th>Latency</th></tr></thead><tbody>
        {requests.map((request, index) => <tr key={`${request.receivedAt}-${index}`}><td>{request.receivedAt}</td><td>{request.method}</td><td><code>{request.path}</code></td><td>{request.scenario}</td><td>{request.appliedFault}</td><td>{request.status ?? "pending"}</td><td>{request.latencyMs} ms</td></tr>)}
      </tbody></table></div>}
  </main>
}
