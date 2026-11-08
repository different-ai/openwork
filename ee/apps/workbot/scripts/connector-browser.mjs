import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

/**
 * Real WorkbotScreen against the fixture server: the connector line under Workbot's answer while it searches Exa, its
 * footnote once done (tap to see what ran, still there after a reload), the header saying the same thing, and the
 * conversation holding perfectly still while the person types.
 * Start: pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3097
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/connector-browser.mjs
 * CONNECTOR_BROWSER=webkit checks the same in WebKit.
 * CONNECTOR_TYPING_ONLY=1 runs only the typing check (for a before/after against dev).
 * WORKBOT_EVIDENCE_DIR controls screenshot output; nothing is uploaded by this test.
 */
const requireEvals = createRequire(fileURLToPath(new URL("../../../../evals/package.json", import.meta.url)))
const { chromium, webkit } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? requireEvals.resolve("playwright")).href)
const base = process.env.WORKBOT_FIXTURE_URL ?? "http://localhost:3097"
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Only a loopback fixture may receive these test requests")
const out = process.env.WORKBOT_EVIDENCE_DIR ?? "node_modules/.cache/connector-evidence"
await mkdir(out, { recursive: true })
// CONNECTOR_BROWSER=webkit runs the same checks in WebKit (Safari's engine; Playwright has no mobile WebKit mode).
const engine = process.env.CONNECTOR_BROWSER === "webkit" ? webkit : chromium
const browser = await engine.launch({ headless: true })
const sizes = [
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
]
const failures = []
const check = async (name, page, run) => {
  try { await run(); console.log(`PASS: ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}: ${error.message}`); await page?.screenshot({ path: `${out}/${name.replaceAll(/[^a-z0-9]+/gi, "-")}-failed.png` }).catch(() => {}) }
}
const RAW = /mcp:|emc_|execute_capability|search_capabilities|web_search_exa/

/** scrollTop of the visible conversation after each of 20 keystrokes, from a one- or two-line draft. */
async function typing(page, prefill) {
  const box = page.locator("[data-workbot-composer] textarea")
  await box.focus()
  await box.fill(prefill)
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const node = [...document.querySelectorAll(".workbot-scroll")].find((entry) => entry.clientHeight > 0)
    const frames = []
    window.__frames = frames
    const tick = () => { frames.push(node.scrollTop); window.__raf = requestAnimationFrame(tick) }
    tick()
  })
  const tops = []
  for (const key of "searching exa please") {
    await page.keyboard.type(key)
    await page.waitForTimeout(50)
    tops.push(await page.evaluate(() => [...document.querySelectorAll(".workbot-scroll")].find((entry) => entry.clientHeight > 0).scrollTop))
  }
  const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames })
  const gap = await page.evaluate(() => { const node = [...document.querySelectorAll(".workbot-scroll")].find((entry) => entry.clientHeight > 0); return node.scrollHeight - node.clientHeight - node.scrollTop })
  await box.fill("")
  return { tops, distinctFrames: [...new Set(frames)], gap }
}

