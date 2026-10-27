import assert from "node:assert/strict"
import { test } from "node:test"
import { checkGoogleConnectorApis, requiredGoogleApis } from "../src/routes/org/google-api-check.js"

const disabled = (service: string, title: string) => ({
  error: {
    code: 403,
    message: `${title} has not been used in project 123456789 before or it is disabled.`,
    errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
    status: "PERMISSION_DENIED",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "SERVICE_DISABLED",
      metadata: { service, serviceTitle: title, consumer: "projects/123456789", activationUrl: `https://console.developers.google.com/apis/api/${service}/overview?project=123456789` },
    }],
  },
})

test("only the APIs that enabled permissions call are checked, and Drive needs Docs and Sheets", () => {
  assert.deepEqual(requiredGoogleApis(["calendarRead", "gmailDraft"]).map((api) => api.id), ["gmail", "calendar"])
  assert.deepEqual(requiredGoogleApis(["driveFile"]).map((api) => api.id), ["drive", "docs", "sheets"])
  assert.deepEqual(requiredGoogleApis(["sheetsRead"]).map((api) => [api.id, api.features]), [["sheets", ["sheetsRead"]]])
  assert.deepEqual(requiredGoogleApis([]), [])
})

test("a turned-off API links to Google's console, while not-found and success both mean on", async () => {
  const seen: string[] = []
  const apis = await checkGoogleConnectorApis({
    accessToken: "token",
    features: ["driveRead", "gmailRead", "calendarRead"],
    fetch: async (input) => {
      const url = new URL(String(input))
      seen.push(url.hostname)
      if (url.hostname === "sheets.googleapis.com") return Response.json(disabled("sheets.googleapis.com", "Google Sheets API"), { status: 403 })
      if (url.hostname === "docs.googleapis.com") return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 })
      if (url.hostname === "gmail.googleapis.com") return Response.json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 })
      if (url.pathname.startsWith("/calendar/")) throw new TypeError("fetch failed")
      return Response.json({ kind: "drive#about" })
    },
  })
  const byId = Object.fromEntries(apis.map((api) => [api.id, api]))
  assert.equal(byId.drive?.status, "enabled")
  assert.equal(byId.docs?.status, "enabled")
  assert.equal(byId.sheets?.status, "disabled")
  assert.equal(byId.sheets?.enableUrl, "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123456789")
  assert.equal(byId.gmail?.status, "unknown")
  assert.match(byId.gmail?.detail ?? "", /Sign in again/)
  assert.equal(byId.calendar?.status, "unknown")
  assert.equal(byId.chat, undefined)
  assert.equal(seen.length, 5)
})

test("an activation link that is not Google's console falls back to the API library page", async () => {
  const body = disabled("docs.googleapis.com", "Google Docs API")
  body.error.details[0]!.metadata.activationUrl = "https://untrusted.example/enable"
  const [api] = await checkGoogleConnectorApis({
    accessToken: "token",
    features: ["driveFile"],
    fetch: async (input) => new URL(String(input)).hostname === "docs.googleapis.com"
      ? Response.json(body, { status: 403 })
      : Response.json({}),
  }).then((apis) => apis.filter((entry) => entry.id === "docs"))
  assert.equal(api?.status, "disabled")
  assert.equal(api?.enableUrl, "https://console.cloud.google.com/apis/library/docs.googleapis.com")
})
