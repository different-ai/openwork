import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)

test("installed default exports run as JavaScript inside node_modules and resolve standalone declarations", async () => {
  const directory = await mkdtemp(fileURLToPath(new URL("./.package-test-", import.meta.url)))
  try {
    const installed = join(directory, "node_modules", "@openwork", "remote-sessions")
    await mkdir(installed, { recursive: true })
    await cp(new URL("../package.json", import.meta.url), join(installed, "package.json"))
    await cp(new URL("../dist", import.meta.url), join(installed, "dist"), { recursive: true })
    await cp(new URL("../src", import.meta.url), join(installed, "src"), { recursive: true })
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(join(directory, "consumer.mjs"), `
      import assert from "node:assert/strict"
      import { emptyJournal, sessionIdForCommand, stableMessageId, createSessionRunner } from "@openwork/remote-sessions"
      import { createRemoteSessionTransport } from "@openwork/remote-sessions/remote-client"
      assert.equal(import.meta.resolve("@openwork/remote-sessions").endsWith("/dist/index.js"), true)
      assert.equal(import.meta.resolve("@openwork/remote-sessions/remote-client").endsWith("/dist/remote-client.js"), true)
      assert.equal(sessionIdForCommand("cmd_test-1"), "ses_cmdtest1")
      assert.equal(stableMessageId("cmd_test-1"), "msg_cmdtest1")
      assert.equal(emptyJournal().version, 1)
      assert.equal(typeof createSessionRunner, "function")
      assert.equal(typeof createRemoteSessionTransport, "function")
    `)
    await run(process.execPath, [join(directory, "consumer.mjs")], { cwd: directory, env: { ...process.env, NODE_OPTIONS: "" } })
    await rm(join(installed, "src"), { recursive: true, force: true }) // Declarations must be self-contained even without source.
    await mkdir(join(directory, "types"))
    await writeFile(join(directory, "consumer.mts"), `
      import { createSessionRunner, sessionIdForCommand } from "@openwork/remote-sessions"
      import type { HarnessAdapter, ReadResult } from "@openwork/remote-sessions"
      import { createRemoteSessionTransport } from "@openwork/remote-sessions/remote-client"
      const capability: HarnessAdapter["creation"] = "idempotent"
      const replay: HarnessAdapter["sendReplay"] = "at_most_once"
      const scope: ReadResult["historyScope"] = "context"
      const id: string = sessionIdForCommand("command")
      const transport = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => null })
      void [capability, replay, scope, id, transport, createSessionRunner]
    `)
    const compiler = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url))
    const result = await run(process.execPath, [compiler, "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext",
      "--target", "ES2023", "--lib", "ES2023,DOM", "--typeRoots", join(directory, "types"), join(directory, "consumer.mts")], { cwd: directory })
    assert.equal(result.stderr, "")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
