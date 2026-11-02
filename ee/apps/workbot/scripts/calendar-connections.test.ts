import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CalendarConnectionError, calendarRange, localDateOf, type CalendarConnectionErrorKind, type CalendarProviderId } from "../../../../packages/calendar/src/index.js"
import { WorkbotCalendar } from "../../../packages/workbot-ui/src/calendar.js"
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host.js"
import type { WorkbotConnection } from "../../../packages/workbot-ui/src/data.js"

const settings = "https://den.example.test/dashboard/your-connections"
const message = "Couldn&#x27;t verify an account to connect here."
const providers: CalendarProviderId[] = ["google", "microsoft"]

async function renderCalendar(connections: WorkbotConnection[], states: Partial<Record<CalendarProviderId, CalendarConnectionErrorKind | "connected">> = { google: "not_connected", microsoft: "not_connected" }, fallbackHref: string | null = settings) {
  const identity = { organizationId: "fixture-org", principalId: "fixture-member" }
  setWorkbotHost({
    identity, user: null, homeHref: "/", appIcons: () => [], useConnectedApps: () => [],
    requestJson: async () => { throw new Error("Rendering must not send a request") },
    prepare: async () => { throw new Error("Rendering must not prepare a request") },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  client.setQueryData(["workbot", "connections", identity.organizationId, identity.principalId], connections)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const range = calendarRange("week", localDateOf(Date.now(), zone), zone, 1)
  for (const provider of providers) {
    await client.prefetchQuery({
      queryKey: ["workbot", "calendar", "meetings", "den", provider, range.start, range.end],
      queryFn: async () => {
        const state = states[provider] ?? "unsupported"
        if (state === "connected") return { events: [], complete: true, requests: 1 }
        throw new CalendarConnectionError(provider, state, "Fixture calendar status")
      },
    })
  }
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(WorkbotCalendar, { connectionsHref: fallbackHref, assistantName: "Assistant" })))
  } finally { client.clear() }
}

function connection(provider: "google-workspace" | "microsoft-365", id: string = provider): WorkbotConnection {
  return { id, name: id, app: provider === "google-workspace" ? "googleCalendar" : "microsoft", nativeProviderKey: provider, ready: false, connectMode: "inline", connectUrl: null }
}

for (const catalog of [[], [{ id: "legacy-google", name: "Google Workspace", app: "gmail", ready: false, connectUrl: settings } satisfies WorkbotConnection]]) {
  test(`Calendar shows one shared fallback for ${catalog.length ? "legacy" : "empty"} connection metadata`, async () => {
    const html = await renderCalendar(catalog)
    assert.equal(html.split(message).length - 1, 1)
    assert.equal(html.split(">Open connection settings</a>").length - 1, 1)
  })
}

test("Calendar shows admin review once when no settings destination is available", async () => {
  const html = await renderCalendar([], undefined, null)
  assert.equal(html.split(message).length - 1, 1)
  assert.equal(html.split("Ask an admin to review setup and access.").length - 1, 1)
})

test("Calendar retains both known providers' Connect and Reconnect actions, including multiple accounts", async () => {
  const html = await renderCalendar([connection("google-workspace"), connection("google-workspace", "other-google"), connection("microsoft-365")], { google: "not_connected", microsoft: "auth_expired" })
  assert.ok(html.includes(">Connect Google Calendar: google-workspace</button>"))
  assert.ok(html.includes(">Connect Google Calendar: other-google</button>"))
  assert.ok(html.includes(">Reconnect Outlook Calendar</button>"))
  assert.equal(html.includes(message), false)
})

test("an unverified provider does not suppress the other provider's known action", async () => {
  for (const provider of ["google-workspace", "microsoft-365"] as const) {
    const html = await renderCalendar([connection(provider)])
    assert.equal(html.split(message).length - 1, 1)
    assert.ok(html.includes(provider === "google-workspace" ? ">Connect Google Calendar</button>" : ">Connect Outlook Calendar</button>"))
  }
})

test("provider-specific permission failures remain visible beside the shared fallback", async () => {
  const html = await renderCalendar([], { google: "permission_missing", microsoft: "auth_expired" })
  assert.ok(html.includes("Google Calendar needs calendar access"))
  assert.equal(html.split(message).length - 1, 1)
})

test("an unused provider remains hidden when another calendar is connected", async () => {
  const html = await renderCalendar([], { google: "connected", microsoft: "not_connected" })
  assert.equal(html.includes(message), false)
  assert.equal(html.includes("Open connection settings"), false)
})
