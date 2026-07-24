import { diagnosticsConfig, validateProductionConfig } from "../../../src/config"
import { authorizeMockSubject, verifyMockAuthorizationChallenge } from "../../../src/mock-authorization"

export const dynamic = "force-dynamic"
export const maxDuration = 10

function html(status: number, title: string, message: string): Response {
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
    status,
  })
}

export async function GET(request: Request): Promise<Response> {
  const missing = validateProductionConfig()
  if (missing.length > 0) return html(503, "Diagnostics unavailable", "The diagnostics service is not configured.")
  const config = diagnosticsConfig()
  const challenge = new URL(request.url).searchParams.get("challenge") ?? ""
  const subject = verifyMockAuthorizationChallenge(challenge, config.signingSecret)
  if (!subject) return html(400, "Verification link expired", "Return to OpenWork and run the diagnostics authorization check again to receive a fresh link.")
  try {
    await authorizeMockSubject(subject)
  } catch {
    return html(503, "Verification unavailable", "The diagnostics authorization store is unavailable. Try again later.")
  }
  return html(200, "Diagnostics authorization complete", "Return to OpenWork and ask the agent to retry the diagnostics authorization check. This mock authorization resets automatically after five minutes.")
}
