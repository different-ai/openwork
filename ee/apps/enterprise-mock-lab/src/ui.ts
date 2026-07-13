import type { LabFault, LabInstanceView, LabProfile } from "./contracts.js"

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function safeDocumentationUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
  } catch {
    return null
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(title)} · Enterprise Mock Lab</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    ${body}
  </body>
</html>`
}

export function renderLoginPage(error?: string): string {
  return page(
    "Sign in",
    `<main id="main-content" class="login-shell">
      <section class="login-card" aria-labelledby="login-title">
        <p class="eyebrow">Local development control plane</p>
        <h1 id="login-title">Enterprise Mock Lab</h1>
        <p>Configure isolated enterprise MCP simulations without exposing their controls on the provider-facing endpoint.</p>
        ${error ? `<p class="notice notice--error" role="alert">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="/session/login" class="stack">
          <label for="admin-secret">Admin secret</label>
          <input id="admin-secret" name="adminSecret" type="password" minlength="32" required autocomplete="current-password" autofocus>
          <button type="submit">Unlock local lab</button>
        </form>
        <p class="fine-print">The secret is checked in memory and is never returned to the browser.</p>
      </section>
    </main>`,
  )
}

function renderProfile(profile: LabProfile): string {
  const links = profile.provenance.documentationUrls
    .map((rawUrl) => {
      const url = safeDocumentationUrl(rawUrl)
      return url ? `<li><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(new URL(url).hostname)}</a></li>` : ""
    })
    .join("")
  return `<article class="profile-card">
    <div class="cluster cluster--between">
      <h3>${escapeHtml(profile.name)}</h3>
      <span class="badge">${escapeHtml(profile.provenance.fidelity)}</span>
    </div>
    <p>${escapeHtml(profile.description)}</p>
    <dl class="facts">
      <div><dt>Product surface</dt><dd>${escapeHtml(profile.provenance.productSurface)}</dd></div>
      <div><dt>Fixture version</dt><dd>${escapeHtml(profile.fixtureVersion)}</dd></div>
      <div><dt>Verified</dt><dd>${escapeHtml(profile.provenance.verifiedAt || "Not recorded")}</dd></div>
    </dl>
    <details><summary>Fidelity by aspect</summary><dl class="facts">${Object.entries(profile.provenance.aspectFidelity).map(([aspect, fidelity]) => `<div><dt>${escapeHtml(aspect)}</dt><dd>${escapeHtml(fidelity)}</dd></div>`).join("")}</dl></details>
    ${profile.provenance.knownLimitations.length > 0 ? `<details><summary>Known limitations</summary><ul>${profile.provenance.knownLimitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}
    ${links ? `<details><summary>Source documentation</summary><ul>${links}</ul></details>` : ""}
  </article>`
}

function actionForm(instanceId: string, action: string, label: string, csrfToken: string, disabled = false): string {
  return `<form method="post" action="/api/v1/instances/${encodeURIComponent(instanceId)}/actions/${encodeURIComponent(action)}">
    <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
    <button type="submit" class="button button--secondary"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>
  </form>`
}

function renderComparison(instance: LabInstanceView): string {
  const comparison = instance.lastProbe
  if (!comparison) return `<p class="muted">Run a probe to compare the configured expectation with the observed wire behavior.</p>`
  return `<div class="comparison ${comparison.matchesExpectation ? "comparison--match" : "comparison--mismatch"}" role="status">
    <p><strong>Probe mode:</strong> ${escapeHtml(comparison.mode)}</p>
    <div class="cluster cluster--between">
      <h4>${comparison.matchesExpectation ? "Expectation matched" : "Expectation did not match"}</h4>
      <span class="badge">${comparison.matchesExpectation ? "MATCH" : "INVESTIGATE"}</span>
    </div>
    <div class="diagnostic-proof-summary" aria-label="Compact diagnostic proof">
      <p><strong>Expected:</strong> ${escapeHtml(comparison.expected.outcome)} · ${escapeHtml(comparison.expected.firstFailedPhase ?? "None")} · ${escapeHtml(comparison.expected.category ?? "None")}</p>
      <p><strong>Observed:</strong> ${escapeHtml(comparison.observed.outcome)} · ${escapeHtml(comparison.observed.firstFailedPhase ?? "None")} · ${escapeHtml(comparison.observed.category ?? "None")}</p>
    </div>
    <p>${escapeHtml(comparison.summary)}</p>
    <div class="comparison-grid">
      <section><h5>Expected</h5><dl class="facts"><div><dt>Outcome</dt><dd>${escapeHtml(comparison.expected.outcome)}</dd></div><div><dt>First failed phase</dt><dd>${escapeHtml(comparison.expected.firstFailedPhase ?? "None")}</dd></div><div><dt>Category</dt><dd>${escapeHtml(comparison.expected.category ?? "None")}</dd></div></dl></section>
      <section><h5>Observed</h5><dl class="facts"><div><dt>Outcome</dt><dd>${escapeHtml(comparison.observed.outcome)}</dd></div><div><dt>First failed phase</dt><dd>${escapeHtml(comparison.observed.firstFailedPhase ?? "None")}</dd></div><div><dt>Category</dt><dd>${escapeHtml(comparison.observed.category ?? "None")}</dd></div></dl></section>
    </div>
  </div>`
}

function renderEvents(instance: LabInstanceView): string {
  if (instance.events.length === 0) return `<p class="muted">No safe events recorded yet.</p>`
  return `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Time</th><th scope="col">Phase</th><th scope="col">Event</th><th scope="col">Correlation</th></tr></thead>
    <tbody>${instance.events.slice(-20).reverse().map((event) => `<tr><td>${escapeHtml(event.at)}</td><td>${escapeHtml(event.phase ?? event.category)}</td><td>${escapeHtml(event.message)}</td><td><code>${escapeHtml(event.correlationId ?? "—")}</code></td></tr>`).join("")}</tbody>
  </table></div>`
}

function renderInstance(instance: LabInstanceView, faults: readonly LabFault[], csrfToken: string): string {
  const applicableFaults = faults.filter((fault) => fault.profileIds.length === 0 || fault.profileIds.includes(instance.profile.id))
  const stateLabel = instance.state.toUpperCase()
  return `<article class="instance-card" id="instance-${escapeHtml(instance.id)}">
    <header class="instance-header">
      <div>
        <p class="eyebrow">${escapeHtml(instance.profile.name)}</p>
        <h3>${escapeHtml(instance.displayName)}</h3>
      </div>
      <span class="status status--${escapeHtml(instance.state)}">${escapeHtml(stateLabel)}</span>
    </header>
    ${instance.lastError ? `<p class="notice notice--error" role="alert">${escapeHtml(instance.lastError)}</p>` : ""}
    <dl class="facts facts--wide">
      <div><dt>Scenario revision</dt><dd>${instance.scenarioRevision}</dd></div>
      <div><dt>Port</dt><dd>${instance.port}</dd></div>
      <div><dt>Active fault</dt><dd>${escapeHtml(instance.activeFault?.name ?? "Healthy baseline")}</dd></div>
      <div><dt>OAuth client secret</dt><dd>${instance.secretsConfigured.clientSecret ? "Configured (write-only)" : "Not configured"}</dd></div>
    </dl>
    <section class="endpoint"><h4>Exact OAuth redirect URIs (${instance.oauth.redirectUris.length})</h4><ul class="uri-list">${instance.oauth.redirectUris.map((uri) => `<li><code>${escapeHtml(uri)}</code></li>`).join("")}</ul><p class="fine-print">Authorization succeeds only when the client sends one of these exact registered values.</p></section>
    ${instance.endpoint ? `<section class="endpoint"><h4>Provider-facing connection information</h4><dl class="facts">
      <div><dt>MCP endpoint</dt><dd><code>${escapeHtml(instance.endpoint.mcpUrl)}</code></dd></div>
      <div><dt>OAuth registration</dt><dd>${escapeHtml(instance.oauth.registration)}</dd></div>
      <div><dt>OAuth client ID</dt><dd><code>${escapeHtml(instance.oauth.clientId)}</code></dd></div>
      <div><dt>Authorization server</dt><dd><code>${escapeHtml(instance.oauth.authorizationServerUrl ?? "Not exposed")}</code></dd></div>
      <div><dt>Protected-resource metadata</dt><dd><code>${escapeHtml(instance.oauth.protectedResourceMetadataUrl ?? "Not exposed")}</code></dd></div>
    </dl><p class="fine-print">The data-plane listener does not expose this admin interface. The client secret remains write-only.</p></section>` : ""}
    <div class="cluster actions" aria-label="Instance lifecycle controls">
      ${actionForm(instance.id, "start", "Start", csrfToken, instance.state !== "stopped" && instance.state !== "failed")}
      ${actionForm(instance.id, "stop", "Stop", csrfToken, instance.state !== "running")}
      ${actionForm(instance.id, "reset", "Reset", csrfToken, instance.state === "starting" || instance.state === "stopping")}
      ${actionForm(instance.id, "probe", "Run probe", csrfToken, instance.state !== "running")}
      ${actionForm(instance.id, "delete", "Delete", csrfToken, instance.state === "starting" || instance.state === "stopping")}
    </div>
    <section class="subsection" aria-labelledby="fault-${escapeHtml(instance.id)}">
      <h4 id="fault-${escapeHtml(instance.id)}">Configure the next scenario revision</h4>
      <p class="muted">One fault at a time keeps the first failure unambiguous. Existing requests finish before the new revision activates.</p>
      <form method="post" action="/api/v1/instances/${encodeURIComponent(instance.id)}/scenario" class="form-grid">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="expectedRevision" value="${instance.scenarioRevision}">
        <label for="fault-${escapeHtml(instance.id)}-select">Injected fault</label>
        <select id="fault-${escapeHtml(instance.id)}-select" name="faultId">
          <option value="">Healthy baseline</option>
          ${applicableFaults.map((fault) => `<option value="${escapeHtml(fault.id)}"${fault.id === instance.activeFault?.id ? " selected" : ""}>${escapeHtml(fault.diagnosticLevel)} · ${escapeHtml(fault.phase)} · ${escapeHtml(fault.name)}</option>`).join("")}
        </select>
        <label for="continuity-${escapeHtml(instance.id)}-select">Connection state across this revision</label>
        <select id="continuity-${escapeHtml(instance.id)}-select" name="credentialContinuity">
          <option value="preserve-compatible-oauth" selected>Preserve compatible OAuth credential; start a new MCP session</option>
          <option value="reset">Reset all OAuth and MCP connection state</option>
        </select>
        <p class="fine-print continuity-help">Use preserve mode to iterate catalog and provider-operation scenarios with the same connected Den credential. OAuth-layer faults require reset mode followed by a new Connect.</p>
        <button type="submit">Apply new revision</button>
      </form>
      ${instance.activeFault ? `<div class="fault-explainer"><strong>Diagnostic level:</strong> ${escapeHtml(instance.activeFault.diagnosticLevel)}<br><strong>Expected first failure:</strong> ${escapeHtml(instance.activeFault.expectedFirstFailedPhase)} · ${escapeHtml(instance.activeFault.expectedCategory)}<br>${escapeHtml(instance.activeFault.description)}</div>` : ""}
    </section>
    <section class="subsection comparison-section"><h4>Expected versus observed</h4><p class="muted"><strong>Configured scenario:</strong> ${escapeHtml(instance.activeFault?.name ?? "Healthy baseline")}</p>${renderComparison(instance)}</section>
    <section class="subsection"><h4>Safe event timeline</h4><p class="fine-print">Bodies, authorization codes, tokens, client secrets and tool arguments are intentionally excluded.</p>${renderEvents(instance)}</section>
  </article>`
}

export interface DashboardInput {
  csrfToken: string
  faults: readonly LabFault[]
  flash?: { kind: "error" | "success"; message: string }
  instances: readonly LabInstanceView[]
  profiles: readonly LabProfile[]
}

export function renderDashboard(input: DashboardInput): string {
  const defaultPort = input.instances.reduce((highest, instance) => Math.max(highest, instance.port), 21079) + 1
  return page(
    "Admin",
    `<header class="site-header">
      <div><p class="eyebrow">Private loopback control plane</p><h1>Enterprise Mock Lab</h1></div>
      <form method="post" action="/session/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}"><button class="button button--secondary" type="submit">Sign out</button></form>
    </header>
    <main id="main-content" class="page-shell">
      ${input.flash ? `<p class="notice notice--${input.flash.kind}" role="status">${escapeHtml(input.flash.message)}</p>` : ""}
      <section aria-labelledby="new-instance-title" class="panel">
        <p class="eyebrow">New isolated data plane</p>
        <h2 id="new-instance-title">Create an enterprise MCP simulation</h2>
        <form method="post" action="/api/v1/instances" class="form-grid form-grid--create">
          <input type="hidden" name="csrfToken" value="${escapeHtml(input.csrfToken)}">
          <label for="display-name">Instance name</label><input id="display-name" name="displayName" value="ServiceNow development scenario" maxlength="80" required>
          <label for="profile-id">Provider profile</label><select id="profile-id" name="profileId" required>${input.profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === "servicenow-inbound-quickstart" ? " selected" : ""}>${escapeHtml(profile.name)} · ${escapeHtml(profile.provenance.fidelity)}</option>`).join("")}</select>
          <label for="port">Data-plane port</label><input id="port" name="port" type="number" min="1024" max="65535" value="${defaultPort}" required>
          <label for="initial-fault">Initial fault</label><select id="initial-fault" name="faultId"><option value="">Healthy baseline</option>${input.faults.map((fault) => `<option value="${escapeHtml(fault.id)}">${escapeHtml(fault.diagnosticLevel)} · ${escapeHtml(fault.phase)} · ${escapeHtml(fault.name)}</option>`).join("")}</select>
          <label for="redirect-uris">Exact OAuth redirect URIs</label><div><textarea id="redirect-uris" name="redirectUris" rows="3" required spellcheck="false">http://127.0.0.1:19876/mcp/oauth/callback</textarea><p class="fine-print">One exact URI per line, up to 10. For a pre-registered Den client, replace the example with the callback shown by Den before you connect.</p></div>
          <fieldset class="secret-fields"><legend>Synthetic provider credentials (write-only)</legend>
            <label for="client-id">OAuth client ID</label><input id="client-id" name="clientId" autocomplete="off" spellcheck="false">
            <label for="client-secret">OAuth client secret (profile-dependent)</label><input id="client-secret" name="clientSecret" type="password" minlength="12" autocomplete="new-password">
            <p class="fine-print">Required for confidential-client profiles such as ServiceNow and Microsoft Enterprise; leave blank for public-client Work IQ and Agent 365 profiles. It is accepted once, kept only in this process and represented afterward by a configured/not configured boolean.</p>
          </fieldset>
          <button type="submit">Create stopped instance</button>
        </form>
      </section>
      <section aria-labelledby="profiles-title">
        <h2 id="profiles-title">Profile provenance</h2>
        <p>Every profile states what is provider-documented, what was verified, and what remains synthetic.</p>
        <div class="card-grid">${input.profiles.map(renderProfile).join("")}</div>
      </section>
      <section aria-labelledby="instances-title">
        <h2 id="instances-title">Mock instances</h2>
        ${input.instances.length === 0 ? `<div class="empty-state"><h3>No instances yet</h3><p>Create one above. It remains stopped until you explicitly start it.</p></div>` : `<div class="instance-list">${input.instances.map((instance) => renderInstance(instance, input.faults, input.csrfToken)).join("")}</div>`}
      </section>
    </main>`,
  )
}

