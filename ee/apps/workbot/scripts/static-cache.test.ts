import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { getRequestListener } from "@hono/node-server"
import { Hono } from "hono"
import type { AppEnv } from "../src/server/auth.js"
import { isRevalidatedFile, registerClientFiles } from "../src/server/static-cache.js"

test("the page and the manifest are revalidated on every load; hashed assets and icons are not", () => {
  // "/" resolves to index.html through serveStatic; without no-cache Safari cached it heuristically from Last-Modified.
  assert.equal(isRevalidatedFile("dist/client/index.html"), true)
  assert.equal(isRevalidatedFile("dist/client/manifest.webmanifest"), true)
  assert.equal(isRevalidatedFile("dist/client/assets/index-L0ZLUf2d.js"), false)
  assert.equal(isRevalidatedFile("dist/client/apple-touch-icon.png"), false)
  assert.equal(isRevalidatedFile("dist/client/favicon.svg"), false)
})

test("a hashed file from another release is a 404, never the page; any other unknown path is the page", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "workbot-client-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "assets"))
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Workbot</title>")
  await writeFile(join(dir, "assets", "index-current.js"), "export {}")
  const app = new Hono<AppEnv>()
  registerClientFiles(app, dir)
  // Through the listener the server runs on: it is what puts the files' Cache-Control on the response.
  const server = createServer(getRequestListener(app.fetch))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  const get = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`)

  const current = await get("/assets/index-current.js")
  assert.equal(current.status, 200)
  assert.equal(current.headers.get("cache-control"), "public, max-age=31536000, immutable")
  assert.equal(await current.text(), "export {}")

  // A tab left open across a deploy asks for the script it was built with.
  for (const path of ["/assets/index-previous.js", "/assets/calendar-previous.js", "/assets/"]) {
    const gone = await get(path)
    assert.equal(gone.status, 404, path)
    assert.doesNotMatch(gone.headers.get("content-type") ?? "", /html/, path)
    assert.equal(gone.headers.get("cache-control"), "no-store", path)
    assert.doesNotMatch(await gone.text(), /<title>/, path)
  }

  for (const path of ["/", "/calendar", "/documents/folder/file", "/assets-guide"]) {
    const page = await get(path)
    assert.equal(page.status, 200, path)
    assert.match(page.headers.get("content-type") ?? "", /text\/html/, path)
    assert.equal(page.headers.get("cache-control"), "no-cache", path)
    assert.match(await page.text(), /<title>Workbot<\/title>/, path)
  }
})
