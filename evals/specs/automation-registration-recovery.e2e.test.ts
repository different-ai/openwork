import { expect } from "vitest"
import { clickButton, clickText, denFetch, evalIn, go, waitForText } from "@openwork/behaviors"
import { app, browserScript, eventually, faultProxy, needs, server, test } from "@openwork/testkit"
import type { AutomationRun } from "@openwork/types/automations"

// Registration is independent of local engine health. A transient mint failure
// after reconnect must retry without another online event or a 30-minute wait.
test("desktop registration recovers from a transient Den outage without another reconnect", { timeout: 420_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] })
  await using den = await server({
    place,
    env: { DEN_AUTOMATIONS_ENABLED: "true" },
    org: { name: "Synthetic registration recovery", admin: { name: "Test Admin" } },
  })
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  })
  // Keep the advertised API origin on the fault proxy. Otherwise desktop
  // handoff follows Den's runtime config directly to the upstream API.
  await proxy.faults.status("/api/runtime-config", 200, {
    times: 100, body: { denApiUrl: proxy.ref.apiUrl },
  })
  const registrationPath = "/api/den/v1/automation-runners/token"
  await proxy.faults.status(registrationPath, 503, { times: 100 })
  await using desktop = await app({ den: { ...den, ref: proxy.ref }, as: "admin", place })
  const presence = async () => {
    const result = await denFetch(den.admin, "/v1/automation-runners/presence", {
      headers: { authorization: `Bearer ${den.admin.token}` },
    })
    expect(result.response.status).toBe(200)
    return record(result.body).connected
  }
  await eventually(async () => (await proxy.requestLog()).some((request) =>
    request.path === registrationPath && request.faulted && request.status === 503), {
    within: 60_000, label: "registration outage reached by the desktop",
  })
  expect(await presence()).toBe(false)

  await proxy.faults.clear()
  await proxy.faults.status("/api/runtime-config", 200, {
    times: 100, body: { denApiUrl: proxy.ref.apiUrl },
  })
  await proxy.faults.status(registrationPath, 503, { times: 1 })
  const start = (await proxy.requestLog()).length
  await evalIn(desktop, () => (window.dispatchEvent(new Event("online"))))
  await eventually(async () => {
    const requests = (await proxy.requestLog()).slice(start)
      .filter((request) => request.path === registrationPath)
    return requests.filter((request) => request.faulted && request.status === 503).length === 1
      && requests.some((request) => !request.faulted)
      && await presence() === true
  }, { within: 35_000, label: "Den observes a registered desktop after a transient failure" })

  const attempts = (await proxy.requestLog()).slice(start)
    .filter((request) => request.path === registrationPath)
  expect(attempts.filter((request) => request.faulted)).toHaveLength(1)
  expect(attempts.filter((request) => !request.faulted)).toHaveLength(1)
  evidence.recordAssertionEvidence(
    "Registration recovers without another online event",
    "Den reported no desktop during the injected startup registration outage. After a single online event and one further HTTP 503, the desktop retried and Den reported it connected within 35 seconds.",
    true,
  )

  const created = await denFetch(den.admin, "/v1/automations", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      name: "Registration recovery receipts",
      instructions: "Summarize the project notes.",
      schedule: { kind: "once", timezone: "UTC", at: Date.now() + 86_400_000 },
      model: { providerId: "opencode", modelId: "big-pickle", variant: null },
    }),
  })
  expect(created.response.status).toBe(201)
  const detail = record(created.body)
  const automationId = record(detail.automation).id
  const revisionId = record(detail.revision).id
  if (typeof automationId !== "string" || typeof revisionId !== "string") {
    throw new Error("Automation identity missing")
  }
  const occurredAt = Date.now() - 120_000
  const missed: AutomationRun = {
    id: "ui-witness-missed", automationId, revisionId, trigger: "scheduled",
    scheduledFor: occurredAt, idempotencyKey: "ui-witness-missed", status: "skipped",
    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, attemptCount: 0,
    executionTarget: "desktop", executionThread: null,
    providerId: "opencode", modelId: "big-pickle", modelVariant: null,
    startedAt: null, finishedAt: occurredAt + 60_000,
    error: { code: "runner_unavailable", message: "No desktop runner claimed this occurrence before its deadline.", retryable: false },
    resultSummary: null, usage: { inputTokens: null, outputTokens: null, costMicros: null },
    createdAt: occurredAt, updatedAt: occurredAt + 60_000,
  }
  const cases: { run: AutomationRun; title: string; variant: string }[] = [
    { run: missed, title: "Run missed", variant: "default" },
    {
      run: { ...missed, id: "ui-witness-attempted", idempotencyKey: "ui-witness-attempted", attemptCount: 1 },
      title: "Run interrupted", variant: "destructive",
    },
    {
      run: { ...missed, id: "ui-witness-started", idempotencyKey: "ui-witness-started", startedAt: occurredAt },
      title: "Run interrupted", variant: "destructive",
    },
    {
      run: {
        ...missed, id: "ui-witness-lease-lost", idempotencyKey: "ui-witness-lease-lost",
        status: "failed", attemptCount: 1, startedAt: occurredAt,
        error: { code: "lease_lost", message: "The execution lease expired after the run started.", retryable: false },
      },
      title: "Run interrupted", variant: "destructive",
    },
    {
      run: {
        ...missed, id: "ui-witness-execution-failed", idempotencyKey: "ui-witness-execution-failed",
        status: "failed", attemptCount: 1, startedAt: occurredAt,
        error: { code: "execution_failed", message: "The task failed while reading project notes.", retryable: false },
      },
      title: "execution_failed", variant: "destructive",
    },
  ]
  const runsPath = `/api/den/v1/automations/${automationId}/runs`
  await proxy.faults.status(runsPath, 200, {
    times: 100, body: { items: cases.map(({ run }) => run), nextCursor: null },
  })
  for (const { run } of cases) {
    await proxy.faults.status(`/api/den/v1/automation-runs/${run.id}`, 200, {
      times: 100, body: { ...detail, run, events: [] },
    })
  }

  await clickButton(desktop, "Automations")
  await clickText(desktop, "Registration recovery receipts", { selector: "button" })
  await waitForText(desktop, "Run history")
  await go(desktop, `/automations?automation=${automationId}&run=${missed.id}`)
  const guidance = "Keep OpenWork open, signed in, and your computer awake and connected for future runs."
  for (const { run, title, variant } of cases) {
    if (run.id !== missed.id) {
      await go(desktop, `/automations?automation=${automationId}&run=${run.id}`)
    }
    const notice = await eventually(() => evalIn(desktop, browserScript((runId) => {
      const alert = document.querySelector<HTMLElement>(`[data-automation-run-notice="${runId}"]`)
      if (!alert || alert.getBoundingClientRect().height === 0) return null
      return {
        title: alert.querySelector<HTMLElement>('[data-slot="alert-title"]')?.innerText,
        variant: alert.getAttribute("data-variant"),
        text: alert.innerText,
        destructive: alert.classList.contains("text-destructive"),
        receiptText: alert.closest<HTMLElement>('[data-slot="card-content"]')?.innerText,
        noticeIds: [...document.querySelectorAll("[data-automation-run-notice]")]
          .map((element) => element.getAttribute("data-automation-run-notice")),
        offlineWarning: Boolean(document.querySelector("[data-automation-runner-offline]")),
      }
    }, [run.id])), { within: 15_000, label: `visible UI receipt ${run.id}` })
    expect(notice?.title).toBe(title)
    expect(notice?.variant).toBe(variant)
    expect(notice?.destructive).toBe(variant === "destructive")
    expect(notice?.receiptText).toContain("— input · — output · —")
    expect(notice?.noticeIds).toEqual([run.id])
    expect(notice?.offlineWarning).toBe(false)
    expect(notice?.text).toContain(run.error?.message)
    expect(notice?.text).not.toMatch(/offline|asleep|closed|signed out/i)
    if (run.id === missed.id) {
      expect(notice?.text).toContain("This occurrence never started.")
      expect(notice?.text).toContain(guidance)
      expect(notice?.text).not.toContain("Run interrupted")
    } else {
      expect(notice?.text).not.toContain("Run missed")
      expect(notice?.text).not.toContain("This occurrence never started.")
      expect(notice?.text).not.toContain(guidance)
    }
  }
  const receiptRequests = await proxy.requestLog()
  for (const path of [runsPath, ...cases.map(({ run }) => `/api/den/v1/automation-runs/${run.id}`)]) {
    expect(receiptRequests.some((request) => request.method === "GET"
      && request.path.split("?")[0] === path && request.faulted && request.status === 200)).toBe(true)
  }
  expect(await presence()).toBe(true)
  evidence.recordAssertionEvidence(
    "UI witness: missed occurrences differ from interrupted and failed execution receipts",
    "The real app opened a real Den Automation and rendered fault-proxy receipt fixtures, not scheduler-produced runs. Only the unattempted runner_unavailable receipt showed a default Run missed notice and future-run guidance. Attempt-count and start-time historical receipts and lease_lost were destructive Run interrupted notices; execution_failed retained its destructive error and message. No receipt inferred an offline cause or replaced the recovered desktop's connected presence. This is UI classification evidence, not backend scheduling or execution proof.",
    true,
  )
})


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object")
  return value
}

