function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true
  const octets = normalized.split(".")
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function safeMcpAuthorizationUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("The MCP provider returned an invalid authorization URL.")
  }
  const allowedProtocol = url.protocol === "https:"
    || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  if (!allowedProtocol || url.username || url.password) {
    throw new Error("The MCP provider returned an unsafe authorization URL.")
  }
  return url.toString()
}

export type McpAuthorizationDebugDetails = {
  httpStatus: number
  errorCode?: string
  redirectUri?: string
  clientMetadataUrl?: string
  diagnosticReference?: string
  phase?: string
  category?: string
  highestPassed?: string
  retryable?: boolean
  actionOwner?: string
  operatorAction?: string
  providerStatus?: number
  providerRequestId?: string
  providerCode?: string
  responseJson: string
}

const authorizationDocumentStyles = `
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { position: relative; min-height: 100vh; margin: 0; display: grid; place-items: center; overflow-x: hidden; padding: 32px; color: #101828; background: #f8fbff; }
      body::before { position: fixed; inset: 0; z-index: -1; content: ""; background-image: radial-gradient(circle, #8fb7e8 1px, transparent 1.2px); background-position: 0 0; background-size: 18px 18px; opacity: .12; mask-image: radial-gradient(ellipse at center, black, transparent 78%); }
      .card { width: min(100%, 960px); overflow: hidden; border: 1px solid #e7eaef; border-radius: 32px; background: rgba(252, 252, 253, .97); box-shadow: 0 18px 60px rgba(16, 24, 40, .06); }
      .brand { display: inline-flex; align-items: center; gap: 9px; color: #667085; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      .brand-mark { width: 27px; height: 27px; display: grid; place-items: center; border: 1px solid #d0d5dd; border-radius: 9px; color: #344054; background: #fff; font-size: 10px; letter-spacing: -.03em; }
      h1 { max-width: 16ch; margin: 0 auto; color: #101828; font-size: clamp(34px, 5vw, 56px); line-height: 1.05; letter-spacing: -.045em; }
      p { margin: 20px 0 0; color: #667085; font-size: 17px; line-height: 1.6; }
      @media (max-width: 560px) { body { padding: 16px; } .card { border-radius: 24px; } }
`

export function mcpAuthorizationPendingDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Connecting — OpenWork</title>
    <style>
