import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"

const accessSource = readFileSync(
  fileURLToPath(new URL("../src/routes/org/plugin-system/access.ts", import.meta.url)),
  "utf8",
)
const storeSource = readFileSync(
  fileURLToPath(new URL("../src/routes/org/plugin-system/store.ts", import.meta.url)),
  "utf8",
)

test("access-list reads keep manager authorization without requiring a fresh session", () => {
  const listAccess = storeSource.slice(
    storeSource.indexOf("export async function listResourceAccess"),
    storeSource.indexOf("type TeamPluginAccessEdge"),
  )

  expect(listAccess).toContain('requireFreshSession: false')
  expect(listAccess).toContain('role: "manager"')
  expect(accessSource).toContain('input.role !== "viewer" && input.requireFreshSession !== false')
})

test("access mutations retain the default fresh-session requirement", () => {
  const mutations = storeSource.slice(
    storeSource.indexOf("export async function createResourceAccessGrant"),
    storeSource.indexOf("async function collectPluginMarketplaces"),
  )

  expect(mutations).toContain("export async function createResourceAccessGrant")
  expect(mutations).toContain("export async function deleteResourceAccessGrant")
  expect(mutations).not.toContain("requireFreshSession: false")
})
