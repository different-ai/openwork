import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import {
  getCliConnectorManifest,
  GITHUB_CLI_DEMO_CATALOG_KEY,
} from "../src/capability-sources/cli-connector-manifests.js"
import type {
  CliRunnerRuntime,
  CliVersionProbeRunner,
} from "../src/cli-runner/daytona-cli-runner.js"

process.env.DB_MODE = "mysql"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32)
process.env.BETTER_AUTH_SECRET = "y".repeat(32)
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"

const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const connectionId = createDenTypeId("cliConnector")
const memberId = createDenTypeId("member")
const now = new Date("2026-08-01T00:00:00.000Z")
const connection = {
  id: connectionId,
  organizationId,
  catalogKey: GITHUB_CLI_DEMO_CATALOG_KEY,
  name: "GitHub CLI Demo",
  manifestVersion: "1.0.0",
  enabled: true,
  createdByOrgMembershipId: memberId,
  createdAt: now,
  updatedAt: now,
}

const store = {
  listEnabledCliConnectors: (requestedOrganizationId: DenTypeId<"organization">) =>
    Promise.resolve(requestedOrganizationId === organizationId ? [connection] : []),
  getCliConnector: (input: {
    organizationId: DenTypeId<"organization">
    connectionId: DenTypeId<"cliConnector">
  }) => Promise.resolve(
    input.organizationId === organizationId && input.connectionId === connectionId
      ? connection
      : null,
  ),
}

let executeVersionProbeWithRuntime: typeof import("../src/cli-runner/daytona-cli-runner.js")["executeVersionProbeWithRuntime"]
let searchCliCapabilitiesWithStore: typeof import("../src/mcp/cli-capabilities.js")["searchCliCapabilitiesWithStore"]
let executeCliCapabilityWithRunner: typeof import("../src/mcp/cli-capabilities.js")["executeCliCapabilityWithRunner"]

before(async () => {
  const [runnerModule, capabilityModule] = await Promise.all([
    import("../src/cli-runner/daytona-cli-runner.js"),
    import("../src/mcp/cli-capabilities.js"),
  ])
  executeVersionProbeWithRuntime = runnerModule.executeVersionProbeWithRuntime
  searchCliCapabilitiesWithStore = capabilityModule.searchCliCapabilitiesWithStore
  executeCliCapabilityWithRunner = capabilityModule.executeCliCapabilityWithRunner
})

describe("GitHub CLI P0 manifest", () => {
  it("pins one reviewed command and immutable release checksums", () => {
    const manifest = getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY)
    assert.ok(manifest)
    assert.deepEqual(manifest.commands.version, {
      id: "version",
      title: "Show GitHub CLI version",
      description: "Report the pinned GitHub CLI version running in OpenWork's hosted sandbox.",
      risk: "read",
      executable: "gh",
      argv: ["--version"],
      timeoutMs: 10_000,
      stdoutLimitBytes: 16_384,
      stderrLimitBytes: 16_384,
    })
    assert.match(manifest.runtime.baseImage, /@sha256:[0-9a-f]{64}$/)
    assert.equal(manifest.runtime.ghVersion, "2.93.0")
    assert.equal(manifest.runtime.releaseAssets.amd64.sha256.length, 64)
    assert.equal(manifest.runtime.releaseAssets.arm64.sha256.length, 64)
    assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY, "2.0.0"), null)
  })
})

