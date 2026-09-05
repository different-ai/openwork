import { expect } from "vitest"
import { evalIn } from "@openwork/behaviors"
import { app, eventually, faultProxy, needs, server, test } from "@openwork/testkit"

// Registration is independent of local engine health. A transient mint failure
// after reconnect must retry without another online event or a 30-minute wait.
test("desktop registration recovers from a transient Den outage without another reconnect", { timeout: 420_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] })
  await using den = await server({
    place,
    org: { name: "Synthetic registration recovery", admin: { name: "Test Admin" } },
  })
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  })
  await using desktop = await app({ den: { ...den, ref: proxy.ref }, as: "admin", place })
  const registrationPath = "/api/den/v1/automation-runners/token"
  await eventually(async () => (await proxy.requestLog()).some((request) =>
    request.path === registrationPath && request.status === 200), {
    within: 60_000,
    label: "initial desktop registration",
  })

  const start = (await proxy.requestLog()).length
  await proxy.faults.status(registrationPath, 503, { times: 2 })
  await evalIn(desktop, `window.dispatchEvent(new Event("online"))`)
  await eventually(async () => {
    const requests = (await proxy.requestLog()).slice(start)
      .filter((request) => request.path === registrationPath)
    return requests.filter((request) => request.faulted && request.status === 503).length === 2
      && requests.some((request) => !request.faulted && request.status === 200)
  }, { within: 35_000, label: "automatic registration retry after two transient failures" })

  const attempts = (await proxy.requestLog()).slice(start)
    .filter((request) => request.path === registrationPath)
  expect(attempts.filter((request) => request.faulted)).toHaveLength(2)
  expect(attempts.filter((request) => request.status === 200)).toHaveLength(1)
  evidence.recordAssertionEvidence(
    "Registration recovers without another online event",
    "Two injected HTTP 503 registration failures were followed by one successful registration within 35 seconds after a single online event.",
    true,
  )
})
