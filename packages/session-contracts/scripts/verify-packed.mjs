import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryRoot = mkdtempSync(join(tmpdir(), "openwork-session-contracts-pack-"))

try {
  execFileSync("pnpm", ["pack", "--pack-destination", temporaryRoot], {
    cwd: packageRoot,
    stdio: "pipe",
  })
  const archive = readdirSync(temporaryRoot).find((entry) => entry.endsWith(".tgz"))
  assert.ok(archive, "pnpm pack must create an archive")

  const installedPackage = join(
    temporaryRoot,
    "node_modules",
    "@openwork",
    "session-contracts",
  )
  mkdirSync(installedPackage, { recursive: true })
  execFileSync("tar", ["-xzf", join(temporaryRoot, archive), "--strip-components=1", "-C", installedPackage])

  const require = createRequire(import.meta.url)
  const zodPackage = dirname(realpathSync(require.resolve("zod/package.json")))
  const temporaryNodeModules = join(temporaryRoot, "node_modules")
  symlinkSync(zodPackage, join(temporaryNodeModules, "zod"), "dir")

  const packedManifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"))
  assert.equal(packedManifest.exports["."].default, "./dist/index.js")
  assert.equal(packedManifest.dependencies.zod, "4.3.6")

  const consumer = join(temporaryRoot, "consumer.mjs")
  writeFileSync(consumer, `
    import assert from "node:assert/strict";
    import {
      validateOpenWorkSessionList,
      validateOpenWorkSessionSnapshot,
      validateOpenWorkSessionStreamFrame,
    } from "@openwork/session-contracts";

    const session = { id: "ses_packed", passthrough: true };
    const list = validateOpenWorkSessionList([session]);
    assert.equal(list.ok, true);
    assert.equal(list.value[0].passthrough, true);

    const snapshot = validateOpenWorkSessionSnapshot({
      session,
      messages: [],
      todos: [],
      status: { type: "idle" },
    });
    assert.equal(snapshot.ok, true);

    const frame = validateOpenWorkSessionStreamFrame({
      schemaVersion: 1,
      kind: "event",
      workspaceId: "workspace-packed",
      source: { adapterId: "builtin/opencode", eventType: "session.updated" },
      event: { kind: "session.updated", sessionId: session.id, info: session },
    });
    assert.equal(frame.ok, true);
  `)
  execFileSync(process.execPath, [consumer], { cwd: temporaryRoot, stdio: "inherit" })
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
