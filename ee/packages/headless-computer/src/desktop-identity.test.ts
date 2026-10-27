import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { desktopIdentity } from "../scripts/desktop-identity.mjs"

test("only what the guest bundles or the image installs changes the desktop identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-identity-"))
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
  try {
    await put("pkg/src/guest.mjs", "guest")
    await put("node_modules/ws/package.json", JSON.stringify({ name: "ws", version: "8.0.0" }))
    await put("node_modules/ws/index.js", "ws")
    await put("ee/packages/headless-computer/scripts/desktop-bridge.py", "bridge")
    await put("pnpm-lock.yaml", "lock")
    await put("packages/computer-use/native/Sources/Mac.swift", "mac")
    const identity = () => desktopIdentity({ root, workingDirectory: join(root, "pkg"), inputs: ["src/guest.mjs", "../node_modules/ws/index.js"] })
    const original = await identity()

    await put("pnpm-lock.yaml", "another package was added")
    await put("packages/computer-use/native/Sources/Mac.swift", "mac only")
    assert.equal(await identity(), original, "lockfile and Mac-only changes keep the snapshot compatible")

    await put("node_modules/ws/index.js", "same version, different install")
    assert.equal(await identity(), original, "a bundled package counts by its version")

    await put("node_modules/ws/package.json", JSON.stringify({ name: "ws", version: "8.1.0" }))
    const upgraded = await identity()
    assert.notEqual(upgraded, original, "a new version of a bundled package needs a new snapshot")

    await put("pkg/src/guest.mjs", "changed guest")
    const guest = await identity()
    assert.notEqual(guest, upgraded, "bundled guest code needs a new snapshot")

    await put("ee/packages/headless-computer/scripts/desktop-bridge.py", "changed bridge")
    assert.notEqual(await identity(), guest, "files installed in the image need a new snapshot")
  } finally { await rm(root, { recursive: true, force: true }) }
})
