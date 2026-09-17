import { describe, expect, test } from "bun:test"
import {
  checkpointDirectory,
  checkpointRestoreMarkerPath,
  renderCheckpointExistsCommand,
  renderCheckpointFlushCommand,
  renderOpenWorkBootstrapScript,
  renderRestoreMarkerExistsCommand,
  shellQuote,
  type OpenWorkBootstrapConfig,
} from "./openwork-runtime"

const config: OpenWorkBootstrapConfig = {
  dataMountPath: "/persist/openwork",
  workspaceMountPath: "/workspace",
  runtimeDataPath: "/tmp/openwork-data",
  runtimeWorkspacePath: "/tmp/openwork-workspace",
  sidecarDir: "/tmp/openwork-sidecars",
  intervalSeconds: 300,
  keep: 3,
  port: 8787,
  workerId: "worker_01test",
  clientToken: "client-token",
  hostToken: "host's-token",
  activityHeartbeat: { url: "https://den.example/v1/workers/worker_01test/activity-heartbeat", token: "activity-token" },
  runtimeProvider: "fake",
  imageDescription: "fake runtime image",
  rebuildHint: "rebuild the fake image",
}

describe("OpenWork bootstrap renderer", () => {
  test("quotes shell values safely", () => {
    expect(shellQuote("plain")).toBe("'plain'")
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
  })

  test("renders raw script credentials as environment assignments while preserving supervision", () => {
    const script = renderOpenWorkBootstrapScript(config)
    expect(script.startsWith("set -u\n")).toBe(true)
    expect(script).not.toContain("sh -lc")
    expect(script).toContain(`OPENWORK_TOKEN=${shellQuote(config.clientToken)}`)
    expect(script).toContain(`OPENWORK_HOST_TOKEN=${shellQuote(config.hostToken)}`)
    expect(script).toContain(`DEN_ACTIVITY_HEARTBEAT_TOKEN=${shellQuote(config.activityHeartbeat.token)}`)
    expect(script).toContain("DEN_RUNTIME_PROVIDER='fake'")
    expect(script).toContain("DEN_RUNTIME_MANAGED='1'")
    expect(script).toContain("openwork-server binary missing from fake runtime image; rebuild the fake image")
    expect(script).toContain('OPENWORK_STATE_MANIFEST="/tmp/openwork-data /tmp/openwork-workspace $ENGINE_STATE_PATH"')
    expect(script).toContain("trap on_term TERM INT")
    expect(script).toContain('kill -TERM "$server_pid"')
    expect(script).toContain('wait "$server_pid"\n  status=$?')
    expect(script).toContain('while [ "$attempt" -lt 3 ]; do')
    expect(script).toContain("exit 143")
    const hydrateCall = script.indexOf("\nhydrate_checkpoint\n")
    const serverStart = script.indexOf(" openwork-server --workspace")
    expect(hydrateCall).toBeGreaterThan(-1)
    expect(serverStart).toBeGreaterThan(hydrateCall)
    for (const token of [config.clientToken, config.hostToken, config.activityHeartbeat.token]) {
      expect(script.slice(serverStart)).not.toContain(token)
      expect(script.slice(serverStart)).not.toContain(shellQuote(token))
    }
    expect(script).toContain("printf '%s\n' \"$latest_checkpoint\"")
  })

  test("flush and probe commands share the checkpoint layout", () => {
    expect(checkpointDirectory(config)).toBe("/persist/openwork/checkpoints")
    expect(checkpointRestoreMarkerPath(config)).toBe("/tmp/openwork-data/.openwork-restore-marker")
    const flush = renderCheckpointFlushCommand(config)
    expect(flush.startsWith("set -u\n")).toBe(true)
    expect(flush.endsWith("\nflush_checkpoint")).toBe(true)
    expect(flush).toContain("return 1\n}")
    expect(renderCheckpointExistsCommand(config)).toContain("'/persist/openwork/checkpoints'")
    expect(renderRestoreMarkerExistsCommand(config)).toBe("test -s '/tmp/openwork-data/.openwork-restore-marker'")
  })
})
