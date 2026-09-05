import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"

type DaytonaModule = typeof import("../src/workers/daytona.js")

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DAYTONA_API_KEY = "daytona-test-key"
  process.env.DAYTONA_RUNTIME_DATA_PATH = "/tmp/openwork-data"
  process.env.DAYTONA_RUNTIME_WORKSPACE_PATH = "/tmp/openwork-workspace"
  process.env.DAYTONA_DATA_MOUNT_PATH = "/persist/openwork"
  process.env.DAYTONA_WORKSPACE_MOUNT_PATH = "/workspace"
  process.env.DAYTONA_SIDECAR_DIR = "/tmp/openwork-sidecars"
  process.env.DEN_CKPT_INTERVAL_SECONDS = "300"
  process.env.DEN_CKPT_KEEP = "3"
}

let daytona: DaytonaModule

beforeAll(async () => {
  seedRequiredEnv()
  daytona = await import("../src/workers/daytona.js")
})

describe("Daytona OpenWork checkpoint start command", () => {
  test("keeps checkpoint seams and safety invariants in the sandbox script", () => {
    const command = daytona.buildOpenWorkStartCommand({
      workerId: createDenTypeId("worker"),
      name: "Cloud",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    })

    expect(command).toContain("OPENWORK_STATE_MANIFEST=")
    // The engine keeps sessions in opencode.db on the container overlay. It was
    // missing from the manifest, so every recycle onto a new snapshot started
    // the user from scratch.
    expect(command).toContain("ENGINE_STATE_PATH=${OPENWORK_ENGINE_STATE_PATH:-$HOME/.local/share/opencode}")
    expect(command).toContain('OPENWORK_STATE_MANIFEST="/tmp/openwork-data /tmp/openwork-workspace $ENGINE_STATE_PATH"')
    // Collapse the WAL first so the copied database is self-consistent.
    expect(command).toContain("PRAGMA wal_checkpoint(TRUNCATE)")
    // Credentials are re-materialized every start; never persist them to the volume.
    expect(command).toContain('--exclude="${ENGINE_STATE_PATH#/}/auth.json"')
    expect(command).toContain('--exclude="${ENGINE_STATE_PATH#/}/log"')
    expect(command).toContain("/tmp/openwork-data /tmp/openwork-workspace")
    expect(command).toContain("CHECKPOINT_DIR=")
    expect(command).toContain("/persist/openwork/checkpoints")
    expect(command).toContain("hydrate_checkpoint")
    expect(command).toContain("flush_checkpoint")
    expect(command).toContain("trap on_term TERM INT")
    expect(command).toContain("DEN_CKPT_KEEP")
    expect(command).toContain("find \"$CHECKPOINT_DIR\" -maxdepth 1 -type f -name")
    expect(command).toContain("ckpt-*.tar")
    expect(command).toContain("-cf \"$tmp_checkpoint\"")
    expect(command).toContain("tar -C / -xf")
    expect(command).not.toContain("tar -h")
    expect(command).not.toContain("tar -ch")
    expect(command).toContain("--approval auto")
    expect(command).not.toContain("--approval manual")

    const hydrateCall = command.indexOf("\nhydrate_checkpoint\n")
    const serverStart = command.indexOf(" openwork-server --workspace")
    expect(hydrateCall).toBeGreaterThan(-1)
    expect(serverStart).toBeGreaterThan(hydrateCall)
  })
})
