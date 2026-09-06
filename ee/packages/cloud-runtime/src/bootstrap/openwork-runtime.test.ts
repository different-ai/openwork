import { describe, expect, test } from "bun:test"
import {
  checkpointDirectory,
  checkpointRestoreMarkerPath,
  renderCheckpointExistsCommand,
  renderCheckpointFlushCommand,
  renderOpenWorkBootstrapCommand,
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

  test("renders the supervised server with hydrate before start and flush on exit", () => {
    const command = renderOpenWorkBootstrapScript(config)
    expect(renderOpenWorkBootstrapCommand(config)).toBe(`sh -lc ${shellQuote(command)}`)
    expect(command.startsWith("set -u\n")).toBe(true)
    expect(command).toContain(`OPENWORK_HOST_TOKEN='host'"'"'s-token'`)
    expect(command).toContain("DEN_RUNTIME_PROVIDER='fake'")
    expect(command).toContain("openwork-server binary missing from fake runtime image; rebuild the fake image")
    expect(command).toContain('OPENWORK_STATE_MANIFEST="/tmp/openwork-data /tmp/openwork-workspace $ENGINE_STATE_PATH"')
    expect(command).toContain("trap on_term TERM INT")
    const hydrateCall = command.indexOf("\nhydrate_checkpoint\n")
    const serverStart = command.indexOf(" openwork-server --workspace")
    expect(hydrateCall).toBeGreaterThan(-1)
    expect(serverStart).toBeGreaterThan(hydrateCall)
    // The restore marker is written with a real newline, matching the shell the
    // script has always produced.
    expect(command).toContain("printf '%s\n' \"$latest_checkpoint\"")
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
