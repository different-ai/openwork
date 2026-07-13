import { describe, expect, test } from "bun:test"
import { createConnection, createServer, type Server } from "node:net"
import { PackageBackedEnterpriseMockLab } from "../src/control-plane.js"
import { ControlPlaneError } from "../src/contracts.js"

const CLIENT_SECRET = "service-now-synthetic-oauth-secret"
const DEN_CALLBACK = "http://127.0.0.1:8790/v1/mcp-connections/connection-123/connect/callback"

async function listenOnEphemeralPort(): Promise<{ port: number; server: Server }> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP address")
  return { port: address.port, server }
}

async function freePort(): Promise<number> {
  const reservation = await listenOnEphemeralPort()
  await new Promise<void>((resolve, reject) => reservation.server.close((error) => error ? reject(error) : resolve()))
  return reservation.port
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(500)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function eventuallyClosed(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isPortOpen(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

describe("package-backed Enterprise Mock Lab", () => {
  test("runs healthy and exact-fault ServiceNow probes, recovers, and closes the listener", async () => {
    const port = await freePort()
    const lab = new PackageBackedEnterpriseMockLab()
    const synthetic = lab.catalog().profiles.find((candidate) => candidate.id === "synthetic-enterprise-oauth-mcp")
    expect(synthetic?.description).toContain("Synthetic standards reference")
    const created = await lab.create({
      clientId: "service-now-local-client",
      clientSecret: CLIENT_SECRET,
      displayName: "ServiceNow contract rehearsal",
      port,
      profileId: "servicenow-inbound-quickstart",
      redirectUris: [DEN_CALLBACK],
    })

    expect(created.state).toBe("stopped")
    expect(created.oauth.redirectUris).toEqual([DEN_CALLBACK])
    expect(JSON.stringify(created)).not.toContain(CLIENT_SECRET)

    const running = await lab.start(created.id)
    expect(running.state).toBe("running")
    expect(running.endpoint?.mcpUrl).toContain("/sncapps/mcp-server/mcp/")
    expect(await isPortOpen(port)).toBe(true)

    const healthy = await lab.probe(created.id)
    expect(healthy.lastProbe).toMatchObject({
      expected: { category: null, firstFailedPhase: null, outcome: "success" },
      matchesExpectation: true,
      observed: { category: null, firstFailedPhase: null, outcome: "success" },
      mode: "fixture-conformance",
      summary: "The probe completed OAuth, MCP initialization, the exact pinned tool-name set, and schema-validity checks. It did not execute a provider tool.",
    })

    const faulted = await lab.updateScenario(created.id, {
      credentialContinuity: "preserve-compatible-oauth",
      expectedRevision: 1,
      faultId: "mcp-version-unsupported",
    })
    expect(faulted.activeFault).toMatchObject({
      expectedCategory: "mcp_version",
      expectedFirstFailedPhase: "MCP_VERSION",
    })

    const failedAsDesigned = await lab.probe(created.id)
    expect(failedAsDesigned.lastProbe).toMatchObject({
      expected: { category: "mcp_version", firstFailedPhase: "MCP_VERSION", outcome: "failure" },
      matchesExpectation: true,
      observed: { category: "mcp_version", firstFailedPhase: "MCP_VERSION", outcome: "failure" },
      summary: "The probe observed the configured failure at the expected first phase and category.",
    })
    expect(failedAsDesigned.events.some((event) => event.category === "fault" && event.phase === "MCP_VERSION")).toBe(true)
    expect(JSON.stringify(failedAsDesigned)).not.toContain(CLIENT_SECRET)

    await lab.updateScenario(created.id, {
      credentialContinuity: "preserve-compatible-oauth",
      expectedRevision: 2,
      faultId: null,
    })
    await lab.reset(created.id)
    const recovered = await lab.probe(created.id)
    expect(recovered.lastProbe?.matchesExpectation).toBe(true)
    expect(recovered.lastProbe?.observed.outcome).toBe("success")

    await lab.remove(created.id)
    expect(lab.get(created.id)).toBeUndefined()
    expect(await eventuallyClosed(port)).toBe(true)
  }, 20_000)

  test("serializes deletion with lifecycle work so a deleted instance cannot resurrect", async () => {
    const firstPort = await freePort()
    const lab = new PackageBackedEnterpriseMockLab()
    const first = await lab.create({
      clientSecret: CLIENT_SECRET,
      displayName: "Start then delete",
      port: firstPort,
      profileId: "servicenow-inbound-quickstart",
    })

    const startThenDelete = await Promise.allSettled([lab.start(first.id), lab.remove(first.id)])
    expect(startThenDelete.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    expect(lab.get(first.id)).toBeUndefined()
    expect(await eventuallyClosed(firstPort)).toBe(true)

    const secondPort = await freePort()
    const second = await lab.create({
      clientSecret: CLIENT_SECRET,
      displayName: "Delete then reject queued start",
      port: secondPort,
      profileId: "servicenow-inbound-quickstart",
    })
    const deleteThenStart = await Promise.allSettled([lab.remove(second.id), lab.start(second.id)])
    expect(deleteThenStart[0]?.status).toBe("fulfilled")
    expect(deleteThenStart[1]?.status).toBe("rejected")
    expect(lab.get(second.id)).toBeUndefined()
    expect(await eventuallyClosed(secondPort)).toBe(true)
  }, 20_000)

  test("requires OAuth secrets only for confidential-client profiles", async () => {
    const lab = new PackageBackedEnterpriseMockLab()
    await expect(lab.create({
      clientSecret: "",
      displayName: "ServiceNow missing secret",
      port: await freePort(),
      profileId: "servicenow-inbound-quickstart",
    })).rejects.toMatchObject({ code: "invalid_request" })

    const workIq = await lab.create({
      clientSecret: "",
      displayName: "Work IQ public client",
      port: await freePort(),
      profileId: "microsoft-work-iq",
    })
    expect(workIq.secretsConfigured.clientSecret).toBe(false)
    expect(workIq.oauth.redirectUris).toEqual(["http://127.0.0.1:19876/mcp/oauth/callback"])
    await lab.start(workIq.id)
    expect((await lab.probe(workIq.id)).lastProbe?.matchesExpectation).toBe(true)
    await lab.remove(workIq.id)
  }, 20_000)

  test("rejects incompatible faults, reserved ports, and operating-system port collisions safely", async () => {
    const reservedPort = await freePort()
    const reservedLab = new PackageBackedEnterpriseMockLab({ reservedPorts: [reservedPort] })
    await expect(reservedLab.create({
      clientSecret: CLIENT_SECRET,
      displayName: "Invalid reserved port",
      port: reservedPort,
      profileId: "servicenow-inbound-quickstart",
    })).rejects.toMatchObject({ code: "conflict" })

    const incompatiblePort = await freePort()
    await expect(reservedLab.create({
      clientSecret: CLIENT_SECRET,
      displayName: "Incompatible profile fault",
      faultId: "oauth-dynamic-registration-unsupported",
      port: incompatiblePort,
      profileId: "microsoft-work-iq",
    })).rejects.toMatchObject({ code: "invalid_request" })

    const collision = await listenOnEphemeralPort()
    const colliding = await reservedLab.create({
      clientSecret: CLIENT_SECRET,
      displayName: "External port collision",
      port: collision.port,
      profileId: "servicenow-inbound-quickstart",
    })
    try {
      await expect(reservedLab.start(colliding.id)).rejects.toBeInstanceOf(ControlPlaneError)
      const view = reservedLab.get(colliding.id)
      expect(view?.state).toBe("failed")
      expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET)
    } finally {
      await new Promise<void>((resolve, reject) => collision.server.close((error) => error ? reject(error) : resolve()))
      await reservedLab.remove(colliding.id)
    }
  }, 20_000)
})
