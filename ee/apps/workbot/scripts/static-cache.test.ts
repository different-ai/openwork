import assert from "node:assert/strict"
import { test } from "node:test"
import { isRevalidatedFile } from "../src/server/static-cache.js"

test("the page and the manifest are revalidated on every load; hashed assets and icons are not", () => {
  // "/" resolves to index.html through serveStatic; without no-cache Safari cached it heuristically from Last-Modified.
  assert.equal(isRevalidatedFile("dist/client/index.html"), true)
  assert.equal(isRevalidatedFile("dist/client/manifest.webmanifest"), true)
  assert.equal(isRevalidatedFile("dist/client/assets/index-L0ZLUf2d.js"), false)
  assert.equal(isRevalidatedFile("dist/client/apple-touch-icon.png"), false)
  assert.equal(isRevalidatedFile("dist/client/favicon.svg"), false)
})