describe("hosted CLI runner lifecycle", () => {
  it("runs only the fixed probe, caps output, and always deletes the sandbox", async () => {
    const manifest = getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY)
    if (!manifest) throw new Error("test manifest missing")
    let executedCommand = ""
    let timeoutSeconds = 0
    let deleted = false
    let deleteTimeoutSeconds = 0
    let stdoutChunks = 0
    const runtime: CliRunnerRuntime = {
      createSandbox: () => Promise.resolve({
        id: "sandbox_test",
        process: {
          createSession: () => Promise.resolve(),
          executeSessionCommand: (_sessionId, request, timeout) => {
            executedCommand = request.command
            timeoutSeconds = timeout ?? 0
            return Promise.resolve({ cmdId: "command_test" })
          },
          getSessionCommandLogs: (_sessionId, _commandId, onStdout) => {
            for (let index = 0; index < 20; index += 1) {
              onStdout("x".repeat(1_000))
              stdoutChunks += 1
            }
            return Promise.resolve()
          },
          getSessionCommand: () => Promise.resolve({ exitCode: 0 }),
        },
        delete: (timeout) => {
          deleted = true
          deleteTimeoutSeconds = timeout ?? 0
          return Promise.resolve()
        },
      }),
    }

    const result = await executeVersionProbeWithRuntime(runtime, manifest)

    assert.equal(executedCommand, "gh --version")
    assert.equal(timeoutSeconds, 10)
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.endsWith("[output truncated]"))
    assert.equal(stdoutChunks, 20)
    assert.equal(result.runnerReference, "sandbox_test")
    assert.equal(deleted, true)
    assert.equal(deleteTimeoutSeconds, 30)
  })

  it("deletes the sandbox when command execution fails", async () => {
    const manifest = getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY)
    if (!manifest) throw new Error("test manifest missing")
    let deleted = false
    const runtime: CliRunnerRuntime = {
      createSandbox: () => Promise.resolve({
        id: "sandbox_failure",
        process: {
          createSession: () => Promise.resolve(),
          executeSessionCommand: () => Promise.reject(new Error("probe failed")),
          getSessionCommandLogs: () => Promise.resolve(),
          getSessionCommand: () => Promise.resolve({ exitCode: 0 }),
        },
        delete: () => {
          deleted = true
          return Promise.resolve()
        },
      }),
    }

    await assert.rejects(executeVersionProbeWithRuntime(runtime, manifest), /probe failed/)
    assert.equal(deleted, true)
  })

  it("deletes the sandbox when streamed command logs time out", async () => {
    const manifest = getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY)
    if (!manifest) throw new Error("test manifest missing")
    const shortTimeoutManifest = {
      ...manifest,
      commands: {
        version: { ...manifest.commands.version, timeoutMs: 5 },
      },
    }
    let deleted = false
    const runtime: CliRunnerRuntime = {
      createSandbox: () => Promise.resolve({
        id: "sandbox_timeout",
        process: {
          createSession: () => Promise.resolve(),
          executeSessionCommand: () => Promise.resolve({ cmdId: "command_timeout" }),
          getSessionCommandLogs: () => new Promise(() => undefined),
          getSessionCommand: () => Promise.resolve({ exitCode: 0 }),
        },
        delete: () => {
          deleted = true
          return Promise.resolve()
        },
      }),
    }

    await assert.rejects(
      executeVersionProbeWithRuntime(runtime, shortTimeoutManifest),
      /timed out/,
    )
    assert.equal(deleted, true)
  })
})

describe("CLI capability facade", () => {
  const member = { orgMembershipId: memberId, teamIds: [] }

  it("discovers the enabled org-scoped version command", async () => {
    const matches = await searchCliCapabilitiesWithStore({
      organizationId,
      member,
      query: "github cli version",
      limit: 10,
      enabled: true,
    }, store)

    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.name, `cli:${connectionId}:version`)
    assert.equal(matches[0]?.method, "CLI")
    assert.equal(matches[0]?.risk, "read")
    assert.equal(matches[0]?.hasBody, false)
  })

  it("executes the pinned command and returns a structured envelope", async () => {
    let runnerCalls = 0
    const runner: CliVersionProbeRunner = {
      executeVersionProbe: () => {
        runnerCalls += 1
        return Promise.resolve({
          exitCode: 0,
          stdout: "gh version 2.93.0 (2026-07-29)\n",
          stderr: "",
          durationMs: 321,
          runnerReference: "sandbox_success",
        })
      },
    }
    const manifest = getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY)
    if (!manifest) throw new Error("test manifest missing")

    const result = await executeCliCapabilityWithRunner({
      organizationId,
      member,
      connectionId,
      commandId: "version",
      body: {},
      schemaDigest: manifest.digest,
      enabled: true,
    }, runner, store)

    assert.equal(runnerCalls, 1)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error(result.message)
    assert.equal(result.result.kind, "cli_execution")
    assert.equal(result.result.command, "version")
    assert.equal(result.result.exitCode, 0)
    assert.equal(result.result.stdout, "gh version 2.93.0 (2026-07-29)\n")
  })

  it("fails closed for cross-org ids, arguments, and stale discovery digests", async () => {
    let runnerCalls = 0
    const runner: CliVersionProbeRunner = {
      executeVersionProbe: () => {
        runnerCalls += 1
        return Promise.reject(new Error("must not run"))
      },
    }
    const manifest = getCliConnectorManifest(GITHUB_CLI_DEMO_CATALOG_KEY)
    if (!manifest) throw new Error("test manifest missing")
    const cases = [
      {
        organizationId: otherOrganizationId,
        body: {},
        schemaDigest: manifest.digest,
        expectedError: "unknown_capability",
      },
      {
        organizationId,
        body: { arguments: ["auth", "status"] },
        schemaDigest: undefined,
        expectedError: "invalid_capability_arguments",
      },
      {
        organizationId,
        body: {},
        schemaDigest: undefined,
        expectedError: "invalid_capability_arguments",
      },
      {
        organizationId,
        body: {},
        schemaDigest: "sha256:stale",
        expectedError: "unknown_capability",
      },
    ]

    for (const testCase of cases) {
      const result = await executeCliCapabilityWithRunner({
        organizationId: testCase.organizationId,
        member,
        connectionId,
        commandId: "version",
        body: testCase.body,
        schemaDigest: testCase.schemaDigest,
        enabled: true,
      }, runner, store)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error, testCase.expectedError)
    }
    assert.equal(runnerCalls, 0)
  })
})