try {
  for (const size of sizes) {
    const context = await browser.newContext({ viewport: size.viewport, isMobile: engine === webkit ? false : size.isMobile, hasTouch: size.hasTouch, deviceScaleFactor: 2, colorScheme: "light" })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))

    if (process.env.CONNECTOR_TYPING_ONLY !== "1") {
      // Start Ben's Exa request over, from this page's first read.
      await page.request.get(`${base}/v1/workbot?exa=reset`, { headers: { "x-fixture-scenario": "exa" } })
      await page.goto(`${base}/?scenario=exa&working=1`, { waitUntil: "domcontentloaded" })
      const line = page.locator('[data-workbot-connector-line]').filter({ visible: true }).first()

      await check(`${size.name}: a connector call shows "Searching Exa…" under the answer, with the header saying the same`, page, async () => {
        await page.locator('[data-workbot-connector-line="live"]').filter({ visible: true }).first().waitFor({ timeout: 5_000 })
        assert.match(await line.innerText(), /^Searching Exa…/)
        assert.match(await page.locator("[data-workbot-status-line]").first().innerText(), /Searching Exa/)
        assert.doesNotMatch(await page.locator("body").innerText(), RAW)
        await page.screenshot({ path: `${out}/${size.name}-live.png` })
      })
      await check(`${size.name}: a second search collapses into one line that counts them`, page, async () => {
        await page.waitForFunction(() => /Searching Exa….*2 searches/.test(document.querySelector('[data-workbot-connector-line="live"]')?.textContent ?? ""), undefined, { timeout: 6_000 })
        assert.equal(await page.locator("[data-workbot-connector-line]").filter({ visible: true }).count(), 1)
        await page.screenshot({ path: `${out}/${size.name}-live-2.png` })
      })
      await check(`${size.name}: once answered it settles into "Used Exa · 2 searches", which lists what ran`, page, async () => {
        await page.locator('[data-workbot-connector-line="done"]').filter({ visible: true }).first().waitFor({ timeout: 9_000 })
        const footnote = page.locator('[data-workbot-connector-line="done"] button').filter({ visible: true }).first()
        assert.match((await footnote.innerText()).replace(/\s+/g, " "), /Used Exa · 2 searches/)
        // Directly under the answer it belongs to.
        const answer = await page.getByText("Here's what stands out").boundingBox()
        const box = await footnote.boundingBox()
        assert.ok(box.y >= answer.y + answer.height - 1 && box.y - (answer.y + answer.height) < 40, "footnote sits right under the answer")
        await page.screenshot({ path: `${out}/${size.name}-done.png` })
        assert.equal(await footnote.getAttribute("aria-expanded"), "false")
        await footnote.click()
        const rows = page.locator("[data-workbot-connector-rows]").filter({ visible: true }).first()
        assert.match((await rows.innerText()).replace(/\s+/g, " "), /Searching Exa · Web search ×2/)
        assert.doesNotMatch(await page.locator("body").innerText(), RAW)
        await page.waitForTimeout(400)
        await page.screenshot({ path: `${out}/${size.name}-expanded.png` })
      })
      await check(`${size.name}: the footnote is still there after a reload`, page, async () => {
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.locator('[data-workbot-connector-line="done"]').filter({ visible: true }).first().waitFor({ timeout: 5_000 })
        assert.match((await page.locator('[data-workbot-connector-line="done"]').filter({ visible: true }).first().innerText()).replace(/\s+/g, " "), /Used Exa · 2 searches/)
      })
      await check(`${size.name}: the same footnote without the working status line`, page, async () => {
        await page.goto(`${base}/?scenario=exa`, { waitUntil: "domcontentloaded" })
        await page.locator('[data-workbot-connector-line="done"]').filter({ visible: true }).first().waitFor({ timeout: 5_000 })
      })
    }

    await check(`${size.name}: typing never moves the conversation`, page, async () => {
      await page.goto(`${base}/?scenario=bubbles`, { waitUntil: "domcontentloaded" })
      await page.locator("[data-workbot-composer] textarea").waitFor()
      await page.waitForTimeout(800)
      for (const [label, prefill] of [["one line", ""], ["two lines", "Could you use exa to search about best ux practices and skills\n"]]) {
        const result = await typing(page, prefill)
        console.log(JSON.stringify({ size: size.name, draft: label, scrollTopPerKeystroke: result.tops, distinctScrollTopPerFrame: result.distinctFrames, gapAfter: result.gap }))
        assert.equal(new Set(result.tops).size, 1, `${label}: scrollTop changed while typing`)
        assert.equal(result.distinctFrames.length, 1, `${label}: scrollTop changed between frames`)
        assert.ok(result.gap <= 1, `${label}: left ${result.gap}px short of the newest message`)
      }
    })
    await check(`${size.name}: a new line in the message box keeps the newest message in view`, page, async () => {
      const box = page.locator("[data-workbot-composer] textarea")
      await box.fill("Short")
      await page.waitForTimeout(200)
      await box.press("End")
      await page.keyboard.type(" and now this message keeps going until it needs another line in the box, and another".repeat(1))
      await page.waitForTimeout(300)
      const gap = await page.evaluate(() => { const node = [...document.querySelectorAll(".workbot-scroll")].find((entry) => entry.clientHeight > 0); return node.scrollHeight - node.clientHeight - node.scrollTop })
      assert.ok(gap <= 1, `left ${gap}px short`)
      await box.fill("")
    })
    assert.deepEqual(errors, [], "no browser runtime errors")
    await context.close()
  }
  console.log(JSON.stringify({ failures, screenshots: out }, null, 2))
} finally { await browser.close() }
assert.equal(failures.length, 0, `${failures.length} failed checks`)
