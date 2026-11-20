import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { COMPUTER_INSTALL_SCRIPT, DESKTOP_COMPUTER_INSTALL_SCRIPT, DESKTOP_PYTHON_IMPORTS } from "./image.js"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const listed = read("requirements-desktop.in").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
const pinned = new Set([...read("requirements-desktop.lock").matchAll(/^([A-Za-z0-9._-]+)==\S+ --hash=sha256:/gm)].map((match) => match[1]!.toLowerCase()))

test("every desktop Python package is pinned with hashes and imported when the image is built", () => {
  for (const name of listed) assert.ok(pinned.has(name.toLowerCase()), `${name} is listed but not in requirements-desktop.lock; run node scripts/lock-desktop-python.mjs`)
  assert.deepEqual(Object.keys(DESKTOP_PYTHON_IMPORTS).sort(), [...listed].sort())
  assert.match(DESKTOP_COMPUTER_INSTALL_SCRIPT, new RegExp(`/usr/bin/python3 -c "import ${Object.values(DESKTOP_PYTHON_IMPORTS).join(", ")}"`))
})

test("the computers without a desktop keep their install script, so their default snapshot name does not change", () => {
  assert.doesNotMatch(COMPUTER_INSTALL_SCRIPT, /\/usr\/bin\/python3 -c "import/)
})
