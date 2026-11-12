#!/usr/bin/env node
/**
 * Artifacts Workbot made, in the real WorkbotScreen against the in-memory fixture (the model/API are mocked).
 * This is a local UI regression check, NOT live Den/runner/model end-to-end evidence.
 * Start: pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3098
 * Run: node ee/apps/workbot/scripts/artifact-browser.mjs
 * WORKBOT_FIXTURE_URL defaults to http://localhost:3098 (loopback only); PLAYWRIGHT_MODULE overrides the evals
 * Playwright resolver; WORKBOT_EVIDENCE_DIR sets the screenshot folder. ARTIFACT_BASELINE=1 only captures the old
 * screens (chat, then the first file opened) without asserting the new card or panel.
 *
 * Also: an app that tries to load, send or navigate (prompt injection) does none of it from its card; only opening
 * it in the panel runs it.
 *
 * Checks, at 1440px and 1920px desktop and an iPhone-sized phone: each card shows a thumbnail, a title and a type;
 * a tap opens the side panel on desktop (the chat stays beside it) and a full-screen sheet on the phone, both with
 * only a title, "More" and Close in the header; Close returns to the chat.
 */
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const requireEvals = createRequire(fileURLToPath(new URL("../../../../evals/package.json", import.meta.url)))
let modulePath = process.env.PLAYWRIGHT_MODULE
if (!modulePath) {
  try { modulePath = requireEvals.resolve("playwright") }
  catch { throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs, or install Playwright in evals.") }
}
const { chromium } = await import(pathToFileURL(path.resolve(modulePath)).href)
const base = process.env.WORKBOT_FIXTURE_URL ?? "http://localhost:3098"
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Only a loopback fixture may receive these test requests")
const output = path.resolve(process.env.WORKBOT_EVIDENCE_DIR ?? "node_modules/.cache/artifact-evidence")
const baseline = process.env.ARTIFACT_BASELINE === "1"
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors = []
const viewports = [
  { name: "desktop-1440", width: 1440, height: 900, phone: false },
  { name: "desktop-1920", width: 1920, height: 1080, phone: false },
  { name: "iphone", width: 390, height: 844, phone: true },
]
const prefix = baseline ? "before" : "after"

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.phone ? 3 : 1, isMobile: viewport.phone, hasTouch: viewport.phone, colorScheme: "light", reducedMotion: "reduce",
      ...(viewport.phone ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on("pageerror", error => errors.push(`${viewport.name}: ${error.stack ?? error.message}`))
    await page.goto(`${base}/?scenario=artifacts&sideChats=1&preview=1&working=1&profile=1&centered=1&scroll=1`)
    await page.getByText("Here's your 3D space organizer", { exact: false }).waitFor()
    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(output, `${prefix}-${viewport.name}-chat.png`) })

    if (baseline) {
      await page.getByRole("button", { name: /space-organizer\.html/ }).click()
      await page.waitForTimeout(1200)
      await page.screenshot({ path: path.join(output, `${prefix}-${viewport.name}-open.png`) })
      await context.close()
      continue
    }

    // The card: a thumbnail, a small icon, the title and the type.
    const cards = page.locator("[data-workbot-artifact-card]")
    assert.equal(await cards.count(), 3, `${viewport.name}: one card per file Workbot made`)
    const organizer = cards.filter({ hasText: "3D Space Organizer" })
    await organizer.waitFor()
    // The card shows the app's page without running it: no scripts, and a policy that blocks every request.
    const thumbnail = organizer.locator("[data-workbot-artifact-thumbnail] iframe")
    await thumbnail.waitFor()
    assert.equal(await thumbnail.getAttribute("sandbox"), "", "the thumbnail frame runs no scripts")
    const shown = await thumbnail.getAttribute("srcdoc")
    assert.ok(shown && shown.includes("Content-Security-Policy") && !/<script/i.test(shown), "the thumbnail page has no scripts and blocks requests")
    assert.match(await organizer.innerText(), /Web page/)
    const report = cards.filter({ hasText: "Room plan" })
    assert.equal(await report.locator("[data-workbot-artifact-placeholder='pdf']").count(), 1, "a file without a rendering shows its type's placeholder")
    assert.match(await report.innerText(), /PDF/)

    await organizer.click()
    const surface = page.locator(viewport.phone ? "[data-workbot-artifact-sheet]" : "[data-workbot-artifact-panel]")
    await surface.waitFor()
    assert.equal(await page.locator(viewport.phone ? "[data-workbot-artifact-panel]" : "[data-workbot-artifact-sheet]").count(), 0, `${viewport.name}: only the ${viewport.phone ? "sheet" : "panel"} opens`)
    const header = surface.locator("[data-workbot-artifact-header]")
    assert.equal((await header.innerText()).trim(), "3D Space Organizer", "the header is the title, with icon-only controls")
    assert.deepEqual(await header.getByRole("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))), ["More", "Close"])
    assert.equal(await surface.locator("iframe[sandbox='allow-scripts']").count(), 1, "the app runs in the panel")
    if (!viewport.phone) {
      assert.ok(await page.getByText("Here's your 3D space organizer", { exact: false }).isVisible(), "the chat stays beside the panel")
      const panel = await surface.boundingBox()
      assert.ok(panel && panel.width >= viewport.width * 0.5, `${viewport.name}: the panel takes most of the width (${panel?.width})`)
    } else {
      const sheet = await surface.boundingBox()
      assert.ok(sheet && sheet.width === viewport.width && sheet.height >= viewport.height - 1, "the phone sheet is full screen")
    }
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(output, `${prefix}-${viewport.name}-open.png`) })

    // Secondary actions live in the More menu.
    await header.getByRole("button", { name: "More" }).click()
    const menu = page.getByRole("menu")
    await menu.waitFor()
    const items = await menu.getByRole("menuitem").allInnerTexts()
    for (const label of ["Open in new tab", "Download", "Copy link"]) assert.ok(items.some(item => item.includes(label)), `${viewport.name}: ${label} is in More`)
    assert.equal(items.some(item => /Expand|Collapse/.test(item)), !viewport.phone, "expand is offered only beside the chat")
    await page.screenshot({ path: path.join(output, `${prefix}-${viewport.name}-menu.png`) })
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    assert.equal(await surface.count(), 1, "Esc closes the menu first, not the file")

    if (!viewport.phone) {
      // Expand hides the chat; the same item brings it back.
      await header.getByRole("button", { name: "More" }).click()
      await page.getByRole("menuitem", { name: "Expand" }).click()
      await page.getByText("Here's your 3D space organizer", { exact: false }).waitFor({ state: "hidden" })
      await page.screenshot({ path: path.join(output, `${prefix}-${viewport.name}-expanded.png`) })
      await header.getByRole("button", { name: "More" }).click()
      await page.getByRole("menuitem", { name: "Show the chat" }).click()
      await page.getByText("Here's your 3D space organizer", { exact: false }).waitFor()

      // Open in new tab: the app runs there in a sandboxed frame, never with this site's origin.
      await header.getByRole("button", { name: "More" }).click()
      const [tab] = await Promise.all([context.waitForEvent("page"), page.getByRole("menuitem", { name: "Open in new tab" }).click()])
      await tab.locator("iframe[sandbox='allow-scripts']").waitFor()
      assert.equal(await tab.title(), "3D Space Organizer")
      assert.equal(await tab.evaluate(() => window.opener), null, "the new tab can't reach this page")
      await tab.close()
    }

    await header.getByRole("button", { name: "Close" }).click()
    await surface.waitFor({ state: "detached" })
    assert.ok(await page.getByText("Here's your 3D space organizer", { exact: false }).isVisible(), "Close returns to the chat")
    if (!viewport.phone) {
      // The other kinds open in the same panel.
      await report.click()
      await surface.waitFor()
      assert.equal((await surface.locator("[data-workbot-artifact-header]").innerText()).trim(), "Room plan")
      await page.keyboard.press("Escape")
      await surface.waitFor({ state: "detached" })
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Room plan, PDF", "focus returns to the card")

      // A copied link (?artifact=<id>) opens that file again, then leaves the address.
      await page.goto(`${base}/?scenario=artifacts&sideChats=1&artifact=out-shopping`)
      await surface.waitFor()
      assert.equal((await surface.locator("[data-workbot-artifact-header]").innerText()).trim(), "Shopping list")
      assert.doesNotMatch(page.url(), /artifact=/)
    }
    if (viewport.name === "desktop-1440") {
      // A hostile app's card makes no request and doesn't navigate before the person opens it.
      const leaked = []
      page.on("request", request => { if (request.url().includes("exfil.invalid")) leaked.push(request.url()) })
      await page.goto(`${base}/?scenario=artifact-hostile&sideChats=1`)
      const card = page.locator("[data-workbot-artifact-card]")
      await card.locator("[data-workbot-artifact-thumbnail] iframe[sandbox='']").waitFor()
      await card.filter({ hasText: "Inbox summary" }).waitFor()
      await page.waitForTimeout(2000)
      assert.deepEqual(leaked, [], "the card's thumbnail reached nothing")
      await page.screenshot({ path: path.join(output, `${prefix}-${viewport.name}-hostile-card.png`) })
    }
    await context.close()
  }
} finally {
  await browser.close()
}
assert.deepEqual(errors, [], "no page errors")
console.log(`${baseline ? "baseline captured" : "artifact checks passed"}: ${output}`)
