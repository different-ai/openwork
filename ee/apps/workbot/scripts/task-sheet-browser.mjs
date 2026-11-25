#!/usr/bin/env node
/**
 * ENG-1143: tapping Workbot on a phone opens the same sheet as clicking it on desktop, and background tasks are one
 * row each. Real WorkbotScreen in the in-memory fixture (`?scenario=background`, Nov 9's production state) with the
 * profile flags on; the model/API are mocked, so this is a UI check, NOT live end-to-end evidence.
 *
 * Start: pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3098
 * Run:   pnpm --filter @openwork-ee/workbot test:task-sheet-browser   (TASK_SHEET_BROWSER=webkit for Safari's engine)
 * WORKBOT_FIXTURE_URL defaults to http://localhost:3098 (loopback only); WORKBOT_EVIDENCE_DIR keeps the screenshots.
 */
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const requireEvals = createRequire(fileURLToPath(new URL("../../../../evals/package.json", import.meta.url)))
const { chromium, webkit } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? requireEvals.resolve("playwright")).href)
const engine = process.env.TASK_SHEET_BROWSER === "webkit" ? webkit : chromium
const base = process.env.WORKBOT_FIXTURE_URL ?? "http://localhost:3098"
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Only a loopback fixture may receive these test requests")
const output = path.resolve(process.env.WORKBOT_EVIDENCE_DIR ?? "node_modules/.cache/task-sheet-evidence")
await mkdir(output, { recursive: true })
// Ben's organization: working status, the profile (centred) and remote tasks.
const flags = "working=1&profile=1&centered=1&remote=1&browser=1&sideChats=1"
const browser = await engine.launch({ headless: true })
const report = { engine: engine.name(), checks: [], screenshots: [], errors: [] }

async function open(device) {
  const phone = device === "iphone"
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2, isMobile: phone && engine !== webkit, hasTouch: phone, colorScheme: "light", reducedMotion: "reduce",
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => report.errors.push(error.stack ?? error.message))
  await page.goto(`${base}/?scenario=background&${flags}`, { waitUntil: "domcontentloaded" })
  await page.locator("[data-workbot-composer] textarea").filter({ visible: true }).first().waitFor()
  const trigger = page.locator(phone ? "[data-workbot-working-name]" : "[data-workbot-profile-badge]").filter({ visible: true }).first()
  await trigger.click()
  const sheet = page.getByRole("dialog").first()
  await sheet.waitFor()
  await page.waitForTimeout(400)
  return { page, context, sheet }
}
async function shot(page, name) {
  const file = path.join(output, `${report.engine}-${name}.png`)
  await page.screenshot({ path: file })
  report.screenshots.push(file)
}
const facts = sheet => sheet.evaluate(node => ({
  component: node.hasAttribute("data-workbot-profile") ? "profile" : node.hasAttribute("data-workbot-task-sheet") ? "task-sheet" : "other",
  tabs: [...node.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute("aria-label")),
  sections: [...node.querySelectorAll("h2, h3")].map(heading => heading.textContent),
  rows: [...node.querySelectorAll("[data-workbot-sheet-task]")].map(row => row.querySelector("[data-workbot-task-toggle]")?.textContent),
  stepRows: node.querySelectorAll("[data-workbot-sheet-steps] > li").length,
  stops: [...node.querySelectorAll("button")].filter(button => button.textContent === "Stop").length,
}))

try {
  const desktop = await open("desktop")
  const wide = await facts(desktop.sheet)
  await shot(desktop.page, "desktop-1440")
  const phone = await open("iphone")
  const narrow = await facts(phone.sheet)
  await shot(phone.page, "iphone-390")
  report.checks.push({ desktop: wide, phone: narrow })

  assert.equal(narrow.component, "profile", "The phone opens the profile, like desktop")
  assert.deepEqual(narrow, wide, "Same component, tabs, sections, rows and order on phone and desktop")
  assert.equal(narrow.rows.length, 4, "One row per background task")
  assert.equal(narrow.stepRows, 0, "No internal steps at the top level")
  assert.equal(narrow.stops, 2, "Stop on each unfinished task")

  // Full height on the phone: from just under the status bar to the bottom edge.
  const box = await phone.sheet.boundingBox()
  assert.ok(box && box.y <= 16 && Math.round(box.y + box.height) === 844, `Full-height phone sheet (${JSON.stringify(box)})`)
  assert.equal(await phone.page.locator("[data-workbot-sheet-grabber]").isVisible(), true, "Grabber on the phone sheet")
  assert.equal(await desktop.page.locator("[data-workbot-sheet-grabber]").isVisible(), false, "No grabber on desktop")

  // A task's steps open inside its row, repeats counted.
  const row = phone.sheet.locator("[data-workbot-sheet-task]").filter({ hasText: "Watch the browser fix" })
  await row.locator("[data-workbot-task-toggle]").click()
  const steps = row.locator("[data-workbot-sheet-steps] > li")
  assert.equal(await steps.count(), 1, "Seven identical polls read as one step")
  assert.match(await steps.first().textContent(), /Checking the remote task · 7 times/)
  await shot(phone.page, "iphone-390-task-open")

  // Pull the sheet down from its header to close it.
  const header = phone.sheet.locator("[data-workbot-sheet-drag]")
  const from = await header.boundingBox()
  await phone.page.mouse.move(from.x + from.width / 2, from.y + 40)
  await phone.page.mouse.down()
  for (let step = 1; step <= 10; step++) await phone.page.mouse.move(from.x + from.width / 2, from.y + 40 + step * 30)
  await phone.page.mouse.up()
  await phone.sheet.waitFor({ state: "hidden" })
  report.checks.push({ dragClosed: true })

  // Desktop is unchanged: the 420px panel on the right.
  const panel = await desktop.sheet.boundingBox()
  assert.deepEqual([Math.round(panel.x), Math.round(panel.width), Math.round(panel.height)], [1020, 420, 900], "Desktop keeps its side panel")
  assert.deepEqual(report.errors, [], "No page errors")
  console.log(JSON.stringify(report, null, 2))
} finally {
  await writeFile(path.join(output, `${report.engine}-report.json`), JSON.stringify(report, null, 2))
  await browser.close()
}
