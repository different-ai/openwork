import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { COMPUTER_INSTALL_SCRIPT, DESKTOP_COMPUTER_INSTALL_SCRIPT, DESKTOP_NODE_PACKAGES, DESKTOP_NODE_PATH, DESKTOP_PYTHON_IMPORTS } from "./image.js"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const listed = read("requirements-desktop.in").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
const pinned = new Set([...read("requirements-desktop.lock").matchAll(/^([A-Za-z0-9._-]+)==\S+ --hash=sha256:/gm)].map((match) => match[1]!.toLowerCase()))

test("every desktop Python package is pinned with hashes and imported when the image is built", () => {
  for (const name of listed) assert.ok(pinned.has(name.toLowerCase()), `${name} is listed but not in requirements-desktop.lock; run node scripts/lock-desktop-python.mjs`)
  assert.deepEqual(Object.keys(DESKTOP_PYTHON_IMPORTS).sort(), [...listed].sort())
  assert.match(DESKTOP_COMPUTER_INSTALL_SCRIPT, new RegExp(`/usr/bin/python3 -c "import ${Object.values(DESKTOP_PYTHON_IMPORTS).join(", ")}"`))
})

test("every desktop Node package is locked with integrity, installed from the lock, required at build, and on NODE_PATH for commands", () => {
  const manifest = JSON.parse(read("desktop-node-packages.json")) as { dependencies: Record<string, string> }
  const lock = JSON.parse(read("desktop-node-packages.lock.json")) as { packages: Record<string, { version?: string; integrity?: string }> }
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [...DESKTOP_NODE_PACKAGES].sort())
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} is not locked at ${version}; run node scripts/lock-desktop-node.mjs`)
  }
  for (const [path, entry] of Object.entries(lock.packages)) if (path) assert.ok(entry.integrity, `${path} has no integrity hash`)
  // sharp's native builds for both server architectures.
  for (const path of ["@img/sharp-linux-x64", "@img/sharp-linux-arm64"]) assert.ok(lock.packages[`node_modules/${path}`]?.integrity)
  assert.match(DESKTOP_COMPUTER_INSTALL_SCRIPT, /npm ci --prefix \/usr\/local\/lib\/openwork-node --omit=dev --ignore-scripts/)
  assert.ok(DESKTOP_COMPUTER_INSTALL_SCRIPT.includes(`NODE_PATH=${DESKTOP_NODE_PATH} node -e 'for (const name of ${JSON.stringify(DESKTOP_NODE_PACKAGES)}) require(name)'`))
  assert.ok(read("scripts/desktop-bridge.py").includes(`'NODE_PATH': '${DESKTOP_NODE_PATH}'`))
  for (const file of ["Dockerfile.desktop", "scripts/build-freestyle-desktop-snapshot.ts", "scripts/desktop-identity.mjs"]) {
    assert.ok(read(file).includes("desktop-node-packages.lock.json"), `${file} does not carry the Node lock`)
  }
})

test("the computers without a desktop keep their install script, so their default snapshot name does not change", () => {
  assert.doesNotMatch(COMPUTER_INSTALL_SCRIPT, /\/usr\/bin\/python3 -c "import|openwork-node/)
})
