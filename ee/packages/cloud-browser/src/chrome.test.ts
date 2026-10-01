import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCloudBrowser, type CloudBrowser } from "./browser"
import { isRecord, withBrowser } from "./cdp"
import { isCloudBrowserError, type BrowserKey } from "./contract"
import { createLocalBrowserHost, findChrome, type LocalBrowserHost } from "./hosts/local"
import { browserHostConformanceCases } from "./testing"

/**
 * Real-Chrome checks. They run when Chrome or Chromium is installed (or
 * CHROME_PATH points at one) and are skipped otherwise. Chrome resolves the
 * test host to the local server, so the public-address policy stays on.
 */
const chromePath = findChrome()
const describeWithChrome = chromePath ? describe : describe.skip
const SITE = "cloud-browser.example"

const PAGES: Record<string, string> = {
  "/sign-in": `<!doctype html><title>Sign in</title>
    <form onsubmit="return false">
      <label>Email <input id="email" name="email" autocomplete="username"></label>
      <label>Password <input id="password" type="password" name="password"></label>
      <button type="button" id="go" onclick="document.title = 'Signed in as ' + document.getElementById('email').value">Continue</button>
    </form>`,
  "/plain": `<!doctype html><title>Plain page</title>
    <h1>Hello from the cloud browser</h1>
    <input id="search" aria-label="Search" style="display:block;width:300px;height:30px">
    <a href="/sign-in">Sign in</a>
    <div style="height:3000px"></div>
    <button>Far below</button>`,
}

let server: Server
let origin = ""
let profileRoot = ""
let host: LocalBrowserHost
let browser: CloudBrowser
const member: BrowserKey = { organizationId: "org_test", memberId: "om_test" }

function codeOf(error: unknown): string | null {
  return isCloudBrowserError(error) ? error.code : null
}

