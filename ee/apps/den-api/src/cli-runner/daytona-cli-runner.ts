import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { Daytona, Image } from "@daytonaio/sdk"
import type { ResolvedCliConnectorManifest } from "../capability-sources/cli-connector-manifests.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"

const logger = appLogger.child({ component: "daytona_cli_runner" })
const VERSION_PROBE_COMMAND = "gh --version"
const CLI_SANDBOX_CREATE_TIMEOUT_SECONDS = 120
const CLI_SANDBOX_DELETE_TIMEOUT_SECONDS = 30

export type CliVersionProbeResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  runnerReference: string
}

export type CliVersionProbeRunner = {
  executeVersionProbe(manifest: ResolvedCliConnectorManifest): Promise<CliVersionProbeResult>
}

export type CliRunnerSandbox = {
  id: string
  process: {
    createSession(sessionId: string): Promise<void>
    executeSessionCommand(
      sessionId: string,
      request: { command: string; runAsync: true; suppressInputEcho: true },
      timeoutSeconds?: number,
    ): Promise<{ cmdId: string }>
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void>
    getSessionCommand(sessionId: string, commandId: string): Promise<{ exitCode?: number }>
  }
  delete(timeoutSeconds?: number): Promise<unknown>
}

export type CliRunnerRuntime = {
  createSandbox(manifest: ResolvedCliConnectorManifest): Promise<CliRunnerSandbox>
}

export class CliRunnerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliRunnerUnavailableError"
  }
}

export class CliRunnerExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliRunnerExecutionError"
  }
}

function cappedUtf8Collector(maxBytes: number) {
  const chunks: string[] = []
  let byteLength = 0
  let truncated = false
  return {
    append(value: string) {
      if (byteLength >= maxBytes) {
        truncated = truncated || value.length > 0
        return
      }
      const bytes = Buffer.from(value, "utf8")
      const remaining = maxBytes - byteLength
      const accepted = bytes.subarray(0, remaining)
      if (accepted.byteLength > 0) chunks.push(accepted.toString("utf8"))
      byteLength += accepted.byteLength
      truncated = truncated || bytes.byteLength > accepted.byteLength
    },
    value() {
      const text = chunks.join("")
      return truncated ? `${text}\n[output truncated]` : text
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CliRunnerExecutionError("The hosted CLI version probe timed out")),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function fixedVersionProbeCommand(manifest: ResolvedCliConnectorManifest): string {
  const command = manifest.commands.version
  if (command.executable !== "gh" || command.argv.length !== 1 || command.argv[0] !== "--version") {
    throw new CliRunnerExecutionError("The pinned CLI manifest does not contain the reviewed version probe")
  }
  return VERSION_PROBE_COMMAND
}

function githubCliImage(manifest: ResolvedCliConnectorManifest): Image {
  const { amd64, arm64 } = manifest.runtime.releaseAssets
  const installCommand = [
    "set -eu",
    "arch=$(dpkg --print-architecture)",
    `case \"$arch\" in amd64) url='${amd64.url}'; checksum='${amd64.sha256}';; arm64) url='${arm64.url}'; checksum='${arm64.sha256}';; *) echo \"Unsupported architecture: $arch\" >&2; exit 1;; esac`,
    "curl -fsSLo /tmp/gh.tar.gz \"$url\"",
    "echo \"$checksum  /tmp/gh.tar.gz\" | sha256sum -c -",
    `tar -xzf /tmp/gh.tar.gz -C /tmp`,
    `install -m 0755 /tmp/gh_${manifest.runtime.ghVersion}_linux_\"$arch\"/bin/gh /usr/local/bin/gh`,
    "rm -rf /tmp/gh.tar.gz /tmp/gh_*",
  ].join(" && ")

  return Image
    .base(manifest.runtime.baseImage)
    .runCommands(
      "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*",
      installCommand,
    )
}

function createDaytonaCliRuntime(): CliRunnerRuntime {
  if (!env.daytona.apiKey) {
    throw new CliRunnerUnavailableError("DAYTONA_API_KEY is required for hosted CLI connectors")
  }
  const daytona = new Daytona({
    apiKey: env.daytona.apiKey,
    apiUrl: env.daytona.apiUrl,
    ...(env.daytona.target ? { target: env.daytona.target } : {}),
  })
  return {
    createSandbox: (manifest) => daytona.create({
      name: `openwork-cli-gh-version-${randomUUID()}`.slice(0, 63),
      image: githubCliImage(manifest),
      public: false,
      ephemeral: true,
      autoStopInterval: 0,
      autoArchiveInterval: 0,
      autoDeleteInterval: 0,
      networkBlockAll: true,
      envVars: {
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
      },
      resources: { cpu: 1, memory: 1, disk: 3 },
    }, { timeout: Math.min(env.daytona.createTimeoutSeconds, CLI_SANDBOX_CREATE_TIMEOUT_SECONDS) }),
  }
}

export async function executeVersionProbeWithRuntime(
  runtime: CliRunnerRuntime,
  manifest: ResolvedCliConnectorManifest,
): Promise<CliVersionProbeResult> {
  let sandbox: CliRunnerSandbox | null = null
  const startedAt = Date.now()
  try {
    sandbox = await runtime.createSandbox(manifest)
    const command = manifest.commands.version
    const sessionId = `gh-version-${randomUUID()}`
    await sandbox.process.createSession(sessionId)
    const response = await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command: fixedVersionProbeCommand(manifest),
        runAsync: true,
        suppressInputEcho: true,
      },
      Math.ceil(command.timeoutMs / 1_000),
    )
    const stdout = cappedUtf8Collector(command.stdoutLimitBytes)
    const stderr = cappedUtf8Collector(command.stderrLimitBytes)
    await withTimeout(
      sandbox.process.getSessionCommandLogs(
        sessionId,
        response.cmdId,
        (chunk) => stdout.append(chunk),
        (chunk) => stderr.append(chunk),
      ),
      command.timeoutMs,
    )
    const completedCommand = await sandbox.process.getSessionCommand(sessionId, response.cmdId)
    if (typeof completedCommand.exitCode !== "number") {
      throw new CliRunnerExecutionError("The hosted CLI version probe ended without an exit code")
    }
    return {
      exitCode: completedCommand.exitCode,
      stdout: stdout.value(),
      stderr: stderr.value(),
      durationMs: Date.now() - startedAt,
      runnerReference: sandbox.id,
    }
  } catch (error) {
    if (error instanceof CliRunnerUnavailableError || error instanceof CliRunnerExecutionError) throw error
    throw new CliRunnerExecutionError(error instanceof Error ? error.message : "Hosted CLI execution failed")
  } finally {
    if (sandbox) {
      try {
        await sandbox.delete(Math.min(env.daytona.deleteTimeoutSeconds, CLI_SANDBOX_DELETE_TIMEOUT_SECONDS))
      } catch (error) {
        logger.error("cli_connector_sandbox_cleanup_failed", {
          runner_reference: sandbox.id,
          error: error instanceof Error ? error.message : "unknown cleanup error",
        })
      }
    }
  }
}

export const daytonaCliRunner: CliVersionProbeRunner = {
  async executeVersionProbe(manifest) {
    let runtime: CliRunnerRuntime
    try {
      runtime = createDaytonaCliRuntime()
    } catch (error) {
      if (error instanceof CliRunnerUnavailableError) throw error
      throw new CliRunnerUnavailableError(error instanceof Error ? error.message : "Daytona is unavailable")
    }
    return executeVersionProbeWithRuntime(runtime, manifest)
  },
}
