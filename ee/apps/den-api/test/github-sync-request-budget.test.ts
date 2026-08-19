import { beforeEach, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import {
  clearGithubInstallationTokenCache,
  getGithubInstallationAccessToken,
} from "../src/routes/org/plugin-system/github-app.js"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
const config = { appId: "request-budget-app", privateKey: privateKeyPem }

type RequestCounter = {
  calls: number
  inFlight: number
  maxInFlight: number
}

beforeEach(() => {
  clearGithubInstallationTokenCache()
})

function countedMintFetch(counter: RequestCounter, response: () => Response): typeof fetch {
  return async () => {
    counter.calls += 1
    counter.inFlight += 1
    counter.maxInFlight = Math.max(counter.maxInFlight, counter.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return response()
    } finally {
      counter.inFlight -= 1
    }
  }
}

test("twelve concurrent cold token requests share exactly one mint", async () => {
  const before = { calls: 0, inFlight: 0, maxInFlight: 0 }
  const beforeFetch = countedMintFetch(before, () => new Response(JSON.stringify({ token: "before-token" }), { status: 201 }))
  await Promise.all(Array.from({ length: 12 }, () => beforeFetch("https://api.github.test/access_tokens")))

  const after = { calls: 0, inFlight: 0, maxInFlight: 0 }
  const afterFetch = countedMintFetch(after, () => new Response(JSON.stringify({ token: "shared-token" }), { status: 201 }))
  const tokens = await Promise.all(Array.from({ length: 12 }, () => getGithubInstallationAccessToken({
    config,
    fetchFn: afterFetch,
    installationId: 777,
    nowMs: 1_000,
  })))

  expect(before).toEqual({ calls: 12, inFlight: 0, maxInFlight: 12 })
  expect(after).toEqual({ calls: 1, inFlight: 0, maxInFlight: 1 })
  expect(tokens).toEqual(Array.from({ length: 12 }, () => "shared-token"))
})

test("a shared 502 token failure is evicted and retried", async () => {
  const counter = { calls: 0, inFlight: 0, maxInFlight: 0 }
  let fail = true
  const fetchFn = countedMintFetch(counter, () => fail
    ? new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 502 })
    : new Response(JSON.stringify({ token: "retry-token" }), { status: 201 }))
  const input = { config, fetchFn, installationId: 777, nowMs: 1_000 }

  const failures = await Promise.allSettled(Array.from({ length: 8 }, () => getGithubInstallationAccessToken(input)))
  expect(failures.every((result) => result.status === "rejected")).toBe(true)
  expect(counter).toEqual({ calls: 1, inFlight: 0, maxInFlight: 1 })
  fail = false
  expect(await getGithubInstallationAccessToken(input)).toBe("retry-token")
  expect(counter).toEqual({ calls: 2, inFlight: 0, maxInFlight: 1 })
})

test("a hung token mint aborts at its deadline and the next call retries", async () => {
  let abortObserved = false
  let calls = 0
  let hang = true
  const fetchFn: typeof fetch = async (_url, init) => {
    calls += 1
    if (!hang) return new Response(JSON.stringify({ token: "after-timeout-token" }), { status: 201 })
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error("token mint did not receive an abort signal"))
        return
      }
      const abort = () => {
        abortObserved = true
        reject(signal.reason)
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
  const input = { config, fetchFn, installationId: 777, nowMs: 1_000, requestTimeoutMs: 10 }

  await expect(getGithubInstallationAccessToken(input)).rejects.toMatchObject({ name: "TimeoutError" })
  expect(abortObserved).toBe(true)
  hang = false
  expect(await getGithubInstallationAccessToken(input)).toBe("after-timeout-token")
  expect(calls).toBe(2)
})

test("distinct app and installation keys mint and cache independently", async () => {
  let mintCount = 0
  let inFlight = 0
  let maxInFlight = 0
  const fetchFn: typeof fetch = async () => {
    mintCount += 1
    const token = `token-${mintCount}`
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight -= 1
    return new Response(JSON.stringify({ token }), { status: 201 })
  }
  const otherAppConfig = { appId: "other-request-budget-app", privateKey: privateKeyPem }
  const results = await Promise.all([
    getGithubInstallationAccessToken({ config, fetchFn, installationId: 777, nowMs: 1_000 }),
    getGithubInstallationAccessToken({ config, fetchFn, installationId: 777, nowMs: 1_000 }),
    getGithubInstallationAccessToken({ config, fetchFn, installationId: 888, nowMs: 1_000 }),
    getGithubInstallationAccessToken({ config: otherAppConfig, fetchFn, installationId: 777, nowMs: 1_000 }),
  ])

  expect(results[0]).toBe(results[1])
  expect(new Set([results[0], results[2], results[3]]).size).toBe(3)
  expect(mintCount).toBe(3)
  expect(maxInFlight).toBe(3)
  expect(await getGithubInstallationAccessToken({ config, fetchFn, installationId: 888, nowMs: 2_000 })).toBe(results[2])
  expect(await getGithubInstallationAccessToken({ config: otherAppConfig, fetchFn, installationId: 777, nowMs: 2_000 })).toBe(results[3])
  expect(mintCount).toBe(3)
})

test("cache clear cannot be repopulated by an older in-flight mint", async () => {
  let resolveOldRequest: ((response: Response) => void) | undefined
  const oldRequest = getGithubInstallationAccessToken({
    config,
    fetchFn: async () => new Promise<Response>((resolve) => {
      resolveOldRequest = resolve
    }),
    installationId: 777,
    nowMs: 1_000,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (!resolveOldRequest) throw new Error("old token mint did not start")

  clearGithubInstallationTokenCache()
  let freshCalls = 0
  const freshInput = {
    config,
    fetchFn: async () => {
      freshCalls += 1
      return new Response(JSON.stringify({ token: "fresh-token" }), { status: 201 })
    },
    installationId: 777,
    nowMs: 1_000,
  }
  expect(await getGithubInstallationAccessToken(freshInput)).toBe("fresh-token")

  resolveOldRequest(new Response(JSON.stringify({ token: "old-token" }), { status: 201 }))
  expect(await oldRequest).toBe("old-token")
  expect(await getGithubInstallationAccessToken(freshInput)).toBe("fresh-token")
  expect(freshCalls).toBe(1)
})