describeWithChrome("cloud browser against real Chrome", () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0] ?? "/"
      if (path === "/session-cookie") {
        response.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=signed-in; Path=/; HttpOnly" })
        response.end("<!doctype html><title>Signed in</title><p>Welcome back</p>")
        return
      }
      if (path === "/redirect-private") {
        response.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/plain` })
        response.end()
        return
      }
      const page = PAGES[path]
      response.writeHead(page ? 200 : 404, { "content-type": "text/html" })
      response.end(page ?? "<title>Missing</title>")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const port = (server.address() as AddressInfo).port
    origin = `http://${SITE}:${port}`
    profileRoot = mkdtempSync(join(tmpdir(), "owb-test-"))
    host = createLocalBrowserHost({
      chromePath: chromePath ?? undefined,
      profileRoot,
      extraArgs: [`--host-resolver-rules=MAP ${SITE} 127.0.0.1`],
    })
    browser = createCloudBrowser(host)
  })

  afterAll(async () => {
    await host?.close()
    server?.close()
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
  })

  test("status and screen never start a browser", async () => {
    expect(await browser.status(member)).toEqual({ running: false, url: null, title: null })
    expect(await browser.screenshot(member)).toBeNull()
    expect(codeOf(await browser.observe(member).catch((error: unknown) => error))).toBe("not_running")
    expect(await host.peek(member)).toBeNull()
  }, 30_000)

  test("opens, observes and acts on a normal field; refuses the password field", async () => {
    const opened = await browser.open(member, { url: `${origin}/sign-in` })
    expect(opened).toMatchObject({ ok: true, url: `${origin}/sign-in`, title: "Sign in", loaded: true })

    const page = await browser.observe(member)
    expect(page.hasPasswordField).toBe(true)
    expect(page.next).toBe("handoff")
    expect(page.image).toBeUndefined()
    expect(page.imageOmitted).toBe("sign_in_page")
    const email = page.elements.find((element) => element.name === "Email")
    const password = page.elements.find((element) => element.name === "Password")
    const button = page.elements.find((element) => element.name === "Continue")
    expect(email).toMatchObject({ role: "textbox", sensitive: false })
    expect(password).toMatchObject({ role: "textbox", sensitive: true })
    expect(button?.role).toBe("button")
    if (!email || !password || !button) throw new Error("missing controls")

    const refused = await browser.act(member, { observationId: page.observationId, action: { type: "fill", ref: password.ref, text: "hunter2" } }).catch((error: unknown) => error)
    expect(codeOf(refused)).toBe("sign_in_required")
    expect(isCloudBrowserError(refused) && refused.dispatched).toBe(false)

    const fill = await browser.observe(member, { includeImage: false })
    const emailRef = fill.elements.find((element) => element.name === "Email")?.ref ?? ""
    expect(await browser.act(member, { observationId: fill.observationId, action: { type: "fill", ref: emailRef, text: "person@example.com" } }))
      .toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified", retrySafe: false })

    // The observation was consumed by the fill: reusing it is stale, never a replay.
    const replay = await browser.act(member, { observationId: fill.observationId, action: { type: "click", ref: emailRef } }).catch((error: unknown) => error)
    expect(codeOf(replay)).toBe("stale_observation")

    const before = await browser.observe(member, { includeImage: false })
    const continueRef = before.elements.find((element) => element.name === "Continue")?.ref ?? ""
    await browser.act(member, { observationId: before.observationId, action: { type: "click", ref: continueRef } })
    const after = await browser.observe(member, { includeImage: false })
    expect(after.title).toBe("Signed in as person@example.com")
    expect(after.text).not.toContain("hunter2")
  }, 60_000)

  test("observes with a screenshot, scrolls, and reports status", async () => {
    await browser.navigate(member, { url: `${origin}/plain` })
    const page = await browser.observe(member)
    expect(page.title).toBe("Plain page")
    expect(page.text).toContain("Hello from the cloud browser")
    expect(page.moreElements).toBe(false)
    const image = Buffer.from(page.image?.data ?? "", "base64")
    expect(image.subarray(0, 2).toString("hex")).toBe("ffd8")
    expect(page.elements.map((element) => element.name)).toContain("Search")

    await browser.act(member, { observationId: page.observationId, action: { type: "scroll", deltaY: 1200 } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const scrolled = await browser.observe(member, { includeImage: false })
    expect(scrolled.scroll.y).toBeGreaterThan(0)

    expect(await browser.status(member)).toEqual({ running: true, url: `${origin}/plain`, title: "Plain page" })
    const frame = await browser.screenshot(member, { quality: 50 })
    expect(frame?.subarray(0, 2).toString("hex")).toBe("ffd8")
  }, 60_000)

  test("blocks private addresses, including redirects to them", async () => {
    const direct = await browser.navigate(member, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/plain` }).catch((error: unknown) => error)
    expect(codeOf(direct)).toBe("blocked_url")
    const redirected = await browser.navigate(member, { url: `${origin}/redirect-private` }).catch((error: unknown) => error)
    expect(codeOf(redirected)).toBe("blocked_url")
    expect((await browser.status(member)).url).toBe("about:blank")
  }, 60_000)

  test("the person can take over and type their own password", async () => {
    await browser.open(member, { url: `${origin}/sign-in` })
    const page = await browser.observe(member, { includeImage: false })
    const password = page.elements.find((element) => element.sensitive)
    if (!password) throw new Error("missing password field")
    await browser.input(member, [
      { type: "click", x: password.bounds.x + password.bounds.width / 2, y: password.bounds.y + password.bounds.height / 2 },
      { type: "text", text: "s3cret-Pass" },
      { type: "key", key: "Backspace" },
    ])
    const endpoint = await host.peek(member)
    if (!endpoint) throw new Error("browser stopped")
    const value = await withBrowser(endpoint, async (cdp) => {
      const targets = await cdp.send("Target.getTargets")
      const pageTarget = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []).find((target: unknown) => isRecord(target) && target.type === "page" && String(target.url).endsWith("/sign-in"))
      const targetId = isRecord(pageTarget) ? pageTarget.targetId : undefined
      const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true })
      const result = await cdp.send("Runtime.evaluate", { expression: "document.getElementById('password').value", returnByValue: true }, { sessionId: String(attached.sessionId) })
      return isRecord(result.result) ? result.result.value : null
    })
    expect(value).toBe("s3cret-Pas")
    const typed = await browser.observe(member, { includeImage: false })
    expect(JSON.stringify(typed)).not.toContain("s3cret")
  }, 60_000)

  test("remembers sign-in cookies after Done", async () => {
    await browser.open(member, { url: `${origin}/session-cookie` })
    expect(await browser.rememberLogins(member)).toEqual({ remembered: 1 })
    const endpoint = await host.peek(member)
    if (!endpoint) throw new Error("browser stopped")
    const cookies = await withBrowser(endpoint, (cdp) => cdp.send("Storage.getCookies"))
    const sid = (Array.isArray(cookies.cookies) ? cookies.cookies : []).find((cookie: unknown) => isRecord(cookie) && cookie.name === "sid")
    expect(isRecord(sid) && sid.session).toBe(false)
    expect(isRecord(sid) && typeof sid.expires === "number" && sid.expires > Date.now() / 1_000 + 29 * 24 * 3_600).toBe(true)
    expect(isRecord(sid) && sid.domain).toBe(SITE)
  }, 60_000)

  test("live-view frames follow the active tab and stop with the browser", async () => {
    await browser.open(member, { url: `${origin}/plain` })
    const first = await browser.screenshot(member)
    await browser.navigate(member, { url: `${origin}/sign-in` })
    const second = await browser.screenshot(member)
    expect(first?.subarray(0, 2).toString("hex")).toBe("ffd8")
    expect(second?.subarray(0, 2).toString("hex")).toBe("ffd8")
    expect(second?.equals(first ?? Buffer.alloc(0))).toBe(false)
    await host.stop(member)
    expect(await browser.screenshot(member)).toBeNull()
    expect(await browser.status(member)).toEqual({ running: false, url: null, title: null })
  }, 60_000)

  describe("local host conformance", () => {
    for (const conformance of browserHostConformanceCases(() => host)) {
      test(conformance.name, conformance.run, 60_000)
    }
  })
})
