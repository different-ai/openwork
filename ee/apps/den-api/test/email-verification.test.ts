import assert from "node:assert/strict"
import { createServer, type AddressInfo, type Socket } from "node:net"
import { test } from "node:test"
import { emailSenderDomain, RESEND_DOMAINS_URL, verifyEmailTransport, type SmtpVerifyOptions } from "@openwork/email"

const smtp = { from: "Den <den@example.test>", smtp: { host: "smtp.internal", port: 2525, user: "synthetic-user", pass: "synthetic-pass", secure: false } }
const resend = { from: "Den <Den@Mail.Example.Test>", resendApiKey: "re_synthetic_not_production" }

function smtpError(code?: string) {
  return Object.assign(new Error("535 Authentication failed for synthetic-user"), code ? { code } : {})
}

test("SMTP: verify() signs in with bounded timeouts and always releases the transport", async () => {
  let options: SmtpVerifyOptions | undefined
  let closed = 0
  const result = await verifyEmailTransport(smtp, { timeoutMs: 4_000, createTransport: (settings) => {
    options = settings
    return { verify: async () => true, close: () => { closed++ } }
  } })
  assert.deepEqual(result, { provider: "smtp", outcome: "verified" })
  assert.deepEqual(options, { host: "smtp.internal", port: 2525, secure: false, auth: { user: "synthetic-user", pass: "synthetic-pass" }, connectionTimeout: 4_000, greetingTimeout: 4_000, socketTimeout: 4_000 })
  assert.ok(closed >= 1)
})

for (const [code, outcome] of [["EAUTH", "auth_failed"], ["ETIMEDOUT", "timeout"], ["ECONNECTION", "unreachable"], ["ESOCKET", "unreachable"], ["ECONNREFUSED", "unreachable"], ["EDNS", "unreachable"], ["ETLS", "unreachable"], ["EPROTOCOL", "unexpected_response"], [undefined, "unexpected_response"]] as const) {
  test(`SMTP: ${code ?? "uncoded"} error → ${outcome}, never the error text`, async () => {
    let closed = 0
    const result = await verifyEmailTransport(smtp, { timeoutMs: 1_000, createTransport: () => ({ verify: async () => { throw smtpError(code) }, close: () => { closed++ } }) })
    assert.deepEqual(result, { provider: "smtp", outcome })
    assert.ok(!JSON.stringify(result).includes("synthetic"))
    assert.ok(closed >= 1)
  })
}

test("SMTP: a server that never answers is cut off at the deadline", async () => {
  let closed = 0
  const started = Date.now()
  const result = await verifyEmailTransport(smtp, { timeoutMs: 20, createTransport: () => ({ verify: () => new Promise<true>(() => undefined), close: () => { closed++ } }) })
  assert.deepEqual(result, { provider: "smtp", outcome: "timeout" })
  assert.ok(Date.now() - started < 1_000)
  assert.ok(closed >= 1)
  const controller = new AbortController()
  const aborted = verifyEmailTransport(smtp, { timeoutMs: 5_000, signal: controller.signal, createTransport: () => ({ verify: () => new Promise<true>(() => undefined), close: () => undefined }) })
  controller.abort()
  assert.deepEqual(await aborted, { provider: "smtp", outcome: "timeout" })
})

/** Minimal SMTP server: greets, advertises AUTH, accepts or rejects one login, records every command. */
async function fakeSmtp(accept: boolean) {
  const commands: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let buffer = ""
    socket.write("220 fake.smtp.test ESMTP\r\n")
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      for (let index = buffer.indexOf("\r\n"); index >= 0; index = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const verb = line.split(" ")[0].toUpperCase()
        commands.push(verb)
        if (verb === "EHLO") socket.write("250-fake.smtp.test\r\n250 AUTH PLAIN LOGIN\r\n")
        else if (verb === "AUTH") socket.write(accept ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication failed for synthetic-user\r\n")
        else if (verb === "QUIT") { socket.write("221 Bye\r\n"); socket.end() }
        else socket.write("502 5.5.2 Not expected in a verification\r\n")
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    port, commands,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)) },
  }
}

test("SMTP with real nodemailer: EHLO + AUTH + QUIT only, never MAIL, RCPT or DATA", async () => {
  for (const accept of [true, false]) {
    const server = await fakeSmtp(accept)
    try {
      const result = await verifyEmailTransport({ ...smtp, smtp: { ...smtp.smtp, host: "127.0.0.1", port: server.port } }, { timeoutMs: 3_000 })
      assert.deepEqual(result, { provider: "smtp", outcome: accept ? "verified" : "auth_failed" })
      assert.ok(server.commands.includes("EHLO"))
      assert.ok(server.commands.includes("AUTH"))
      for (const sending of ["MAIL", "RCPT", "DATA"]) assert.ok(!server.commands.includes(sending), `${sending} must never be sent`)
    } finally { await server.close() }
  }
})

test("SMTP with real nodemailer: nothing listening is unreachable", async () => {
  const server = await fakeSmtp(true)
  const port = server.port
  await server.close()
  const result = await verifyEmailTransport({ ...smtp, smtp: { ...smtp.smtp, host: "127.0.0.1", port } }, { timeoutMs: 2_000 })
  assert.deepEqual(result, { provider: "smtp", outcome: "unreachable" })
})

type Recorded = { url: string; init: RequestInit }
function resendFetch(response: () => Response, calls: Recorded[] = []) {
  return async (url: string, init: RequestInit) => { calls.push({ url, init }); return response() }
}
const domains = (entries: Array<Record<string, unknown>>) => Response.json({ object: "list", has_more: false, data: entries })

