const DEVELOPMENT_CONDITIONS_REEXEC = "OPENWORK_DEN_DEVELOPMENT_CONDITIONS_REEXEC"

export {}

async function runWithDevelopmentConditions() {
  // Clean dev/eval checkouts may not have workspace-package dist artifacts.
  // Re-exec once so package exports resolve their TypeScript source entries.
  const { spawn } = await import("node:child_process")
  const child = spawn(
    process.execPath,
    [...process.execArgv, "--conditions=development", ...process.argv.slice(1)],
    {
      env: { ...process.env, [DEVELOPMENT_CONDITIONS_REEXEC]: "1" },
      stdio: "inherit",
    },
  )
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal)
  for (const signal of signals) process.on(signal, forwardSignal)

  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })

  for (const signal of signals) process.off(signal, forwardSignal)
}

if (process.env.OPENWORK_DEV_MODE === "1" && process.env[DEVELOPMENT_CONDITIONS_REEXEC] !== "1") {
  await runWithDevelopmentConditions()
} else {
  await import("./observability/preload.js")
  await import("./server.js")
}
