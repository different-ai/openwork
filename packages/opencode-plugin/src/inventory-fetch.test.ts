import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchSharedGatewayInventory, inventoryRequestTicket } from "./inventory-fetch.ts"
import { API, createFakeDen, GATEWAY_KEY, PROVIDER_ID, SESSION_TOKEN } from "./test-den.ts"
import type { Fetch } from "./den.ts"

// The hub is process-wide, so each test uses its own organization.
let orgs = 0
const sessionFor = () => ({ apiBaseUrl: API, token: SESSION_TOKEN, orgId: `org_shared_fetch_${++orgs}` })

/** A fake Den whose responses wait until the test releases them. */
function gatedDen() {
  const den = createFakeDen()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetch: Fetch = async (url, init) => {
    await gate
    return den.fetch(url, init)
  }
  return { den, fetch, release }
}

const lists = (calls: readonly string[]) => calls.filter((call) => call.includes("?scope=usable")).length

test("Locations that ask together share one inventory fetch", async () => {
  const session = sessionFor()
  const { den, fetch, release } = gatedDen()
  // One change reaches every Location; each takes its ticket before its own setup.
  const tickets = Array.from({ length: 5 }, () => inventoryRequestTicket())
  const requests = tickets.map((ticket) => fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket }))
  release()
  const inventories = await Promise.all(requests)
  assert.equal(lists(den.calls), 1)
  assert.deepEqual(den.calls, ["GET /v1/inference-providers?scope=usable", `GET /v1/inference-providers/${PROVIDER_ID}/connect`])
  for (const inventory of inventories) {
    assert.equal(inventory.apiKey, GATEWAY_KEY)
    assert.deepEqual(inventory.providers.map((provider) => provider.id), [PROVIDER_ID])
  }
})

test("a Location that asks after a fetch started gets its own fetch", async () => {
  const session = sessionFor()
  const { den, fetch, release } = gatedDen()
  const first = fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket: inventoryRequestTicket() })
  // A change arrived after the first fetch began reading Den.
  const later = fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket: inventoryRequestTicket() })
  release()
  await Promise.all([first, later])
  assert.equal(lists(den.calls), 2)
})

test("a finished fetch is never reused", async () => {
  const session = sessionFor()
  const den = createFakeDen()
  const ticket = inventoryRequestTicket()
  await fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", ticket })
  await fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", ticket })
  assert.equal(lists(den.calls), 2)
})

test("different credentials or credential scopes never share a fetch", async () => {
  const session = sessionFor()
  const den = createFakeDen()
  const ticket = inventoryRequestTicket()
  await Promise.all([
    fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "den", ticket }),
    fetchSharedGatewayInventory({ fetch: den.fetch, session: { ...session, orgId: `${session.orgId}_other` }, scope: "den", ticket }),
    fetchSharedGatewayInventory({ fetch: den.fetch, session, scope: "desktop", ticket }),
  ])
  assert.equal(lists(den.calls), 3)
})

test("one Location giving up does not cancel the fetch the others are waiting for", async () => {
  const session = sessionFor()
  const { den, fetch, release } = gatedDen()
  const leaving = new AbortController()
  const ticket = inventoryRequestTicket()
  const gone = fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket, signal: leaving.signal })
  const staying = fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket })
  leaving.abort()
  await assert.rejects(gone)
  release()
  assert.equal((await staying).apiKey, GATEWAY_KEY)
  assert.equal(lists(den.calls), 1)
})

test("a failed fetch is not handed to the next Location", async () => {
  const session = sessionFor()
  const den = createFakeDen()
  let failNext = true
  const fetch: Fetch = async (url, init) => {
    if (failNext) { failNext = false; return new Response("unavailable", { status: 503 }) }
    return den.fetch(url, init)
  }
  const ticket = inventoryRequestTicket()
  await assert.rejects(fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket }))
  const retried = await fetchSharedGatewayInventory({ fetch, session, scope: "den", ticket })
  assert.equal(retried.apiKey, GATEWAY_KEY)
})
