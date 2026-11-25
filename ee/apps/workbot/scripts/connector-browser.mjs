import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

/**
 * Real WorkbotScreen against the fixture server: the connector logo group under Workbot's answer while it searches Exa,
 * static once done (hover/tap to see names and tools, still there after a reload), the header saying the same thing, and the
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

      await check(`${size.name}: a connector call shows only a logo under the answer, with matching header identity`, page, async () => {
        await page.locator('[data-workbot-connector-line="live"]').filter({ visible: true }).first().waitFor({ timeout: 5_000 })
        const stack = page.locator("[data-workbot-connector-stack]").first()
        assert.equal(await stack.getAttribute("aria-label"), "Used Exa")
        assert.equal(await stack.locator('[data-workbot-connector-logo="Exa"]').count(), 1)
        assert.equal(await stack.locator('[data-active="true"]').count(), 1)
        assert.match((await page.locator("[data-workbot-status-line]").first().innerText()).trim(), /Searching Exa/)
        assert.doesNotMatch(await line.innerText(), /Searching|Used|searches/)
        assert.doesNotMatch(await page.locator("body").innerText(), RAW)
        await page.waitForTimeout(650)
        await page.screenshot({ path: `${out}/${size.name}-live.png` })
      })
      await check(`${size.name}: repeated searches stay one logo, with no text or count`, page, async () => {
        await page.waitForTimeout(2_500)
        assert.equal(await line.locator("[data-workbot-connector-logo]").count(), 1)
        assert.doesNotMatch(await line.innerText(), /Searching|Used|searches/)
        await page.screenshot({ path: `${out}/${size.name}-live-2.png` })
        await page.waitForFunction(() => {
          const line = document.querySelector('[data-workbot-connector-line="live"]');
          return line && line.querySelectorAll('[data-active="true"]').length === 0;
        }, undefined, { timeout: 5_000 })
        assert.equal(await line.locator(".workbot-connector-pulse").count(), 0, "no pulse after the tool returns, even while Workbot reads its results")
      })
      await check(`${size.name}: the same static logo after completion, with names on hover and details on tap`, page, async () => {
        await page.locator('[data-workbot-connector-line="done"]').filter({ visible: true }).first().waitFor({ timeout: 9_000 })
        const stack = page.locator("[data-workbot-connector-stack]").first()
        assert.equal(await stack.locator("[data-active]").count(), 0)
        assert.doesNotMatch(await line.innerText(), /Searching|Used|searches/)
        await page.waitForTimeout(400)
        const answer = await page.getByText("Here's what stands out").boundingBox()
        const box = await stack.boundingBox()
        assert.ok(box.y >= answer.y + answer.height - 1 && box.y - (answer.y + answer.height) < 40, "stack sits right under the answer")
        await page.screenshot({ path: `${out}/${size.name}-done.png` })
        if (!size.hasTouch) await stack.hover()
        else await stack.tap()
        const popover = page.locator("[data-workbot-connector-popover]")
        await popover.waitFor({ state: "visible" })
        assert.match(await popover.innerText(), /Used Exa/)
        const geometry = () => page.locator(".workbot-scroll").filter({ visible: true }).first().evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight }))
        const before = await geometry()
        await popover.locator("summary").click()
        assert.match((await popover.innerText()).replace(/\s+/g, " "), /Exa · Web search ×2/)
        assert.deepEqual(await geometry(), before, "tool disclosure never resizes the transcript")
        assert.doesNotMatch(await popover.innerText(), RAW)
        await page.waitForTimeout(400)
        await page.screenshot({ path: `${out}/${size.name}-expanded.png` })
        await page.keyboard.press("Escape")
      })
      await check(`${size.name}: the same group persists after reload, without any feature flag`, page, async () => {
        await page.goto(`${base}/?scenario=exa`, { waitUntil: "domcontentloaded" })
        const stack = page.locator('[data-workbot-connector-line="done"] [data-workbot-connector-stack]').first()
        await stack.waitFor()
        assert.equal(await stack.getAttribute("aria-label"), "Used Exa")
        await page.reload({ waitUntil: "domcontentloaded" })
        await stack.waitFor()
        assert.equal(await stack.getAttribute("aria-label"), "Used Exa")
      })
      await check(`${size.name}: distinct connectors overlap in first-use order with overflow and letter fallback`, page, async () => {
        await page.goto(`${base}/?scenario=connectors`, { waitUntil: "domcontentloaded" })
        const stack = page.locator("[data-workbot-connector-stack]").first()
        await stack.waitFor()
        assert.deepEqual(await stack.locator("[data-workbot-connector-logo]").evaluateAll((logos) => logos.map((logo) => logo.dataset.workbotConnectorLogo)), ["Exa", "Google Drive", "Linear", "Slack", "GitHub"])
        assert.equal(await stack.locator("[data-workbot-connector-more]").innerText(), "+2")
        const logos = await stack.locator("[data-workbot-connector-logo]").evaluateAll((logos) => logos.map((logo) => ({ x: logo.getBoundingClientRect().x, width: logo.getBoundingClientRect().width, radius: getComputedStyle(logo).borderRadius })))
        assert.equal(logos[0].width, 20)
        assert.equal(logos[1].x - logos[0].x, 13, "35% overlap")
        await page.waitForTimeout(600)
        await page.screenshot({ path: `${out}/${size.name}-stack.png` })
        await stack.click()
        const popover = page.locator("[data-workbot-connector-popover]")
        await popover.waitFor({ state: "visible" })
        assert.match(await popover.innerText(), /Used Exa, Google Drive, Linear, Slack, GitHub, PlanetScale and Research/)
        await popover.locator("summary").click()
        assert.ok((await popover.locator("[data-workbot-app-letter]").allTextContents()).includes("R"), "unknown connector falls back to its letter")
        await page.keyboard.press("Escape")
        await page.reload({ waitUntil: "domcontentloaded" })
        await stack.waitFor()
        assert.equal(await stack.locator("[data-workbot-connector-more]").innerText(), "+2")
        // The group uses Workbot's tokens, not hardcoded white rings; verify it against dark host tokens too.
        await page.addStyleTag({ content: ".workbot { --wb-bg:#11181c; --wb-surface:#1b2228; --wb-chip:#252e35; --wb-text:#eef2f6; --wb-muted:#a1aab3; --wb-faint:#89939c; --wb-user-bubble:#252e35; --wb-ring:#ffffff20; --wb-composer-shadow:0 0 0 1px #ffffff20; }" })
        const ring = await stack.locator("[data-workbot-connector-logo]").first().evaluate((node) => getComputedStyle(node).boxShadow)
        assert.ok(ring.includes("17, 24, 28"), "overlap ring follows dark host background")
        await page.screenshot({ path: `${out}/${size.name}-stack-dark-tokens.png` })
      })
    }

    if (process.env.CONNECTOR_TYPING_ONLY !== "1") {
      await check(`${size.name}: OpenWork's own features show one OpenWork logo in the stack, pulsing while one runs`, page, async () => {
        await page.goto(`${base}/?scenario=openwork-live`, { waitUntil: "domcontentloaded" })
        const stack = page.locator('[data-workbot-connector-line="live"] [data-workbot-connector-stack]').first()
        await stack.waitFor({ timeout: 5_000 })
        assert.deepEqual(await stack.locator("[data-workbot-connector-logo]").evaluateAll((logos) => logos.map((logo) => logo.dataset.workbotConnectorLogo)), ["Exa", "Google Drive", "Linear", "OpenWork"])
        assert.equal(await stack.locator('[data-workbot-connector-logo="OpenWork"][data-active="true"]').count(), 1, "the running OpenWork feature's logo pulses")
        assert.equal(await stack.locator("[data-workbot-openwork-mark] svg").count(), 1)
        assert.doesNotMatch(await page.locator("body").innerText(), RAW)
        await page.waitForTimeout(500)
        await page.screenshot({ path: `${out}/${size.name}-openwork-live.png` })
      })
      await check(`${size.name}: the OpenWork logo stays after completion and reload, with names and details and no raw ids`, page, async () => {
        await page.goto(`${base}/?scenario=openwork`, { waitUntil: "domcontentloaded" })
        const stack = page.locator('[data-workbot-connector-line="done"] [data-workbot-connector-stack]').first()
        await stack.waitFor()
        const read = async () => ({ label: await stack.getAttribute("aria-label"), logos: await stack.locator("[data-workbot-connector-logo]").evaluateAll((logos) => logos.map((logo) => logo.dataset.workbotConnectorLogo)) })
        const first = await read()
        assert.deepEqual(first, { label: "Used Exa, Google Drive, Linear and OpenWork", logos: ["Exa", "Google Drive", "Linear", "OpenWork"] })
        assert.equal(await stack.locator(".workbot-connector-pulse").count(), 0)
        const logo = await stack.locator('[data-workbot-connector-logo="OpenWork"]').evaluate((node) => ({ width: node.getBoundingClientRect().width, radius: getComputedStyle(node).borderRadius }))
        assert.equal(logo.width, 20, "same size as the other logos")
        await page.waitForTimeout(500)
        await page.screenshot({ path: `${out}/${size.name}-openwork-done.png` })
        await page.locator("[data-workbot-connector-line]").first().screenshot({ path: `${out}/${size.name}-openwork-stack-closeup.png` })
        if (!size.hasTouch) await stack.hover()
        else await stack.tap()
        const popover = page.locator("[data-workbot-connector-popover]")
        await popover.waitFor({ state: "visible" })
        await popover.locator("summary").click()
        const text = (await popover.innerText()).replace(/\s+/g, " ")
        assert.match(text, /Used Exa, Google Drive, Linear and OpenWork/)
        assert.match(text, /OpenWork · Remote task/)
        assert.match(text, /OpenWork · Weekly digest/)
        assert.match(text, /OpenWork · Draft the weekly digest/)
        assert.doesNotMatch(text, RAW)
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${out}/${size.name}-openwork-expanded.png` })
        await page.keyboard.press("Escape")
        await page.reload({ waitUntil: "domcontentloaded" })
        await stack.waitFor()
        assert.deepEqual(await read(), first, "the same logos after a reload")
        assert.doesNotMatch(await page.locator("body").innerText(), RAW)
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
      // While the box grows: scrollTop every frame may only move one way (up by the new line), never bounce. What is
      // painted is read by an observer created after the page's own, so it runs after the page's correction and just
      // before paint (a requestAnimationFrame read comes before layout and would see the uncorrected position).
      await page.evaluate(() => {
        const node = [...document.querySelectorAll(".workbot-scroll")].find((entry) => entry.clientHeight > 0)
        window.__growTops = []
        window.__growPainted = []
        const tick = () => { window.__growTops.push(node.scrollTop); window.__growRaf = requestAnimationFrame(tick) }
        tick()
        window.__growObserver = new ResizeObserver(() => window.__growPainted.push(node.scrollHeight - node.clientHeight - node.scrollTop))
        window.__growObserver.observe(node)
        // With the floating message box the conversation keeps its size; its content's padding grows instead.
        window.__growObserver.observe(node.firstElementChild, { box: "border-box" })
      })
      await page.keyboard.type(" and now this message keeps going until it needs another line in the box, and another".repeat(1))
      await page.waitForTimeout(300)
      const { tops, painted } = await page.evaluate(() => { cancelAnimationFrame(window.__growRaf); window.__growObserver.disconnect(); return { tops: window.__growTops, painted: window.__growPainted } })
      const gap = await page.evaluate(() => { const node = [...document.querySelectorAll(".workbot-scroll")].find((entry) => entry.clientHeight > 0); return node.scrollHeight - node.clientHeight - node.scrollTop })
      assert.ok(gap <= 1, `left ${gap}px short`)
      const reversals = tops.slice(1).filter((top, index) => top < tops[index]).length
      console.log(JSON.stringify({ size: size.name, growingLine: { distinctScrollTop: [...new Set(tops)], paintedGaps: painted } }))
      assert.equal(reversals, 0, "scrollTop never moves back down while the box grows (no bounce)")
      assert.ok(painted.every((value) => value <= 1), `the newest message stays in view in every painted resize: ${painted}`)
      await box.fill("")
    })
    assert.deepEqual(errors, [], "no browser runtime errors")
    await context.close()
  }
  console.log(JSON.stringify({ failures, screenshots: out }, null, 2))
} finally { await browser.close() }
assert.equal(failures.length, 0, `${failures.length} failed checks`)
