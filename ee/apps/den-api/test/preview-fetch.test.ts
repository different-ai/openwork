import { createServer, type Server } from "node:http"
import { describe, expect, test } from "bun:test"
import { createPreviewFetch, fetchPreviewNoRedirect, fetchWithConnectRetry, type FetchLike } from "../src/workers/preview-fetch.js"

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function serverUrl(server: Server) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not bind")
  return `http://127.0.0.1:${address.port}`
}

function connectError() {
  return Object.assign(new Error("connect failed"), { code: "ECONNRESET" })
}

describe("preview fetch", () => {
  test("retries a connect-phase error once and succeeds", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      if (calls === 1) throw connectError()
      return new Response("ok")
    }

    const response = await fetchWithConnectRetry({ fetchImpl, url: "https://preview.test", init: {} })

    expect(await response.text()).toBe("ok")
    expect(calls).toBe(2)
  })

  test("returns a successful response without retrying", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      return new Response("ok")
    }

    await fetchWithConnectRetry({ fetchImpl, url: "https://preview.test", init: {} })

    expect(calls).toBe(1)
  })

  test("does not retry a non-connect error", async () => {
    let calls = 0
    const failure = new Error("request failed")
    const fetchImpl: FetchLike = async () => {
      calls += 1
      throw failure
    }

    await expect(fetchWithConnectRetry({ fetchImpl, url: "https://preview.test", init: {} })).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  test("stops after one connect retry", async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls += 1
      throw connectError()
    }

    await expect(fetchWithConnectRetry({ fetchImpl, url: "https://preview.test", init: {} })).rejects.toMatchObject({
      code: "ECONNRESET",
    })
    expect(calls).toBe(2)
  })

  test("preserves AbortSignal cancellation", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(createPreviewFetch({ connectTimeoutMs: 100 })("https://preview.test", {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" })
  })

  test("307 and 308 redirects never receive preview bodies or tokens", async () => {
    const targetRequests: Array<{ authorization: string | null; hostToken: string | null; body: string }> = []
    const target = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        targetRequests.push({
          authorization: request.headers.authorization ?? null,
          hostToken: typeof request.headers["x-openwork-host-token"] === "string" ? request.headers["x-openwork-host-token"] : null,
          body: Buffer.concat(chunks).toString("utf8"),
        })
        response.end("unexpected")
      })
    })
    let redirectStatus = 307
    const preview = createServer((_request, response) => {
      response.writeHead(redirectStatus, { Location: `${serverUrl(target)}/redirect-target` })
      response.end()
    })
    await Promise.all([listen(target), listen(preview)])
    try {
      for (const status of [307, 308]) {
        redirectStatus = status
        await expect(fetchPreviewNoRedirect(
          (url, init) => fetch(url, init),
          `${serverUrl(preview)}/env`,
          {
            method: "PUT",
            headers: {
              Authorization: "Bearer client-secret",
              "X-OpenWork-Host-Token": "host-secret",
            },
            body: JSON.stringify({ secret: "body-secret" }),
          },
        )).rejects.toBeDefined()
      }
      expect(targetRequests).toEqual([])
    } finally {
      await Promise.all([close(preview), close(target)])
    }
  })
})
