import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

/**
 * Real WorkbotScreen, deterministic API timing; no Den, runner or external services.
 * Start: pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3097
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs pnpm --filter @openwork-ee/workbot test:scroll-browser
 * SCROLL_BROWSER=webkit checks the same iPhone-size touch layout in WebKit; default Chromium emulates a phone.
 * SCROLL_BASELINE=1 runs the unflagged bug checks against a clean base fixture; expected red before the fix.
 * WORKBOT_EVIDENCE_DIR controls screenshot output; nothing is uploaded by this test.
 */
const requireEvals = createRequire(fileURLToPath(new URL("../../../../evals/package.json", import.meta.url)))
const { chromium, webkit } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? requireEvals.resolve("playwright")).href)
const browser = await (process.env.SCROLL_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true })
// Mobile WebKit does not expose wheel input in Playwright; touch + iPhone dimensions still exercises its layout/viewport code.
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: process.env.SCROLL_BROWSER !== "webkit", hasTouch: true, colorScheme: "light" })
const page = await context.newPage()
const base = process.env.WORKBOT_FIXTURE_URL ?? "http://localhost:3097"
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Only a loopback fixture may receive these test requests")
const out = process.env.WORKBOT_EVIDENCE_DIR ?? "node_modules/.cache/scroll-evidence"
await mkdir(out, { recursive: true })
const failures = []
const errors = []
page.on("pageerror", error => errors.push(error.message))
const now = Date.now() - 60_000
const makeTurn = (n, text = `Reply ${n}. ${"Here is the update for this part of the plan. ".repeat(8)}`) => ({ id: `scroll-${n}`, text: `Question ${n}`, sentAt: now + n, finishedAt: now + n + 1, status: "done", attachments: [], parts: [{ kind: "text", text }], modelSteps: 1, error: null })
const turns = Array.from({ length: 38 }, (_, n) => makeTurn(n))
let extra = ""
let rich = false
let imageRequested = false
let releaseImage
let reads = []
let releaseFirst
let holdFirst = false
const thread = count => ({ available: true, name: "Workbot", organizationName: "Example Team", status: "busy", filesEnabled: true, hasEarlier: count < turns.length, turns: turns.slice(-count).map((turn, i, list) => {
  if (i !== list.length - 1) return turn
  const parts = extra ? [{ kind: "text", text: extra }] : turn.parts
  if (!rich) return { ...turn, parts }
  return { ...turn, status: "working", attachments: [{ id: "scroll-photo", name: "Plan.png", mediaType: "image/png", size: 68 }], parts: [...parts, { kind: "steps", steps: [{ label: "Opening Example Domain", icon: "computer", surface: "browser", status: "running", app: null, startedAt: now, finishedAt: null, updates: ["Reading the page"], shown: true, pages: [{ id: "scroll-page", title: "Example Domain", url: "https://example.com" }] }] }] }
}) })
await page.route("**/v1/workbot/events*", route => route.abort())
await page.route(/\/v1\/workbot\?/, async route => {
  const count = Number(new URL(route.request().url()).searchParams.get("turns") ?? 8)
  reads.push(count)
  if (holdFirst) { holdFirst = false; await new Promise(resolve => { releaseFirst = resolve }) }
  await route.fulfill({ json: thread(count) }).catch(() => {})
})
await page.route("**/v1/workbot/files/scroll-photo?*", async route => {
  imageRequested = true
  await new Promise(resolve => { releaseImage = resolve })
  await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgWQAAAAASUVORK5CYII=", "base64") }).catch(() => {})
})
const geometry = () => page.locator(".workbot-scroll").filter({ visible: true }).first().evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, gap: node.scrollHeight - node.clientHeight - node.scrollTop }))
const atBottom = async label => {
  await page.waitForFunction(() => {
    const node = [...document.querySelectorAll(".workbot-scroll")].find(node => node.clientHeight > 0)
    return node && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 2
  }, undefined, { timeout: 7000 })
  console.log(label, await geometry())
}
const check = async (name, run) => {
  try { await run(); console.log(`PASS: ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}: ${error.message}`); await page.screenshot({ path: `${out}/${name.replaceAll(/[^a-z0-9]+/gi, "-")}-failed.png` }) }
}
const open = async query => {
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded" })
  await page.locator("[data-workbot-composer]").waitFor()
  await page.locator('[data-workbot-row="scroll-37"]').waitFor()
  await page.evaluate(() => document.fonts.ready)
}
try {
  await check("cold open and background earlier page land on newest", async () => {
    await open("scenario=bubbles")
    await page.waitForFunction(() => document.querySelectorAll("[data-workbot-row]").length === 30)
    await atBottom("cold / 8 then 30")
    assert.deepEqual(reads.slice(0, 2), [8, 30])
  })
  await check("late reply growth stays pinned", async () => {
    extra = `The latest answer. ${"A new section arrived after the first render. ".repeat(50)}`
    await page.waitForFunction(() => document.body.textContent.includes("The latest answer."))
    await atBottom("late reply")
  })
  await check("keyboard viewport shrink stays on newest", async () => {
    const fullHeight = (await geometry()).viewport
    await page.setViewportSize({ width: 390, height: 520 })
    await page.waitForFunction(height => document.querySelector(".workbot-scroll").clientHeight < height - 200, fullHeight)
    await atBottom("keyboard size")
    await page.screenshot({ path: `${out}/keyboard.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(height => document.querySelector(".workbot-scroll").clientHeight >= height - 2, fullHeight)
    await atBottom("keyboard dismissed")
  })
  await check("new app open ignores old reading position", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const node = page.locator(".workbot-scroll").first()
    await node.hover()
    await page.mouse.wheel(0, -1800)
    await page.waitForTimeout(200)
    assert.ok((await geometry()).gap > 800)
    await page.reload()
    await atBottom("reload")
    await page.screenshot({ path: `${out}/newest.png` })
  })
  if (process.env.SCROLL_BASELINE !== "1") {
    await check("cached messages replaced by fetched messages stay on newest", async () => {
      const cached = { ...thread(8), status: "idle" }
      await page.addInitScript(snapshot => {
        if (location.search.includes("instant=1")) localStorage.setItem("workbot.thread.v1:org_fixture:user_fixture:main", JSON.stringify({ savedAt: Date.now(), thread: snapshot }))
      }, cached)
      holdFirst = true
      extra = `Fresh fetched reply. ${"This answer is much taller than the cached answer. ".repeat(45)}`
      await open("scenario=bubbles&instant=1")
      await atBottom("cached first page")
      assert.ok(releaseFirst, "fresh fetch really held while cached messages rendered")
      releaseFirst()
      await page.waitForFunction(() => document.body.textContent.includes("Fresh fetched reply."))
      await atBottom("fresh fetched replacement")
    })
    await check("late browser card and image decode stay pinned", async () => {
      extra = "Here is the page and your plan."
      await open("scenario=bubbles&browser=1&preview=1")
      await atBottom("before browser card")
      const photoRequest = page.waitForRequest(request => request.url().includes("/files/scroll-photo"))
      rich = true
      await photoRequest
      await page.locator("[data-workbot-browser-card]").waitFor()
      await page.waitForFunction(() => document.querySelector('[data-workbot-row="scroll-37"] button[aria-label="Open Plan.png"]') !== null)
      assert.ok(imageRequested && releaseImage, "photo really held after its card rendered")
      await atBottom("late browser card / image placeholder")
      releaseImage()
      await page.waitForFunction(() => [...document.querySelectorAll('[data-workbot-row="scroll-37"] img')].some(image => image.complete && image.naturalWidth > 0))
      await atBottom("late decoded image")
      await page.screenshot({ path: `${out}/late-card-and-image.png` })
      rich = false
    })
    await check("arrow is absent when flag is off", async () => {
      await page.locator(".workbot-scroll").first().hover()
      await page.mouse.wheel(0, -2000)
      await page.waitForTimeout(250)
      assert.equal(await page.getByRole("button", { name: "Scroll to latest message", exact: true }).count(), 0)
      await page.screenshot({ path: `${out}/flag-off.png` })
    })
    await check("arrow threshold fade and tap", async () => {
      extra = ""
      await open("scenario=bubbles&scroll=1")
      await atBottom("arrow initial")
      const arrow = page.getByRole("button", { name: "Scroll to latest message", exact: true })
      assert.equal(await arrow.isVisible(), false)
      const metrics = await geometry()
      await page.locator(".workbot-scroll").first().hover()
      await page.mouse.wheel(0, -Math.floor(metrics.viewport * .8))
      await page.waitForTimeout(250)
      assert.equal(await arrow.isVisible(), false, "less than one screen")
      await page.mouse.wheel(0, -Math.ceil(metrics.viewport * .4))
      await arrow.waitFor({ state: "visible" })
      await page.waitForTimeout(180)
      const button = await arrow.boundingBox()
      const composer = await page.locator("[data-workbot-composer]").boundingBox()
      assert.ok(button.y + button.height < composer.y, "arrow clears composer")
      assert.ok(Math.abs(button.x + button.width / 2 - 195) < 2, "centered on phone")
      await page.screenshot({ path: `${out}/arrow.png` })
      await arrow.tap()
      await atBottom("arrow tap")
      await page.waitForTimeout(200)
      assert.equal(await arrow.isVisible(), false)
      await page.screenshot({ path: `${out}/after-tap.png` })
    })
    await check("reading position survives late content and same-session chat return", async () => {
      await open("scenario=bubbles&sideChats=1&scroll=1")
      await atBottom("before reading")
      await page.locator(".workbot-scroll").first().hover()
      await page.mouse.wheel(0, -1500)
      await page.waitForTimeout(250)
      const before = await geometry()
      extra = `More arrived below. ${"New content should not take me away from what I am reading. ".repeat(40)}`
      await page.waitForFunction(() => document.body.textContent.includes("More arrived below."))
      assert.ok(Math.abs((await geometry()).top - before.top) <= 2, "new reply leaves reader alone")
      const reading = await geometry()
      await page.getByRole("button", { name: "Chats", exact: true }).tap()
      await page.getByRole("button", { name: "New side chat", exact: true }).tap()
      await atBottom("fresh side chat")
      await page.getByRole("button", { name: "Back to main chat", exact: true }).tap()
      await page.waitForTimeout(250)
      assert.ok(Math.abs((await geometry()).top - reading.top) <= 2, "same app session restores the main chat's reading position")
      await page.screenshot({ path: `${out}/returned-to-reading.png` })
    })
    await check("earlier history and its loaded window survive chat switching", async () => {
      extra = ""
      await open("scenario=bubbles&sideChats=1&scroll=1")
      await atBottom("before earlier history")
      await page.locator(".workbot-scroll").first().hover()
      await page.mouse.wheel(0, -50000)
      await page.waitForFunction(() => document.querySelector(".workbot-scroll").scrollTop <= 1)
      const row = page.locator('[data-workbot-row="scroll-8"]')
      const before = await row.boundingBox()
      await page.getByRole("button", { name: "Show earlier messages", exact: true }).tap()
      await page.waitForFunction(() => document.querySelectorAll("[data-workbot-row]").length === 38)
      assert.ok(Math.abs((await row.boundingBox()).y - before.y) <= 2, "earlier rows preserve the existing visible row")
      const reading = await geometry()
      await page.getByRole("button", { name: "Chats", exact: true }).tap()
      await page.getByRole("button", { name: "New side chat", exact: true }).tap()
      await atBottom("new side chat after paging")
      await page.getByRole("button", { name: "Back to main chat", exact: true }).tap()
      await page.waitForFunction(() => document.querySelectorAll("[data-workbot-row]").length === 38)
      assert.ok(Math.abs((await geometry()).top - reading.top) <= 2, "return restores the older loaded page, not only the newest 8")
    })
    await check("reduced motion tap is immediate", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" })
      await open("scenario=bubbles&scroll=1")
      await atBottom("reduced motion initial")
      await page.locator(".workbot-scroll").first().hover()
      await page.mouse.wheel(0, -2000)
      const arrow = page.getByRole("button", { name: "Scroll to latest message", exact: true })
      await arrow.waitFor({ state: "visible" })
      await arrow.tap()
      assert.ok((await geometry()).gap <= 2)
    })
  }
  assert.deepEqual(errors, [], "no browser runtime errors")
  console.log(JSON.stringify({ tests: process.env.SCROLL_BASELINE === "1" ? 4 : 11, failures, errors, screenshots: out }, null, 2))
} finally { await browser.close() }
assert.equal(failures.length, 0, `${failures.length} failed checks`)
