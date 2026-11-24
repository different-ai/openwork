import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"

export type Io = {
  env: Record<string, string | undefined>
  homeDir: string
  interactive: boolean
  out(text: string): void
  err(text: string): void
  confirm(question: string): Promise<boolean>
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
}

export class CliError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function processIo(): Io {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI
  return {
    env: process.env,
    homeDir: homedir(),
    interactive,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    confirm: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = await prompt.question(`${question} [y/N] `)
        return /^y(es)?$/i.test(answer.trim())
      } finally {
        prompt.close()
      }
    },
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
