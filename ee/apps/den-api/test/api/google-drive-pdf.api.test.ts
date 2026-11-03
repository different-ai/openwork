import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, startFakeHttpServer, summary, text } from "./harness.js"
import { buildPdf } from "../fixtures/pdf.js"

// A few-hundred-KB PDF (embedded images make ordinary PDFs this size): well over the 64 KB binary limit.
function padTo(bytes: Uint8Array, size: number): Uint8Array {
  const padded = new Uint8Array(size)
  const comment = new TextEncoder().encode(`%${" ".repeat(size - bytes.byteLength - 2)}\n`)
  // A leading comment after the header keeps the PDF valid; pdf.js then recovers object offsets.
  const header = bytes.indexOf(0x0a) + 1
  padded.set(bytes.subarray(0, header), 0)
  padded.set(comment, header)
  padded.set(bytes.subarray(header), header + comment.byteLength)
  return padded
}

const textPdf = padTo(buildPdf([["Work breakdown", "Phase 1: discovery (2 weeks)"], ["Phase 2: rollout (3 weeks)"]]), 415 * 1024)
const scannedPdf = padTo(buildPdf([[]]), 200 * 1024)
const files: Record<string, { mimeType: string; size: number; bytes: Uint8Array | null }> = {
  breakdown_pdf: { mimeType: "application/pdf", size: textPdf.byteLength, bytes: textPdf },
  scanned_pdf: { mimeType: "application/pdf", size: scannedPdf.byteLength, bytes: scannedPdf },
  huge_pdf: { mimeType: "application/pdf", size: 51 * 1024 * 1024, bytes: null },
}
const downloads: string[] = []

const provider = await startFakeHttpServer(async (request, body, response) => {
  const target = new URL(request.url ?? "/", "http://fixture.test")
  response.setHeader("content-type", "application/json")
  if (target.pathname === "/token") {
    const code = new URLSearchParams(body).get("code") ?? "unknown"
    return void response.end(JSON.stringify({ access_token: code, refresh_token: `refresh_${code}`, expires_in: 3600, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly" }))
  }
  if (target.pathname === "/userinfo") return void response.end(JSON.stringify({ sub: "drive_reader", email: "connected@example.test", name: "Connected Person" }))
  const match = /^\/drive\/v3\/files\/([a-z_]+)$/.exec(target.pathname)
  const file = match ? files[match[1]!] : undefined
  if (match && file) {
    if (target.searchParams.get("alt") === "media") {
      downloads.push(match[1]!)
      if (!file.bytes) throw new Error("an oversized PDF must not be downloaded")
      response.setHeader("content-type", file.mimeType)
      return void response.end(Buffer.from(file.bytes))
    }
    return void response.end(JSON.stringify({ id: match[1], name: "Work breakdown.pdf", mimeType: file.mimeType, modifiedTime: "2026-11-02T00:00:00Z", webViewLink: `https://drive.google.com/file/d/${match[1]}/view`, size: String(file.size) }))
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: "Not found" } }))
})
const den = await bootDen({ env: {
  DEN_GOOGLE_API_BASE_URL: provider.url,
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`,
  DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`,
  DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo`,
} })
after(async () => { await den.close(); await provider.close() })

test("an agent reads the text of a few-hundred-KB PDF in Drive once googleDrivePdfText is on", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Alex Example"), "Drive PDFs")
  const call = den.as(owner, orgId)
  const configured = await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["driveRead"] })
  assert.equal(configured.status, 200, summary(configured))
  const started = await call("GET", "/v1/oauth-providers/google-workspace/connect/start")
  assert.equal(started.status, 200, summary(started))
  const authorization = new URL(text(field(started.body, "authorizeUrl"), "authorization URL"))
  const callback = new URL(text(authorization.searchParams.get("redirect_uri"), "redirect URI"))
  callback.searchParams.set("state", text(authorization.searchParams.get("state"), "OAuth state"))
  callback.searchParams.set("code", "owner_account")
  assert.equal((await den.request(null, "GET", callback.pathname + callback.search)).status, 200)
  const read = (fileId: string) => call("GET", `/v1/capabilities/google-workspace/drive-file/${fileId}`)

  // Off: the old behavior, a ~415 KB PDF is "too large" and nothing is downloaded.
  const before = await read("breakdown_pdf")
  assert.equal(before.status, 200, summary(before))
  assert.equal(field(before.body, "file", "contentUnavailableReason"), "file_too_large")
  assert.equal(downloads.length, 0)

  assert.equal((await den.setFeature(orgId, "googleDrivePdfText", true)).status, 200)
  const enabled = await read("breakdown_pdf")
  assert.equal(enabled.status, 200, summary(enabled))
  assert.equal(field(enabled.body, "file", "encoding"), "text")
  assert.equal(field(enabled.body, "file", "contentBase64"), null)
  assert.equal(field(enabled.body, "file", "truncated"), false)
  assert.equal(field(enabled.body, "file", "contentUnavailableReason"), null)
  const content = text(field(enabled.body, "file", "content"), "PDF text")
  assert.match(content, /Phase 1: discovery \(2 weeks\)/)
  assert.match(content, /Phase 2: rollout \(3 weeks\)/)
  assert.deepEqual(downloads, ["breakdown_pdf"])

  // The MCP gateway hands the agent the same text.
  const token = await den.mintMcpToken(owner, orgId)
  const discovered = await den.callMcpTool(token, "search_capabilities", { query: "read Google Drive file content", limit: 20 })
  const capability = "native:google-workspace:getCapabilitiesGoogleWorkspaceDriveFile"
  assert.ok(discovered.raw.includes(capability), discovered.raw.slice(0, 1000))
  const viaMcp = await den.callMcpTool(token, "execute_capability", { name: capability, path: { fileId: "breakdown_pdf" } })
  assert.equal(viaMcp.isError, false, viaMcp.text)
  assert.ok(viaMcp.text.includes("Phase 2: rollout (3 weeks)"), viaMcp.text.slice(0, 1000))

  // A scan has no text layer, and a PDF over 50 MB is not downloaded at all; both say what to do instead.
  const scanned = await read("scanned_pdf")
  assert.equal(field(scanned.body, "file", "contentUnavailableReason"), "no_extractable_text", summary(scanned))
  assert.equal(field(scanned.body, "file", "content"), null)
  const huge = await read("huge_pdf")
  assert.equal(field(huge.body, "file", "contentUnavailableReason"), "file_too_large", summary(huge))
  assert.equal(downloads.includes("huge_pdf"), false)
  for (const unavailable of [scanned, huge]) {
    assert.match(text(field(unavailable.body, "file", "contentUnavailableHint"), "hint"), /createGoogleDriveDownloadLink/)
  }
  assert.equal(field(before.body, "file", "contentUnavailableHint"), undefined, "nothing changes with the feature off")
})