export const applicationCss = `
:root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #182028; background: #f4f7f5; line-height: 1.5; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
a { color: #075e54; }
button, input, select, textarea { font: inherit; }
button, .button { border: 0; border-radius: .55rem; padding: .68rem 1rem; background: #08766a; color: #fff; font-weight: 700; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
.button--secondary { color: #25303a; background: #e6ece9; }
input, select, textarea { width: 100%; border: 1px solid #aebbb6; border-radius: .45rem; padding: .65rem .75rem; background: #fff; color: #182028; }
textarea { resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus, a:focus { outline: 3px solid #63c9bb; outline-offset: 2px; }
.skip-link { position: fixed; left: 1rem; top: -6rem; z-index: 20; background: #fff; padding: .75rem; }
.skip-link:focus { top: 1rem; }
.site-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1.1rem max(1rem, calc((100vw - 1180px) / 2)); color: #fff; background: #152e2b; }
.site-header h1, .site-header p { margin: 0; }
.page-shell { width: min(1180px, calc(100% - 2rem)); margin: 2rem auto 5rem; display: grid; gap: 2.5rem; }
.panel, .instance-card, .profile-card, .empty-state, .login-card { border: 1px solid #cfdbd7; border-radius: .85rem; background: #fff; box-shadow: 0 8px 30px rgba(17, 52, 47, .06); }
.panel, .instance-card { padding: clamp(1rem, 3vw, 2rem); }
.profile-card, .empty-state { padding: 1.25rem; }
.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 1rem; background: radial-gradient(circle at top, #d8eee9, #f4f7f5 55%); }
.login-card { width: min(31rem, 100%); padding: 2rem; }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .76rem; font-weight: 800; color: #36736b; }
.site-header .eyebrow { color: #92d6cc; }
.stack { display: grid; gap: .65rem; }
.form-grid { display: grid; grid-template-columns: minmax(10rem, .45fr) minmax(14rem, 1fr); gap: .85rem 1.2rem; align-items: center; }
.form-grid > button, .form-grid > fieldset { grid-column: 2; }
.form-grid > .continuity-help { grid-column: 2; margin: 0; }
.secret-fields { display: grid; grid-template-columns: minmax(10rem, .45fr) minmax(12rem, 1fr); gap: .75rem; margin: .5rem 0; padding: 1rem; border: 1px solid #d7dfdc; border-radius: .6rem; }
.secret-fields legend { font-weight: 700; }
.secret-fields .fine-print { grid-column: 1 / -1; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); gap: 1rem; }
.cluster { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; }
.cluster--between { justify-content: space-between; }
.badge, .status { display: inline-flex; border-radius: 99rem; padding: .22rem .55rem; font-size: .72rem; font-weight: 800; letter-spacing: .04em; background: #dbece8; color: #154b44; }
.status--running { background: #d8f1de; color: #185d29; }
.status--failed { background: #fbe0de; color: #82261f; }
.status--starting, .status--stopping { background: #fff0c7; color: #6b4c00; }
.instance-list { display: grid; gap: 1.25rem; }
.instance-header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
.instance-header h3, .instance-header p { margin: 0; }
.facts { display: grid; gap: .45rem; margin: 1rem 0; }
.facts--wide { grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
.facts div { min-width: 0; }
.facts dt { color: #60706b; font-size: .78rem; font-weight: 700; }
.facts dd { margin: .1rem 0 0; overflow-wrap: anywhere; }
.endpoint, .fault-explainer, .comparison { margin: 1rem 0; padding: .9rem 1rem; border-radius: .55rem; background: #eef5f3; overflow-wrap: anywhere; }
.comparison--mismatch { background: #fff0e5; }
.diagnostic-proof-summary { padding: .5rem .65rem; border: 1px solid #c7dad5; border-radius: .4rem; background: rgba(255,255,255,.48); }
.diagnostic-proof-summary p { margin: .15rem 0; overflow-wrap: anywhere; }
.comparison-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.subsection { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid #dce4e1; }
.actions { margin: 1rem 0; }
.notice { padding: .8rem 1rem; border-radius: .55rem; background: #e3f1ee; }
.notice--error { color: #721c16; background: #fae3e1; }
.notice--success { color: #185d29; background: #dcf2e1; }
.muted, .fine-print { color: #60706b; }
.fine-print { font-size: .82rem; }
.table-scroll { max-width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .88rem; }
th, td { padding: .6rem; border-bottom: 1px solid #dce4e1; text-align: left; vertical-align: top; }
code { overflow-wrap: anywhere; }
.uri-list { margin: .25rem 0 0; padding-left: 1.25rem; }
@media (max-width: 680px) { .site-header, .instance-header { align-items: stretch; flex-direction: column; } .form-grid, .secret-fields, .comparison-grid { grid-template-columns: 1fr; } .form-grid > button, .form-grid > fieldset, .form-grid > .continuity-help, .secret-fields .fine-print { grid-column: 1; } .actions { align-items: stretch; flex-direction: column; } .actions form, .actions button { width: 100%; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
@media (prefers-color-scheme: dark) { :root { color: #e8efed; background: #101817; } .panel, .instance-card, .profile-card, .empty-state, .login-card { color: #e8efed; background: #172320; border-color: #354944; } input, select, textarea { color: #eef5f3; background: #101817; border-color: #4a625c; } .login-shell { background: #101817; } .button--secondary { color: #e8efed; background: #354944; } .endpoint, .fault-explainer, .comparison { background: #20332f; } .comparison--mismatch { background: #4a3024; } .muted, .fine-print, .facts dt { color: #aebdb9; } }
`
