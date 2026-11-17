import {
  bucketOperationalUptime,
  operationalComponentStateSchema,
  operationalDiagnosticSnapshotSchema,
  operationalSnapshotMinute,
  type OperationalComponentState,
  type OperationalDiagnosticsConfig,
  type OperationalDiagnosticSnapshot,
} from "@openwork/types/operational-diagnostics"

type Components = OperationalDiagnosticSnapshot["components"]
type Producers = Partial<Record<keyof Components, () => OperationalComponentState | Promise<OperationalComponentState>>>

type Dependencies = {
  version: string
  deploymentKind?: OperationalDiagnosticSnapshot["deploymentKind"]
  producers?: Producers
  uptime?: () => number
  now?: () => Date
  write?: (line: string) => void
  schedule?: typeof setInterval
}

export async function emitOperationalDiagnosticSnapshot(deps: Dependencies): Promise<void> {
  try {
    const state = async (name: keyof Components): Promise<OperationalComponentState> => {
      try {
        return operationalComponentStateSchema.parse(await deps.producers?.[name]?.())
      } catch {
        return "unknown"
      }
    }
    const [database, migrations, worker, engine, localServer] = await Promise.all([
      state("database"), state("migrations"), state("worker"), state("engine"), state("localServer"),
    ])
    const snapshot = operationalDiagnosticSnapshotSchema.safeParse({
      schemaVersion: 1,
      version: deps.version,
      instanceKind: "den-api",
      ...(deps.deploymentKind ? { deploymentKind: deps.deploymentKind } : {}),
      uptimeSeconds: bucketOperationalUptime((deps.uptime ?? process.uptime)()),
      snapshotTime: operationalSnapshotMinute((deps.now ?? (() => new Date()))()),
      components: { database, migrations, worker, engine, localServer },
    })
    if (snapshot.success) {
      (deps.write ?? ((line) => { process.stdout.write(line) }))(`OPENWORK_OPERATIONAL_DIAGNOSTIC ${JSON.stringify(snapshot.data)}\n`)
    }
  } catch {
    return
  }
}

export function startOperationalDiagnostics(config: OperationalDiagnosticsConfig | undefined, deps: Dependencies): () => void {
  if (!config?.enabled || config.output !== "stdout") return () => {}
  let running = false
  let stopped = false
  const emit = async () => {
    if (running || stopped) return
    running = true
    await emitOperationalDiagnosticSnapshot({ ...deps, write: (line) => {
      if (!stopped) (deps.write ?? ((value) => { process.stdout.write(value) }))(line)
    } })
    running = false
  }
  const timer = (deps.schedule ?? setInterval)(() => { void emit() }, config.intervalMinutes * 60_000)
  timer.unref()
  void emit()
  return () => { stopped = true; clearInterval(timer) }
}