test("Resend: lists domains with the key, without redirects, and confirms the exact EMAIL_FROM domain", async () => {
  const calls: Recorded[] = []
  const result = await verifyEmailTransport(resend, { timeoutMs: 1_000, fetch: resendFetch(() => domains([
    { id: "1", name: "example.test", status: "verified" },
    { id: "2", name: "mail.example.test", status: "verified", capabilities: { sending: "enabled", receiving: "disabled" } },
  ]), calls) })
  assert.deepEqual(result, { provider: "resend", outcome: "verified" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, RESEND_DOMAINS_URL)
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.redirect, "manual")
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer re_synthetic_not_production")
  assert.ok(calls[0].init.signal)
})

for (const [name, entries] of [
  ["domain pending", [{ name: "mail.example.test", status: "pending" }]],
  ["domain missing", [{ name: "other.test", status: "verified" }]],
  ["only the parent domain verified", [{ name: "example.test", status: "verified" }]],
  ["sending disabled", [{ name: "mail.example.test", status: "verified", capabilities: { sending: "disabled" } }]],
] as const) {
  test(`Resend: ${name} → sender_unverified`, async () => {
    assert.deepEqual(await verifyEmailTransport(resend, { timeoutMs: 1_000, fetch: resendFetch(() => domains([...entries])) }), { provider: "resend", outcome: "sender_unverified" })
  })
}

for (const [status, body, outcome] of [
  [401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails." }, "key_accepted"],
  [401, { statusCode: 401, name: "missing_api_key", message: "Missing API key" }, "auth_failed"],
  [403, { statusCode: 403, name: "restricted_api_key", message: "API key is not active" }, "auth_failed"],
  [400, { statusCode: 400, name: "validation_error", message: "API key is invalid" }, "auth_failed"],
  [429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }, "unexpected_response"],
  [500, { statusCode: 500, name: "application_error", message: "re_synthetic_not_production" }, "unreachable"],
  [503, { statusCode: 503, name: "service_unavailable", message: "unavailable" }, "unreachable"],
  [302, { location: "https://elsewhere.test" }, "unexpected_response"],
] as const) {
  test(`Resend: HTTP ${status} ${"name" in body ? body.name : ""} → ${outcome}`, async () => {
    const result = await verifyEmailTransport(resend, { timeoutMs: 1_000, fetch: resendFetch(() => Response.json(body, { status })) })
    assert.deepEqual(result, { provider: "resend", outcome })
    assert.ok(!JSON.stringify(result).includes("re_synthetic"))
  })
}

test("Resend: network failure, timeout, abort and malformed or oversized bodies are fixed outcomes", async () => {
  assert.deepEqual(await verifyEmailTransport(resend, { timeoutMs: 1_000, fetch: async () => { throw new Error("getaddrinfo ENOTFOUND api.resend.com re_synthetic") } }), { provider: "resend", outcome: "unreachable" })
  let aborted = false
  const hang = async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")) })
  })
  assert.deepEqual(await verifyEmailTransport(resend, { timeoutMs: 10, fetch: hang }), { provider: "resend", outcome: "timeout" })
  assert.equal(aborted, true)
  const controller = new AbortController()
  const pending = verifyEmailTransport(resend, { timeoutMs: 5_000, signal: controller.signal, fetch: hang })
  controller.abort()
  assert.deepEqual(await pending, { provider: "resend", outcome: "timeout" })
  assert.deepEqual(await verifyEmailTransport(resend, { timeoutMs: 1_000, fetch: resendFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } })) }), { provider: "resend", outcome: "unexpected_response" })
  assert.deepEqual(await verifyEmailTransport(resend, { timeoutMs: 1_000, fetch: resendFetch(() => Response.json({ data: "nope" })) }), { provider: "resend", outcome: "unexpected_response" })
  let cancelled = false
  const huge = () => new Response(new ReadableStream<Uint8Array>({ pull(stream) { stream.enqueue(new Uint8Array(65_536).fill(32)) }, cancel() { cancelled = true } }), { headers: { "content-type": "application/json" } })
  assert.deepEqual(await verifyEmailTransport(resend, { timeoutMs: 2_000, fetch: resendFetch(huge) }), { provider: "resend", outcome: "unexpected_response" })
  assert.equal(cancelled, true, "the body is cancelled at the size limit")
})

test("provider selection matches sending: SMTP > Resend > development sink > none", async () => {
  const neverFetch = async () => { throw new Error("must not fetch") }
  assert.deepEqual(await verifyEmailTransport({}, { timeoutMs: 10, fetch: neverFetch }), { provider: "none" })
  assert.deepEqual(await verifyEmailTransport({ devMode: true }, { timeoutMs: 10, fetch: neverFetch }), { provider: "dev" })
  const both = await verifyEmailTransport({ ...resend, smtp: smtp.smtp }, { timeoutMs: 1_000, fetch: neverFetch, createTransport: () => ({ verify: async () => true, close: () => undefined }) })
  assert.deepEqual(both, { provider: "smtp", outcome: "verified" })
})

test("sender domain parsing accepts display names and bare addresses only", () => {
  assert.equal(emailSenderDomain("OpenWork <Team@Mail.Example.Test>"), "mail.example.test")
  assert.equal(emailSenderDomain("team@example.test"), "example.test")
  assert.equal(emailSenderDomain(" \"Ops, Team\" <ops@example.test.> "), "example.test")
  for (const invalid of [undefined, "", "example.test", "@example.test", "team@localhost", "team@exa mple.test", "team@-bad.test"]) assert.equal(emailSenderDomain(invalid), null, String(invalid))
})