${authorizationDocumentStyles}
      .connect-card { padding: clamp(34px, 7vw, 76px); text-align: center; }
      .brand { margin-bottom: 20px; }
      .status-row { max-width: 720px; margin: 42px auto 0; display: flex; align-items: center; gap: 16px; padding: 22px 24px; text-align: left; border: 1px solid #e1e4e8; border-radius: 18px; background: #fff; }
      .status-number { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border: 1.5px solid #101828; border-radius: 50%; color: #101828; background: #fff; font-size: 13px; font-weight: 700; }
      .status-copy { min-width: 0; display: grid; gap: 3px; }
      .status-copy strong { color: #101828; font-size: 17px; line-height: 1.35; }
      .status-copy small { color: #667085; font-size: 14px; line-height: 1.5; }
      @media (max-width: 560px) { .connect-card { padding: 32px 22px; } .status-row { margin-top: 30px; padding: 18px; } }
    </style>
  </head>
  <body>
    <main class="card connect-card" role="status" aria-live="polite">
      <div class="brand"><span class="brand-mark">OW</span>OpenWork Connect</div>
      <h1>Connect your account</h1>
      <p>OpenWork is preparing the secure provider sign-in.</p>
      <div class="status-row">
        <span class="status-number" aria-hidden="true">1</span>
        <span class="status-copy"><strong>Continue to your provider</strong><small>Keep this window open while we redirect you.</small></span>
      </div>
    </main>
  </body>
</html>`
}

function debugDetailRow(label: string, value: string | number | boolean | undefined, code = false): string {
  if (value === undefined) return ""
  const renderedValue = escapeHtml(String(value))
  return `<div class="detail-row">
              <dt>${escapeHtml(label)}</dt>
              <dd${code ? ' class="mono"' : ""}>${renderedValue}</dd>
            </div>`
}

function technicalDetails(details: McpAuthorizationDebugDetails | undefined): string {
  if (!details) return ""
  const rows = [
    debugDetailRow("HTTP status", details.httpStatus),
    debugDetailRow("Error code", details.errorCode, true),
    debugDetailRow("Diagnostic reference", details.diagnosticReference, true),
    debugDetailRow("Redirect URI", details.redirectUri, true),
    debugDetailRow("Client metadata URL", details.clientMetadataUrl, true),
    debugDetailRow("Handshake phase", details.phase, true),
    debugDetailRow("Highest step passed", details.highestPassed),
    debugDetailRow("Category", details.category, true),
    debugDetailRow("Retryable", details.retryable),
    debugDetailRow("Action owner", details.actionOwner),
    debugDetailRow("Recommended action", details.operatorAction),
    debugDetailRow("Provider status", details.providerStatus),
    debugDetailRow("Provider request ID", details.providerRequestId, true),
    debugDetailRow("Provider code", details.providerCode, true),
  ].join("")

  return `<details>
          <summary>
            <span class="summary-icon" aria-hidden="true">›</span>
            <span><strong>Technical details</strong><small>Redirect, status, and safe error response</small></span>
          </summary>
          <div class="details-content">
            <dl>${rows}</dl>
            <section aria-labelledby="response-payload-label">
              <h2 id="response-payload-label">Response payload</h2>
              <pre><code>${escapeHtml(details.responseJson)}</code></pre>
            </section>
          </div>
        </details>`
}

export function mcpAuthorizationErrorDocument(input: {
  message: string
  details?: McpAuthorizationDebugDetails
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Connection failed — OpenWork</title>
    <style>
${authorizationDocumentStyles}
      .error-card { margin: auto; }
      .error-header { padding: clamp(34px, 7vw, 76px); text-align: center; }
      .brand { margin-bottom: 20px; }
      .status { display: block; }
      .status p { margin-top: 20px; }
      .message { max-width: 720px; margin: 42px auto 0; padding: 22px 24px; border: 1px solid #f1c9c5; border-radius: 18px; color: #7a271a; background: #fffafa; font-size: 14px; line-height: 1.55; text-align: left; }
      .stay-open { display: flex; justify-content: center; gap: 9px; margin-top: 18px; color: #667085; font-size: 13px; line-height: 1.5; }
      .stay-open span { flex: 0 0 auto; width: 18px; height: 18px; display: grid; place-items: center; margin-top: 1px; border: 1px solid #d0d5dd; border-radius: 50%; color: #667085; background: #fff; font-size: 12px; font-weight: 800; }
      details { border-top: 1px solid #e7eaef; background: #fafbfc; }
      summary { display: flex; align-items: center; gap: 12px; padding: 20px clamp(24px, 6vw, 68px); cursor: pointer; color: #344054; list-style: none; user-select: none; }
      summary::-webkit-details-marker { display: none; }
      summary:focus-visible { outline: 3px solid rgba(59, 130, 246, .22); outline-offset: -3px; }
      summary strong, summary small { display: block; }
      summary strong { font-size: 14px; }
      summary small { margin-top: 2px; color: #98a2b3; font-size: 12px; font-weight: 400; }
      .summary-icon { width: 25px; height: 25px; display: grid; place-items: center; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; font-size: 22px; line-height: 1; transition: transform .16s ease; }
      details[open] .summary-icon { transform: rotate(90deg); }
      .details-content { padding: 0 clamp(24px, 6vw, 68px) clamp(28px, 6vw, 56px); }
      dl { margin: 0; overflow: hidden; border: 1px solid #e1e4e8; border-radius: 14px; background: #fff; }
      .detail-row { display: grid; grid-template-columns: minmax(118px, .7fr) minmax(0, 1.3fr); gap: 16px; padding: 11px 13px; border-bottom: 1px solid #eef0f2; font-size: 12px; line-height: 1.45; }
      .detail-row:last-child { border-bottom: 0; }
      dt { color: #667085; }
      dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #344054; font-weight: 600; user-select: all; }
      .mono { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      section { margin-top: 18px; }
      h2 { margin: 0 0 8px; color: #667085; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
      pre { max-height: 240px; margin: 0; overflow: auto; padding: 13px; border: 1px solid #e1e4e8; border-radius: 12px; color: #344054; background: #f7f8fa; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; }
      pre code { font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
      @media (max-width: 560px) { .error-header { padding: 32px 22px; } .message { margin-top: 30px; padding: 18px; } .detail-row { grid-template-columns: 1fr; gap: 3px; } }
      @media (prefers-reduced-motion: reduce) { .summary-icon { transition: none; } }
    </style>
  </head>
  <body>
    <main class="card error-card" role="alert" aria-live="assertive">
      <div class="error-header">
        <div class="brand"><span class="brand-mark">OW</span>OpenWork Connect</div>
        <div class="status">
          <h1>Connection failed</h1>
          <p>OpenWork couldn’t start the provider sign-in.</p>
        </div>
        <div class="message">${escapeHtml(input.message)}</div>
        <div class="stay-open"><span aria-hidden="true">i</span><div>This window will stay open so you can inspect and copy the details below.</div></div>
      </div>
      ${technicalDetails(input.details)}
    </main>
  </body>
</html>`
}

export function showMcpAuthorizationError(
  popup: Window | null,
  input: { message: string; details?: McpAuthorizationDebugDetails },
): void {
  if (!popup || popup.closed) return
  try {
    popup.document.open()
    popup.document.write(mcpAuthorizationErrorDocument(input))
    popup.document.close()
  } catch {
    // If browser isolation made the document inaccessible, leave the popup
    // open so the browser/provider error remains available for diagnosis.
  }
}

export function openMcpAuthorizationWindow(): Window {
  const popupName = `openwork-mcp-authorization-${crypto.randomUUID()}`
  const popup = window.open("", popupName, "popup,width=960,height=720")
  if (!popup) {
    throw new Error("OpenWork could not open the sign-in window. Allow popups for OpenWork, then try again.")
  }
  try {
    popup.opener = null
    popup.document.open()
    popup.document.write(mcpAuthorizationPendingDocument())
    popup.document.close()
  } catch {
    // Browsers may disown or isolate a newly opened named window before its
    // document becomes writable. The authorization redirect can still reuse
    // this unique popup, so do not convert that browser hardening into a
    // failed OAuth start.
  }
  return popup
}
