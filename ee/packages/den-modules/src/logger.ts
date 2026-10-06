export interface ModuleLogger {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
  error(event: string, fields: Record<string, unknown>): void
}

function write(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, component: "den-modules", time: new Date().toISOString(), ...fields })
  if (level === "info") console.log(line)
  else if (level === "warn") console.warn(line)
  else console.error(line)
}

/** One JSON line per event on the console. Apps pass their own structured logger. */
export function createConsoleModuleLogger(): ModuleLogger {
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  }
}
