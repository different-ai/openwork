import assert from "node:assert/strict"
import test from "node:test"

import {
  compareDaytonaSnapshotPin,
  updateDaytonaSnapshotPin,
} from "./update-daytona-snapshot-pin.mjs"

const envGroupId = "evg-d83537f2gups73em0m90"
const apiKey = "test-render-api-key"
const snapshotName = "openwork-0.18.10"
const expectedUrl =
  "https://api.render.com/v1/env-groups/evg-d83537f2gups73em0m90/env-vars/DAYTONA_SNAPSHOT"

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), init)
}

test("an already-correct pin makes zero write requests and reports unchanged", async () => {
  const calls = []
  const messages = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return jsonResponse({ key: "DAYTONA_SNAPSHOT", value: snapshotName })
  }

  const result = await updateDaytonaSnapshotPin({
    envGroupId,
    snapshotName,
    apiKey,
    fetchImpl,
    log: (message) => messages.push(message),
  })

  assert.equal(result.status, "unchanged")
  assert.equal(calls.filter((call) => call.options.method === "PUT").length, 0)
  assert.deepEqual(messages, [
    "unchanged: DAYTONA_SNAPSHOT is already openwork-0.18.10",
  ])
})

test("a different pin makes exactly one documented PUT and reports the transition", async () => {
  const calls = []
  const messages = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (options.method === "GET") {
      return jsonResponse({
        key: "DAYTONA_SNAPSHOT",
        value: "openwork-0.18.9",
      })
    }
    return jsonResponse({ id: envGroupId })
  }

  const result = await updateDaytonaSnapshotPin({
    envGroupId,
    snapshotName,
    apiKey,
    fetchImpl,
    log: (message) => messages.push(message),
  })

  const writes = calls.filter((call) => call.options.method === "PUT")
  assert.equal(result.status, "updated")
  assert.equal(writes.length, 1)
  assert.equal(writes[0].url, expectedUrl)
  assert.equal(writes[0].options.body, '{"value":"openwork-0.18.10"}')
  assert.equal(writes[0].options.headers["Content-Type"], "application/json")
  assert.deepEqual(messages, [
    "updated: DAYTONA_SNAPSHOT openwork-0.18.9 -> openwork-0.18.10",
  ])
})

test("a non-2xx response fails with the status and response body", async () => {
  const fetchImpl = async (_url, options) => {
    if (options.method === "GET") {
      return jsonResponse({
        key: "DAYTONA_SNAPSHOT",
        value: "openwork-0.18.9",
      })
    }
    return new Response("upstream exploded", {
      status: 503,
      statusText: "Service Unavailable",
    })
  }

  await assert.rejects(
    updateDaytonaSnapshotPin({
      envGroupId,
      snapshotName,
      apiKey,
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /503 Service Unavailable/)
      assert.match(error.message, /upstream exploded/)
      return true
    },
  )
})

test("empty or missing snapshot names are refused before any request", async (context) => {
  for (const invalidName of [undefined, "", "   "]) {
    await context.test(JSON.stringify(invalidName), async () => {
      let requests = 0
      await assert.rejects(
        updateDaytonaSnapshotPin({
          envGroupId,
          snapshotName: invalidName,
          apiKey,
          fetchImpl: async () => {
            requests += 1
            return jsonResponse({})
          },
        }),
        /Missing snapshot name/,
      )
      assert.equal(requests, 0)
    })
  }
})

test("an obviously invalid snapshot name is refused before any request", async () => {
  await assert.rejects(
    updateDaytonaSnapshotPin({
      envGroupId,
      snapshotName: "not/a snapshot",
      apiKey,
      fetchImpl: async () => jsonResponse({}),
    }),
    /Invalid snapshot name/,
  )
})

test("a missing env group id is refused with an actionable message", async () => {
  await assert.rejects(
    updateDaytonaSnapshotPin({
      envGroupId: " ",
      snapshotName,
      apiKey,
      fetchImpl: async () => jsonResponse({}),
    }),
    /Missing env group id\. Pass --env-group-id <id>/,
  )
})

test("dry-run makes no requests and prints the exact proposed request", async () => {
  let requests = 0
  const messages = []

  const result = await updateDaytonaSnapshotPin({
    envGroupId,
    snapshotName,
    apiKey,
    dryRun: true,
    fetchImpl: async () => {
      requests += 1
      return jsonResponse({})
    },
    log: (message) => messages.push(message),
  })

  assert.equal(result.status, "dry-run")
  assert.equal(requests, 0)
  assert.deepEqual(messages, [
    "dry-run: no request sent",
    "method: PUT",
    `url: ${expectedUrl}`,
    'body: {"value":"openwork-0.18.10"}',
  ])
})

test("compare mode reports agreement without writing", async () => {
  const calls = []
  const messages = []
  const result = await compareDaytonaSnapshotPin({
    envGroupId,
    snapshotName,
    apiKey,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return jsonResponse({ key: "DAYTONA_SNAPSHOT", value: snapshotName })
    },
    log: (message) => messages.push(message),
  })

  assert.equal(result.status, "agreement")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, "GET")
  assert.deepEqual(messages, ["agreement: DAYTONA_SNAPSHOT=openwork-0.18.10"])
})

test("compare mode fails with a clear diff when drift is detected", async () => {
  await assert.rejects(
    compareDaytonaSnapshotPin({
      envGroupId,
      snapshotName,
      apiKey,
      fetchImpl: async () =>
        jsonResponse({
          key: "DAYTONA_SNAPSHOT",
          value: "openwork-0.18.9",
        }),
    }),
    /expected DAYTONA_SNAPSHOT=openwork-0\.18\.10, found DAYTONA_SNAPSHOT=openwork-0\.18\.9/,
  )
})
