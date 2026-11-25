import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentInstanceRow } from "../src/workbot-proactive/repository.js"
import { noticeUnreadableSources, type CheckRecordInput } from "../src/workbot-proactive/wake-shared.js"

const NOW = Date.UTC(2026, 10, 18, 17)
const LINK = "https://den.example/connect"
const SENTRY_LINK = `<${LINK}/emc_sentry|Connect Sentry>`
const VERCEL_LINK = `<${LINK}/emc_vercel|Reconnect Vercel>`
const MESSAGE = { channelId: "D012345", messageTs: "1795021200.000001", permalink: null }
const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const row: AgentInstanceRow = {
  memberId: createDenTypeId("member"),
  organizationId,
  templateVersionId: null,
  status: null,
  overrides: null,
  snoozedUntil: null,
  state: null,
  preferences: null,
  timeZone: "America/Los_Angeles",
  nextWakeAt: new Date(NOW),
  failures: 0,
  leaseOwner: null,
  leaseUntil: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
}

type NoticeInput = Parameters<typeof noticeUnreadableSources>[0]
const unreadable: NoticeInput["unreadable"] = [
  {
    connection: { id: "emc_sentry", name: "Sentry", url: "https://sentry.example/mcp", native: null, state: "needs_connection" },
    sources: [{ id: "emc_sentry", name: "Sentry" }],
  },
  {
    connection: { id: "emc_vercel", name: "Vercel", url: "https://vercel.example/mcp", native: null, state: "reconnect" },
    sources: [{ id: "emc_vercel", name: "Vercel" }],
  },
]

function harness(holdsLease = true) {
  const sent: string[] = []
  const records: CheckRecordInput[] = []
  const gates: string[] = []
  return {
    sent,
    records,
    gates,
    run: (options: Partial<Pick<NoticeInput, "combined" | "told" | "othersReadable" | "unreadable">> = {}) => noticeUnreadableSources({
      row,
      organizationId,
      userId,
      unreadable,
      othersReadable: true,
      told: {},
      now: NOW,
      slot: "slot-1",
      kind: "scheduled",
      deps: {
        holdsLease: async () => {
          gates.push("lease")
          return holdsLease
        },
        allowed: async () => {
          gates.push("allowed")
          return true
        },
        deliver: async ({ text }) => {
          sent.push(text)
          return { ok: true, message: MESSAGE }
        },
        connectLink: (id) => `${LINK}/${id}`,
      },
      record: async (record) => {
        records.push(record)
      },
      ...options,
    }),
  }
}

test("the default still sends today's exact message for each unreadable connection", async () => {
  for (const options of [{}, { combined: false }]) {
    const h = harness()
    assert.deepEqual(await h.run(options), { emc_sentry: NOW, emc_vercel: NOW })
    assert.deepEqual(h.sent, [
      `Quick check: I can't read your Sentry, so I've paused checking it and kept reading the rest. ${SENTRY_LINK}`,
      `Quick check: I can't read your Vercel, so I've paused checking it and kept reading the rest. ${VERCEL_LINK}`,
    ])
  }
})

test("a combined notice delivers once and records each unreadable connection with the same message", async () => {
  const h = harness()
  assert.deepEqual(await h.run({ combined: true }), { emc_sentry: NOW, emc_vercel: NOW })
  assert.deepEqual(h.gates, ["lease", "allowed"])
  assert.deepEqual(h.sent, [
    `I can't read Sentry or Vercel right now, so I'm skipping them. Everything else is still being checked. ${SENTRY_LINK} · ${VERCEL_LINK}`,
  ])
  assert.deepEqual(h.records, [
    { reason: "source_disconnected", key: "source_disconnected:emc_sentry:slot-1", kind: "scheduled", sources: [{ id: "emc_sentry", name: "Sentry", connectionId: "emc_sentry" }], message: MESSAGE },
    { reason: "source_disconnected", key: "source_disconnected:emc_vercel:slot-1", kind: "scheduled", sources: [{ id: "emc_vercel", name: "Vercel", connectionId: "emc_vercel" }], message: MESSAGE },
  ])
})

test("a combined notice only names connections not yet told and carries over old stamps", async () => {
  const h = harness()
  const told = { emc_sentry: NOW - 1000, emc_linear: NOW - 2000 }
  assert.deepEqual(await h.run({ combined: true, told }), { emc_sentry: told.emc_sentry, emc_vercel: NOW })
  assert.deepEqual(h.sent, [
    `I can't read Vercel right now, so I'm skipping it. Everything else is still being checked. ${VERCEL_LINK}`,
  ])
  assert.deepEqual(h.records.map((record) => record.key), ["source_disconnected:emc_vercel:slot-1"])
})

test("a combined notice sends nothing when all unreadable connections have been told", async () => {
  const h = harness()
  const told = { emc_sentry: NOW - 1000, emc_vercel: NOW - 2000 }
  assert.deepEqual(await h.run({ combined: true, told }), told)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.gates, [])
  assert.deepEqual(h.records, [])
})

test("a combined notice says checks are paused only when no other source is readable", async () => {
  const h = harness()
  await h.run({ combined: true, othersReadable: false, unreadable: unreadable.slice(0, 1) })
  await h.run({ combined: true, othersReadable: false })
  assert.deepEqual(h.sent, [
    `I can't read Sentry right now, so your checks are paused until it's connected again. ${SENTRY_LINK}`,
    `I can't read Sentry or Vercel right now, so your checks are paused until they're connected again. ${SENTRY_LINK} · ${VERCEL_LINK}`,
  ])
})

test("a combined notice lists unique source names but keeps a link per connection", async () => {
  const h = harness()
  await h.run({ combined: true, unreadable: unreadable.map((entry) => ({
    ...entry,
    sources: [...entry.sources, { id: "calendar", name: "Calendar" }],
  })) })
  assert.deepEqual(h.sent, [
    `I can't read Sentry, Calendar or Vercel right now, so I'm skipping them. Everything else is still being checked. ${SENTRY_LINK} · ${VERCEL_LINK}`,
  ])
})

test("a lost lease leaves every connection unstamped and records no message", async () => {
  const h = harness(false)
  assert.deepEqual(await h.run({ combined: true }), {})
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.gates, ["lease"])
  assert.deepEqual(h.records.map(({ key, message }) => ({ key, message })), [
    { key: "source_disconnected:emc_sentry:slot-1", message: null },
    { key: "source_disconnected:emc_vercel:slot-1", message: null },
  ])
})
