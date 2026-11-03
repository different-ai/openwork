import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import { test } from "node:test"
import { createInferenceEgressFetch, isVertexHost, vertexHost, vertexPublisherBase } from "./inference-egress.ts"

type Received = { headers: IncomingHttpHeaders; body: string }

const vertexHosts = ["aiplatform.googleapis.com", "europe-west4-aiplatform.googleapis.com", "aiplatform.eu.rep.googleapis.com", "aiplatform.us.rep.googleapis.com"]
const jsonBody = "{\"messages\":[{\"role\":\"user\",\"content\":\"Réponds OK\"}]}"

// Serves every hostname from 127.0.0.1 through the transport's own resolver, so the
// real hostname reaches the Vertex check while no request leaves the machine.
async function withRecordingServer(run: (originFor: (host: string) => string, egressFetch: (host: string) => typeof fetch, received: Received[]) => Promise<void>) {
  const received: Received[] = []
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
    incoming.on("end", () => {
      received.push({ headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") })
      outgoing.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Recording server has no port")
  const originFor = (host: string) => `http://${host}:${address.port}`
  const egressFetch = (host: string) => createInferenceEgressFetch({
    allowedOrigins: new Set([originFor(host)]),
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
  })
  try { await run(originFor, egressFetch, received) } finally { server.close() }
}

for (const host of vertexHosts) {
  for (const [kind, body] of [["string", jsonBody], ["bytes", new TextEncoder().encode(jsonBody)]] as const) {
    test(`a ${kind} body to ${host} is sent with its exact Content-Length, not chunked`, async () => {
      await withRecordingServer(async (originFor, egressFetch, received) => {
        const response = await egressFetch(host)(`${originFor(host)}/v1/models/claude:rawPredict`, {
          method: "POST", headers: { "content-type": "application/json", "content-length": "1", "transfer-encoding": "chunked" }, body,
        })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true })
        assert.equal(received[0]?.body, jsonBody)
        assert.equal(received[0]?.headers["content-length"], String(Buffer.byteLength(jsonBody)))
        assert.equal(received[0]?.headers["transfer-encoding"], undefined)
      })
    })
  }
}

test("non-Vertex upstreams keep chunked bodies, including look-alike hosts", async () => {
  for (const host of ["api.anthropic.com", "aiplatform.googleapis.com.example.test", "aiplatform.fr.rep.googleapis.com", "generativelanguage.googleapis.com"]) {
    await withRecordingServer(async (originFor, egressFetch, received) => {
      const response = await egressFetch(host)(`${originFor(host)}/v1/messages`, { method: "POST", body: jsonBody })
      assert.equal(response.status, 200)
      assert.equal(received[0]?.body, jsonBody)
      assert.equal(received[0]?.headers["transfer-encoding"], "chunked", host)
      assert.equal(received[0]?.headers["content-length"], undefined, host)
    })
  }
})

test("a caller-supplied stream body to Vertex is still forwarded chunked", async () => {
  await withRecordingServer(async (originFor, egressFetch, received) => {
    const host = "aiplatform.eu.rep.googleapis.com"
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"a\":"))
        controller.enqueue(new TextEncoder().encode("1}"))
        controller.close()
      },
    })
    const response = await egressFetch(host)(`${originFor(host)}/stream`, { method: "POST", body: stream, duplex: "half" })
    assert.equal(response.status, 200)
    assert.equal(received[0]?.body, "{\"a\":1}")
    assert.equal(received[0]?.headers["transfer-encoding"], "chunked")
    assert.equal(received[0]?.headers["content-length"], undefined)
  })
})

test("a bodiless request to Vertex sends no body framing", async () => {
  await withRecordingServer(async (originFor, egressFetch, received) => {
    const host = "aiplatform.googleapis.com"
    const response = await egressFetch(host)(`${originFor(host)}/models`)
    assert.equal(response.status, 200)
    assert.equal(received[0]?.body, "")
    assert.equal(received[0]?.headers["transfer-encoding"], undefined)
  })
})

const publishers: ("google" | "anthropic")[] = ["google", "anthropic"]

for (const [location, host] of [
  ["eu", "aiplatform.eu.rep.googleapis.com"],
  ["us", "aiplatform.us.rep.googleapis.com"],
  ["global", "aiplatform.googleapis.com"],
  ["europe-west4", "europe-west4-aiplatform.googleapis.com"],
]) {
  for (const publisher of publishers) {
    test(`Vertex ${publisher} uses the correct host and location for ${location}`, () => {
      for (const project of ["example-project", "123456789012"]) {
        assert.equal(vertexPublisherBase({ project, location }, publisher),
          `https://${host}/v1/projects/${project}/locations/${location}/publishers/${publisher}`)
      }
    })
  }
}

test("Vertex destinations still reject invalid projects and locations", () => {
  for (const location of [undefined, null, 1, "", "EU", "europe", "eu1.example.com", "eu/locations/global", "eu?x=1", "eu#fragment", "eu\n"]) {
    assert.equal(vertexPublisherBase({ project: "example-project", location }, "google"), null)
  }
  for (const project of [undefined, null, 1, "", "short", "UPPERCASE", "bad/project", "12345", "1".repeat(21), "a".repeat(64), "project-"]) {
    assert.equal(vertexPublisherBase({ project, location: "eu" }, "anthropic"), null)
  }
})

test("isVertexHost accepts exactly the hosts vertexHost builds", () => {
  for (const location of ["global", "eu", "us", "europe-west4", "us-central1", "northamerica-northeast1"]) assert.equal(isVertexHost(vertexHost(location)), true, location)
  for (const host of ["", "api.anthropic.com", "googleapis.com", "aiplatform.googleapis.com.evil.test", "evil.test.aiplatform.googleapis.com",
    "aiplatform.fr.rep.googleapis.com", "europe-aiplatform.googleapis.com", "EUROPE-WEST4-aiplatform.googleapis.com", "oauth2.googleapis.com"]) {
    assert.equal(isVertexHost(host), false, host)
  }
})