// Exercise the real Den dispatch boundary with a synthetic Windows runner;
// no model provider or private desktop profile participates in this witness.
test("a queued manual run completes once after a synthetic Windows runner registers", { timeout: 180_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] })
  await using den = await server({ place, org: { name: "Synthetic dispatch recovery" } })
  const headers = { authorization: `Bearer ${den.admin.token}` }
  const request = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const result = await denFetch(den.admin, path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect(result.response.ok, `HTTP ${result.response.status} from ${path}`).toBe(true)
    return record(result.body)
  }
  const before = await request("/v1/automation-runners/presence")
  expect(before.connected).toBe(false)
  const created = await request("/v1/automations", "POST", {
    name: "Synthetic recovery dispatch",
    instructions: "Produce the synthetic recovery receipt.",
    schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
    model: { providerId: "opencode", modelId: "big-pickle", variant: null },
  })
  const automationId = record(created.automation).id
  expect(typeof automationId).toBe("string")
  const queued = await request(`/v1/automations/${automationId}/run`, "POST")
  const runId = record(queued.run).id
  expect(typeof runId).toBe("string")
  const register = async (runnerId: string) => {
    const minted = await request("/v1/automation-runners/token", "POST", {
      runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"],
      capabilities: [], appVersion: "0.0.0-test", platform: "win32", concurrency: 1,
    })
    if (typeof minted.token !== "string") throw new Error("Runner token missing")
    return minted.token
  }
  const token = await register("synthetic-recovery-runner")
  const competing = await register("synthetic-competing-runner")
  const work = await request("/v1/automation-runner/work", "GET", undefined, token)
  expect(work.items).toEqual([{ runId, executionTarget: "desktop" }])
  expect((await request("/v1/automation-runners/presence")).connected).toBe(true)
  const claimed = await request(`/v1/automation-runs/${runId}/claim`, "POST", undefined, token)
  expect(record(claimed.assignment).attempt).toBe(1)
  expect((await request(`/v1/automation-runs/${runId}/claim`, "POST", undefined, competing)).assignment).toBeNull()
  const completed = await request(`/v1/automation-runs/${runId}/complete`, "POST", {
    attempt: 1, status: "succeeded", sessionId: "synthetic-session", workspaceId: "synthetic-workspace",
    resultSummary: "Synthetic recovery completed.",
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, error: null,
  }, token)
  expect(record(completed.run).status).toBe("succeeded")
  expect((await request(`/v1/automation-runs/${runId}/claim`, "POST", undefined, token)).assignment).toBeNull()
  expect((await request("/v1/automation-runner/work", "GET", undefined, token)).items).toEqual([])
  const receipt = record((await request(`/v1/automation-runs/${runId}`)).run)
  expect(receipt.status).toBe("succeeded")
  expect(receipt.attemptCount).toBe(1)
  evidence.recordAssertionEvidence(
    "A recovered manual dispatch completes once",
    "A run queued with no desktop present was discovered and completed by a synthetic Windows runner. A competing runner could not claim it, and completion left no claimable work or second attempt.",
    true,
  )
})
