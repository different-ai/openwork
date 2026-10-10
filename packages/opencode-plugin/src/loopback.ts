/**
 * The page the browser returns to after the member approves (or denies) the
 * sign-in on Den web. It carries no secret: the token only ever arrives by
 * polling Den. Hitting it just ends the poll wait early and shows a "go back
 * to OpenCode" page.
 */
import { createServer, type Server } from "node:http"

export type ReturnResult = "approved" | "denied"

export interface ReturnPage {
  /** http://127.0.0.1:<port>/openwork/callback */
  readonly url: string
  close(): void
}

const CALLBACK_PATH = "/openwork/callback"

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

export function returnPageHtml(result: ReturnResult | null): string {
  const title = result === "approved"
    ? "OpenCode is connected to OpenWork"
    : result === "denied"
      ? "Sign-in cancelled"
      : "Finish signing in"
  const line = result === "approved"
    ? "You can close this tab and go back to OpenCode."
    : result === "denied"
      ? "OpenCode did not get access. You can close this tab."
      : "Approve the sign-in on the OpenWork page, then come back to OpenCode."
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 420px; padding: 32px; text-align: center; }
  h1 { font-size: 20px; line-height: 28px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; opacity: 0.72; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(line)}</p>
</main>
</body>
</html>`
}

/** Starts the return page on an ephemeral loopback port. `onResult` runs once per hit. */
export async function startReturnPage(onResult: (result: ReturnResult) => void): Promise<ReturnPage> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found")
      return
    }
    const raw = url.searchParams.get("result")
    const result: ReturnResult | null = raw === "approved" || raw === "denied" ? raw : null
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
      })
      .end(returnPageHtml(result))
    if (result) onResult(result)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  // Never keep OpenCode alive just for this page.
  server.unref()
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  let closed = false
  return {
    url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    close() {
      if (closed) return
      closed = true
      server.close()
      server.closeAllConnections?.()
    },
  }
}
