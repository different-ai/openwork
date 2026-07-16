function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true
  const octets = normalized.split(".")
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
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

export function mcpAuthorizationPendingDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Connecting — OpenWork</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; color: #182033; background: #f7f7f4; }
      .card { width: min(100%, 440px); padding: 48px 40px; text-align: center; background: rgba(255, 255, 255, .9); border: 1px solid #e6e7e2; border-radius: 28px; box-shadow: 0 22px 70px rgba(24, 32, 51, .09); }
      .mark { position: relative; width: 64px; height: 64px; margin: 0 auto 28px; display: grid; place-items: center; }
      .core { width: 34px; height: 34px; border-radius: 12px; background: #182033; box-shadow: inset 0 0 0 7px #fff; }
      .orbit { position: absolute; inset: 0; border: 2px solid #dfe3da; border-top-color: #76966f; border-radius: 50%; animation: connect 1.15s cubic-bezier(.55, .15, .45, .85) infinite; }
      h1 { margin: 0; font-size: 25px; line-height: 1.2; letter-spacing: -.025em; }
      p { max-width: 330px; margin: 14px auto 0; color: #667085; font-size: 15px; line-height: 1.6; }
      @keyframes connect { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .orbit { animation: none; border-color: #76966f; } }
    </style>
  </head>
  <body>
    <main class="card" role="status" aria-live="polite">
      <div class="mark" aria-hidden="true"><div class="orbit"></div><div class="core"></div></div>
      <h1>Preparing your connection</h1>
      <p>OpenWork is checking the provider. You’ll be redirected to sign in shortly.</p>
    </main>
  </body>
</html>`
}

export function openMcpAuthorizationWindow(): Window {
  const popup = window.open("", "openwork-mcp-authorization", "popup,width=600,height=760")
  if (!popup) {
    throw new Error("OpenWork could not open the sign-in window. Allow popups for OpenWork, then try again.")
  }
  popup.opener = null
  popup.document.open()
  popup.document.write(mcpAuthorizationPendingDocument())
  popup.document.close()
  return popup
}
