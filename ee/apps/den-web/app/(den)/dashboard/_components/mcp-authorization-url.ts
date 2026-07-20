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
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 28px; color: #172033; background: radial-gradient(circle at 14% 8%, rgba(122, 156, 114, .15), transparent 35%), radial-gradient(circle at 92% 92%, rgba(100, 116, 139, .11), transparent 38%), #f5f6f2; }
      .card { position: relative; width: min(100%, 480px); overflow: hidden; background: rgba(255, 255, 255, .94); border: 1px solid rgba(216, 220, 211, .92); border-radius: 28px; box-shadow: 0 24px 80px rgba(24, 32, 51, .12), 0 2px 8px rgba(24, 32, 51, .04); }
      .card::before { position: absolute; inset: 0 0 auto; height: 4px; content: ""; background: linear-gradient(90deg, #90ad87, #c9d8c2 50%, #90ad87); }
      .brand { display: inline-flex; align-items: center; gap: 9px; color: #475467; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      .brand-mark { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 8px; color: #fff; background: #172033; box-shadow: 0 4px 12px rgba(23, 32, 51, .18); font-size: 11px; letter-spacing: -.03em; }
      h1 { margin: 0; color: #172033; font-size: 26px; line-height: 1.2; letter-spacing: -.03em; }
      p { margin: 12px 0 0; color: #667085; font-size: 15px; line-height: 1.6; }
      @media (max-width: 480px) { body { padding: 16px; } }
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
      .loading-card { padding: 40px 40px 34px; text-align: center; }
      .brand { margin-bottom: 34px; }
      .mark { position: relative; width: 82px; height: 82px; margin: 0 auto 28px; display: grid; place-items: center; }
      .mark::before { position: absolute; inset: 10px; content: ""; border-radius: 24px; background: #f0f4ed; transform: rotate(8deg); }
      .core { position: relative; width: 38px; height: 38px; display: grid; place-items: center; border-radius: 13px; color: #fff; background: #172033; box-shadow: 0 8px 22px rgba(23, 32, 51, .22); font-size: 12px; font-weight: 800; }
      .orbit { position: absolute; inset: 0; border: 2px solid rgba(128, 157, 120, .18); border-top-color: #76966f; border-right-color: #9db894; border-radius: 50%; animation: connect 1.15s cubic-bezier(.55, .15, .45, .85) infinite; }
      .progress { height: 5px; margin: 30px 0 0; overflow: hidden; border-radius: 999px; background: #eef0eb; }
      .progress span { display: block; width: 42%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #64845d, #a8c29f); animation: progress 1.4s ease-in-out infinite alternate; }
      .footnote { display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 16px; color: #98a2b3; font-size: 12px; }
      .footnote-dot { width: 6px; height: 6px; border-radius: 50%; background: #76966f; box-shadow: 0 0 0 4px rgba(118, 150, 111, .12); }
      @keyframes connect { to { transform: rotate(360deg); } }
      @keyframes progress { from { transform: translateX(-15%); } to { transform: translateX(155%); } }
      @media (prefers-reduced-motion: reduce) { .orbit, .progress span { animation: none; } .orbit { border-color: #76966f; } .progress span { width: 100%; } }
    </style>
  </head>
  <body>
    <main class="card loading-card" role="status" aria-live="polite">
      <div class="brand"><span class="brand-mark">OW</span>OpenWork Connect</div>
      <div class="mark" aria-hidden="true"><div class="orbit"></div><div class="core">OW</div></div>
      <h1>Preparing your connection</h1>
      <p>OpenWork is securely checking the provider and preparing your sign-in.</p>
      <div class="progress" aria-hidden="true"><span></span></div>
      <div class="footnote"><span class="footnote-dot" aria-hidden="true"></span>Keep this window open</div>
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
      body { align-items: start; }
      .error-card { width: min(100%, 520px); margin: auto; }
      .error-header { padding: 30px 34px 28px; }
      .brand { margin-bottom: 30px; }
      .status { display: flex; align-items: flex-start; gap: 16px; }
      .error-mark { flex: 0 0 auto; width: 48px; height: 48px; display: grid; place-items: center; border: 1px solid #fecdca; border-radius: 15px; color: #b42318; background: linear-gradient(145deg, #fff7f6, #feeceb); box-shadow: 0 7px 20px rgba(180, 35, 24, .09); font-size: 23px; font-weight: 800; }
      .message { margin-top: 24px; padding: 15px 16px; border: 1px solid #fecdca; border-radius: 14px; color: #7a271a; background: #fff7f6; font-size: 14px; line-height: 1.55; }
      .stay-open { display: flex; gap: 9px; margin-top: 18px; color: #667085; font-size: 13px; line-height: 1.5; }
      .stay-open span { flex: 0 0 auto; width: 18px; height: 18px; display: grid; place-items: center; margin-top: 1px; border-radius: 50%; color: #52704c; background: #eaf2e7; font-size: 12px; font-weight: 800; }
      details { border-top: 1px solid #e7e9e3; background: #fafbf8; }
      summary { display: flex; align-items: center; gap: 12px; padding: 19px 34px; cursor: pointer; color: #344054; list-style: none; user-select: none; }
      summary::-webkit-details-marker { display: none; }
      summary:focus-visible { outline: 3px solid rgba(118, 150, 111, .3); outline-offset: -3px; }
      summary strong, summary small { display: block; }
      summary strong { font-size: 14px; }
      summary small { margin-top: 2px; color: #98a2b3; font-size: 12px; font-weight: 400; }
      .summary-icon { width: 25px; height: 25px; display: grid; place-items: center; border: 1px solid #dfe3da; border-radius: 8px; background: #fff; font-size: 22px; line-height: 1; transition: transform .16s ease; }
      details[open] .summary-icon { transform: rotate(90deg); }
      .details-content { padding: 0 34px 30px; }
      dl { margin: 0; overflow: hidden; border: 1px solid #e2e5de; border-radius: 14px; background: #fff; }
      .detail-row { display: grid; grid-template-columns: minmax(118px, .7fr) minmax(0, 1.3fr); gap: 16px; padding: 11px 13px; border-bottom: 1px solid #eef0eb; font-size: 12px; line-height: 1.45; }
      .detail-row:last-child { border-bottom: 0; }
      dt { color: #667085; }
      dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #344054; font-weight: 600; user-select: all; }
      .mono { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      section { margin-top: 18px; }
      h2 { margin: 0 0 8px; color: #667085; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
      pre { max-height: 240px; margin: 0; overflow: auto; padding: 13px; border: 1px solid #e2e5de; border-radius: 12px; color: #344054; background: #f4f6f2; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; }
      pre code { font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
      @media (max-width: 480px) { .error-header { padding: 26px 24px 24px; } summary { padding: 18px 24px; } .details-content { padding: 0 24px 24px; } .detail-row { grid-template-columns: 1fr; gap: 3px; } }
      @media (prefers-reduced-motion: reduce) { .summary-icon { transition: none; } }
    </style>
  </head>
  <body>
    <main class="card error-card" role="alert" aria-live="assertive">
      <div class="error-header">
        <div class="brand"><span class="brand-mark">OW</span>OpenWork Connect</div>
        <div class="status">
          <div class="error-mark" aria-hidden="true">!</div>
          <div>
            <h1>Connection failed</h1>
            <p>OpenWork couldn’t start the provider sign-in.</p>
          </div>
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
  const popup = window.open("", popupName, "popup,width=600,height=760")
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
