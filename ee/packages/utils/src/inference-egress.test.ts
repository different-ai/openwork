import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import { test } from "node:test"
import { createInferenceEgressFetch, vertexPublisherBase } from "./inference-egress.ts"

type Received = { headers: IncomingHttpHeaders; body: string }

async function withRecordingServer(run: (origin: string, received: Received[]) => Promise<void>) {
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
  const { port } = address
  try { await run(`http://127.0.0.1:${port}`, received) } finally { server.close() }
}

// Vertex rawPredict rejects a chunked body with HTTP 400; buffered bodies must carry their exact length.
for (const [kind, body] of [
  ["string", "{\"messages\":[{\"role\":\"user\",\"content\":\"Réponds OK\"}]}"],
  ["bytes", new TextEncoder().encode("{\"messages\":[{\"role\":\"user\",\"content\":\"Réponds OK\"}]}")],
] as const) {
  test(`a ${kind} body is sent with its exact Content-Length, not chunked`, async () => {
    await withRecordingServer(async (origin, received) => {
      const egressFetch = createInferenceEgressFetch({ allowedOrigins: new Set([origin]) })
      const response = await egressFetch(`${origin}/v1/models/claude:rawPredict`, {
        method: "POST", headers: { "content-type": "application/json", "content-length": "1", "transfer-encoding": "chunked" }, body,
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      const expected = "{\"messages\":[{\"role\":\"user\",\"content\":\"Réponds OK\"}]}"
      assert.equal(received[0]?.body, expected)
      assert.equal(received[0]?.headers["content-length"], String(Buffer.byteLength(expected)))
      assert.equal(received[0]?.headers["transfer-encoding"], undefined)
    })
  })
}

test("a caller-supplied stream body is still forwarded chunked", async () => {
  await withRecordingServer(async (origin, received) => {
    const egressFetch = createInferenceEgressFetch({ allowedOrigins: new Set([origin]) })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"a\":"))
        controller.enqueue(new TextEncoder().encode("1}"))
        controller.close()
      },
    })
    const response = await egressFetch(`${origin}/stream`, { method: "POST", body: stream, duplex: "half" })
    assert.equal(response.status, 200)
    assert.equal(received[0]?.body, "{\"a\":1}")
    assert.equal(received[0]?.headers["transfer-encoding"], "chunked")
    assert.equal(received[0]?.headers["content-length"], undefined)
  })
})

test("a bodiless request sends no body framing", async () => {
  await withRecordingServer(async (origin, received) => {
    const response = await createInferenceEgressFetch({ allowedOrigins: new Set([origin]) })(`${origin}/models`)
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
