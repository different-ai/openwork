#!/usr/bin/env node
/**
 * Real WorkbotScreen in the existing in-memory fixture; the model/API are mocked.
 * This is a local UI regression check, NOT live Den/runner/model end-to-end evidence.
 * Start: pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts 3098
 * Run: node ee/apps/workbot/scripts/navigation-browser.mjs
 * WORKBOT_FIXTURE_URL defaults to http://localhost:3098 (loopback only).
 * PLAYWRIGHT_MODULE overrides the evals Playwright resolver; no dependency changes needed.
 * WORKBOT_EVIDENCE_DIR sets the screenshot/report folder. Nothing is uploaded.
 * NAVIGATION_BASELINE=1 captures the old desktop/phone UI BEFORE asserting the new
 * layout exists. Run against the pre-change fixture: missing layout must exit red.
 */
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const requireEvals = createRequire(fileURLToPath(new URL("../../../../evals/package.json", import.meta.url)))
let modulePath = process.env.PLAYWRIGHT_MODULE
if (!modulePath) {
  try { modulePath = requireEvals.resolve("playwright") }
  catch { throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs, or install Playwright in evals. No application dependency changes are needed.") }
}
const { chromium } = await import(pathToFileURL(path.resolve(modulePath)).href)
const base = process.env.WORKBOT_FIXTURE_URL ?? "http://localhost:3098"
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Only a loopback fixture may receive these test requests")
const output = path.resolve(process.env.WORKBOT_EVIDENCE_DIR ?? "node_modules/.cache/navigation-evidence")
const baseline = process.env.NAVIGATION_BASELINE === "1"
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const report = {
  evidence: "Real React WorkbotScreen with the existing fixture's canned model/thread responses and a deterministic intercepted chats list. NOT live end-to-end integration.",
  origin: base, baseline, checks: [], screenshots: [], errors: [], chatRequests: [],
  capabilities: { files: true, calendar: false, documents: false, note: "The existing chat-screen fixture enables files via its thread response; it does not provide host.calendar or host.documents. These unavailable destinations must be absent, not invented." },
}
const now = Date.now()
// Deliberately unsorted: the UI must order by recency, not this response's order.
const side = [
  { id: "casualgreeting01", title: "Casual greeting", updatedAt: now - 2 * 86_400_000 },
  { id: "officeplan000001", title: "Office plan", updatedAt: now - 5 * 60_000 },
  { id: "weeklyreview0001", title: "Weekly review", updatedAt: now - 3 * 3_600_000 },
].map(chat => ({ ...chat, id: chat.id.padEnd(16, "0") }))
for (const chat of side) assert.match(chat.id, /^[a-z0-9]{16}$/, "Fixture side chat IDs must be valid actual chat IDs")
const expectedOrder = ["Office plan", "Weekly review", "Casual greeting"]
const office = side.find(chat => chat.title === "Office plan")
const weekly = side.find(chat => chat.title === "Weekly review")
const draft = "Keep this unsent office plan while I navigate."
let state = "populated"
let chatReads = 0
const contexts = []

async function createPage(phone = false) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, colorScheme: "light", reducedMotion: "reduce",
    ...(phone ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}),
  })
  contexts.push(context)
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on("pageerror", error => report.errors.push(error.stack ?? error.message))
  await page.route(/\/v1\/workbot\/chats(?:\?.*)?$/, async route => {
    assert.equal(route.request().method(), "GET", "This test only intercepts reads of the chats list")
    chatReads++
    report.chatRequests.push({ state, url: route.request().url() })
    if (state === "error") return route.fulfill({ status: 503, json: { error: "fixture_chats_unavailable" } })
    await route.fulfill({ json: { main: { updatedAt: now - 60_000 }, side: state === "empty" ? [] : side } })
  })
  return page
}
const composer = page => page.locator("[data-workbot-composer] textarea").filter({ visible: true }).first()
const desktopNav = page => page.locator("[data-workbot-desktop-navigation]")
const drawer = page => page.locator("[data-workbot-mobile-navigation]")
const trigger = page => page.getByRole("button", { name: "Open workspace navigation", exact: true })
const sideSection = nav => nav.getByRole("region", { name: "Side chats", exact: true })
const chatButton = (nav, title) => sideSection(nav).getByRole("button", { name: new RegExp(`^${title}(?:\\s|$)`) })
async function open(page) {
  await page.goto(`${base}/?scenario=bubbles&sideChats=1&browser=1&computer=1`, { waitUntil: "domcontentloaded" })
  await composer(page).waitFor()
  await page.locator("[data-workbot-row]").first().waitFor()
  await page.evaluate(() => document.fonts.ready)
}
async function shot(page, name) {
  const file = path.join(output, `${baseline ? "before" : "after"}-${name}.png`)
  await page.screenshot({ path: file })
  report.screenshots.push(file)
}
async function check(page, name, run) {
  try {
    await run()
    report.checks.push({ name, passed: true })
    console.log(`PASS: ${name}`)
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) })
    console.error(`FAIL: ${name}: ${error.message}`)
    await shot(page, `${name.replaceAll(/[^a-z0-9]+/gi, "-")}-failed`).catch(() => {})
  }
}
async function assertList(nav) {
  const region = sideSection(nav)
  await chatButton(nav, "Office plan").waitFor()
  const titles = await region.locator("li button > span:first-child").allTextContents()
  assert.deepEqual(titles, expectedOrder, "All three chats are directly visible, newest first")
  assert.match(await chatButton(nav, "Office plan").innerText(), /5m/)
  assert.match(await chatButton(nav, "Weekly review").innerText(), /3h/)
  assert.match(await chatButton(nav, "Casual greeting").innerText(), /2d/)
}
async function assertDestinations(nav, phone = false) {
  const workspace = nav.getByRole("navigation", { name: phone ? "Tabs" : "Workspace", exact: true })
  await workspace.getByRole("button", { name: "Main chat", exact: true }).waitFor()
  await workspace.getByRole("button", { name: "Files", exact: true }).waitFor()
  for (const unavailable of ["Calendar", "Documents", "Computer", "Browser"]) {
    assert.equal(await workspace.getByRole("button", { name: unavailable, exact: true }).count(), 0, `${unavailable} is not a navigation destination in this fixture`)
    assert.equal(await workspace.getByRole("link", { name: unavailable, exact: true }).count(), 0)
  }
}
async function assertDraft(page, text = draft) {
  await page.waitForFunction(expected => [...document.querySelectorAll("[data-workbot-composer] textarea")].some(node => node.clientHeight > 0 && node.value === expected), text)
}
async function assertNoOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal page overflow")
}
async function assertDesktopColumn(page) {
  const box = await page.locator("[data-workbot-composer]").filter({ visible: true }).first().boundingBox()
  const available = await page.locator(".workbot-layout-main").filter({ visible: true }).first().boundingBox()
  assert.ok(box && available, "The real composer and available chat area are visible")
  const centerOffset = Math.abs(box.x + box.width / 2 - (available.x + available.width / 2))
  report.desktopGeometry ??= []
  report.desktopGeometry.push({ viewport: page.viewportSize(), composer: box, available, centerOffset })
  assert.ok(box.width <= 800, `Composer column is at most 800px wide, got ${box.width}`)
  assert.ok(centerOffset <= 2, `Composer is centered in the area after navigation, offset ${centerOffset}px`)
  assert.ok(box.x >= available.x && box.x + box.width <= available.x + available.width + 1, "Composer fits in the available chat area")
  await assertNoOverflow(page)
}
const appsTab = profile => profile.getByRole("tab", { name: /^(What I can use|Permissions|Apps)$/ })
async function selectedTab(tab) {
  await tab.waitFor()
  await tab.page().waitForFunction(element => element.getAttribute("aria-selected") === "true", await tab.elementHandle())
}
async function assertProfile(page, destination, screenshotName) {
  const profile = page.locator("[data-workbot-profile]")
  await profile.waitFor()
  const tasks = profile.getByRole("tab", { name: "Tasks", exact: true })
  const apps = appsTab(profile)
  await selectedTab(destination === "Tasks" ? tasks : apps)
  if (destination === "Apps") await profile.getByRole("tabpanel").getByText("Gmail", { exact: true }).waitFor()
  await shot(page, screenshotName)
  // Verify the mounted profile is interactive, not merely the right initial label.
  await (destination === "Tasks" ? apps : tasks).click()
  await selectedTab(destination === "Tasks" ? apps : tasks)
  await (destination === "Tasks" ? tasks : apps).click()
  await selectedTab(destination === "Tasks" ? tasks : apps)
  assert.equal(await profile.getByRole("tab", { name: /^(Computer|Browser)$/ }).count(), 0, "Browser access belongs to the inline card, not profile navigation")
  await page.keyboard.press("Escape")
  await profile.waitFor({ state: "hidden" })
  const input = composer(page)
  const before = await input.inputValue()
  await input.click()
  await input.fill(`${before} Still editable.`)
  assert.equal(await input.inputValue(), `${before} Still editable.`, "Closing the real profile leaves a usable composer")
  await input.fill(before)
  await assertNoOverflow(page)
}

try {
  const page = await createPage()
  await open(page)
  // Always capture before probing a new-layout selector: a baseline run still produces useful evidence.
  await shot(page, "desktop-1440x1000")
  if (baseline) {
    const desktopPresent = await desktopNav(page).isVisible()
    await page.setViewportSize({ width: 1920, height: 1080 })
    await shot(page, "desktop-1920x1080")
    const phone = await createPage(true)
    await open(phone)
    await shot(phone, "iphone-390x844-closed")
    const phonePresent = await trigger(phone).isVisible()
    const legacy = phone.getByRole("button", { name: "Chats", exact: true })
    if (phonePresent) await trigger(phone).click()
    else if (await legacy.isVisible()) await legacy.click()
    await shot(phone, "iphone-390x844-open")
    report.baselineLayout = { desktopPresent, phonePresent }
    assert.ok(desktopPresent && phonePresent, "Expected baseline failure: pre-change UI lacks persistent desktop navigation and the workspace drawer")
    throw new Error("Baseline unexpectedly passed the new-layout presence checks; use the pre-change fixture for before evidence")
  }

  await check(page, "desktop direct chats and real destinations", async () => {
    await desktopNav(page).waitFor()
    await assertList(desktopNav(page))
    await assertDestinations(desktopNav(page))
    const main = desktopNav(page).getByRole("navigation", { name: "Chats", exact: true }).getByRole("button", { name: /^Main chat/ })
    assert.equal(await main.getAttribute("aria-current"), "page")
    assert.equal(await trigger(page).isVisible(), false, "Desktop has no mobile trigger")
    await assertDesktopColumn(page)
    await shot(page, "desktop-1440x1000")
    await page.setViewportSize({ width: 1920, height: 1080 })
    await assertList(desktopNav(page))
    await assertDesktopColumn(page)
    await shot(page, "desktop-1920x1080")
  })
  for (const destination of ["Tasks", "Apps"]) {
    await check(page, `desktop rail ${destination} opens the interactive real profile`, async () => {
      await desktopNav(page).getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: destination, exact: true }).click()
      await assertProfile(page, destination, `desktop-profile-${destination.toLowerCase()}`)
      await assertDesktopColumn(page)
    })
  }
  await check(page, "side selection URL highlight and plus new chat", async () => {
    await chatButton(desktopNav(page), "Office plan").click()
    await page.waitForURL(url => url.searchParams.get("chat") === office.id)
    assert.equal(await chatButton(desktopNav(page), "Office plan").getAttribute("aria-current"), "page")
    await composer(page).fill(draft)
    await sideSection(desktopNav(page)).getByRole("button", { name: "New side chat", exact: true }).click()
    await page.waitForURL(url => /^[a-z0-9]{16,40}$/.test(url.searchParams.get("chat") ?? "") && !side.some(chat => chat.id === url.searchParams.get("chat")))
    assert.equal(await composer(page).inputValue(), "", "A newly created chat must not inherit another chat's draft")
    await chatButton(desktopNav(page), "Office plan").click()
    await assertDraft(page)
    await shot(page, "desktop-selected-side-chat")
  })
  await check(page, "search filter no match and keyboard selection", async () => {
    const nav = desktopNav(page)
    const search = nav.getByRole("searchbox", { name: "Search side chats", exact: true })
    await search.fill("WEEKLY")
    await chatButton(nav, "Weekly review").waitFor()
    assert.equal(await chatButton(nav, "Office plan").count(), 0)
    assert.equal(await chatButton(nav, "Casual greeting").count(), 0)
    await search.fill("not a chat title")
    await nav.getByRole("status").filter({ hasText: "No matching side chats." }).waitFor()
    await shot(page, "desktop-search-empty")
    await search.fill("weekly")
    await search.focus()
    // The filter is above Main chat and the plus control on desktop. Exercise the
    // real tab order without assuming the result is the immediately next control.
    const focusPath = []
    let reachedChat = false
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press("Tab")
      focusPath.push(await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() })))
      if (await chatButton(nav, "Weekly review").evaluate(node => node === document.activeElement)) {
        reachedChat = true
        break
      }
    }
    report.keyboardFocusPath = focusPath
    assert.ok(reachedChat, `Tab reaches the filtered chat through the visible navigation controls: ${JSON.stringify(focusPath)}`)
    await page.keyboard.press("Enter")
    await page.waitForURL(url => url.searchParams.get("chat") === weekly.id)
    assert.equal(await chatButton(nav, "Weekly review").getAttribute("aria-current"), "page")
    await search.fill("")
    await chatButton(nav, "Office plan").click()
    await assertDraft(page)
  })
  await check(page, "desktop resize to phone and back preserves draft", async () => {
    // Recover independently even if the preceding keyboard assertion failed with
    // a filtered list; do not turn one failure into a second unrelated timeout.
    await desktopNav(page).getByRole("searchbox", { name: "Search side chats", exact: true }).fill("")
    await chatButton(desktopNav(page), "Office plan").click()
    await composer(page).fill(draft)
    await page.setViewportSize({ width: 390, height: 844 })
    await trigger(page).waitFor()
    assert.equal(await desktopNav(page).isVisible(), false)
    await assertDraft(page)
    await trigger(page).click()
    await assertList(drawer(page))
    await page.keyboard.press("Escape")
    await drawer(page).waitFor({ state: "hidden" })
    await assertDraft(page)
    await shot(page, "resized-desktop-to-phone")
    await page.setViewportSize({ width: 1440, height: 1000 })
    await desktopNav(page).waitFor()
    await assertDraft(page)
    assert.equal(await drawer(page).isVisible(), false)
  })

  const phone = await createPage(true)
  await open(phone)
  await check(phone, "iPhone drawer capabilities Escape and focus return", async () => {
    await trigger(phone).waitFor()
    assert.equal(await desktopNav(phone).isVisible(), false)
    await assertNoOverflow(phone)
    await shot(phone, "iphone-390x844-closed")
    await composer(phone).fill("An unsent main chat draft.")
    await trigger(phone).focus()
    await phone.keyboard.press("Enter")
    await drawer(phone).waitFor()
    await assertDestinations(drawer(phone), true)
    await assertList(drawer(phone))
    assert.equal(await drawer(phone).evaluate(node => node.contains(document.activeElement)), true, "Focus enters the actual modal drawer")
    await shot(phone, "iphone-390x844-open")
    await phone.keyboard.press("Escape")
    await drawer(phone).waitFor({ state: "hidden" })
    await phone.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open workspace navigation")
    await assertDraft(phone, "An unsent main chat draft.")
  })
  for (const destination of ["Tasks", "Apps"]) {
    await check(phone, `iPhone drawer ${destination} closes navigation and opens the interactive real profile`, async () => {
      assert.equal(new URL(phone.url()).searchParams.has("chat"), false, "This flow returns to the main composer")
      await trigger(phone).click()
      await drawer(phone).getByRole("navigation", { name: "Tabs", exact: true }).getByRole("button", { name: destination, exact: true }).click()
      await drawer(phone).waitFor({ state: "hidden" })
      await assertProfile(phone, destination, `iphone-profile-${destination.toLowerCase()}`)
      await assertDraft(phone, "An unsent main chat draft.")
      await assertNoOverflow(phone)
    })
  }
  await check(phone, "iPhone side selection closes drawer and retains chat drafts", async () => {
    await trigger(phone).click()
    await chatButton(drawer(phone), "Office plan").click()
    await phone.waitForURL(url => url.searchParams.get("chat") === office.id)
    await drawer(phone).waitFor({ state: "hidden" })
    await composer(phone).fill(draft)
    await trigger(phone).click()
    assert.equal(await chatButton(drawer(phone), "Office plan").getAttribute("aria-current"), "page")
    await drawer(phone).getByRole("button", { name: "Main chat", exact: true }).click()
    await phone.waitForURL(url => !url.searchParams.has("chat"))
    await drawer(phone).waitFor({ state: "hidden" })
    await assertDraft(phone, "An unsent main chat draft.")
    await trigger(phone).click()
    await chatButton(drawer(phone), "Office plan").click()
    await drawer(phone).waitFor({ state: "hidden" })
    await assertDraft(phone)
    await shot(phone, "iphone-selected-side-chat-closed")
  })
  await check(phone, "iPhone Files opens the existing real Files panel", async () => {
    await trigger(phone).click()
    await drawer(phone).getByRole("button", { name: "Files", exact: true }).click()
    await drawer(phone).waitFor({ state: "hidden" })
    const files = phone.getByRole("dialog", { name: "Files", exact: true })
    await files.waitFor()
    await files.getByText(/Files you send Workbot/).waitFor()
    await shot(phone, "iphone-real-files-panel")
    await files.getByRole("button", { name: "Close", exact: true }).click()
    await files.waitFor({ state: "hidden" })
    await assertDraft(phone)
  })
  // Full reloads intentionally reset React Query so these are cold empty/error states,
  // not misleading tests of stale cached list data.
  await check(page, "empty chats state remains actionable", async () => {
    state = "empty"
    await open(page)
    await desktopNav(page).getByRole("button", { name: "Start a side chat", exact: true }).waitFor()
    assert.equal(await sideSection(desktopNav(page)).locator("li").count(), 0)
    await shot(page, "desktop-empty-side-chats")
    await desktopNav(page).getByRole("button", { name: "Start a side chat", exact: true }).click()
    await page.waitForURL(url => /^[a-z0-9]{16,40}$/.test(url.searchParams.get("chat") ?? ""))
  })
  await check(page, "error retry really refetches chats", async () => {
    state = "error"
    await open(page)
    const nav = desktopNav(page)
    await nav.getByText("Couldn't load your side chats.", { exact: false }).waitFor({ timeout: 15000 })
    const retry = nav.getByRole("button", { name: "Try again", exact: true })
    await retry.waitFor()
    await shot(page, "desktop-side-chats-error")
    const before = chatReads
    state = "populated"
    await retry.click()
    await assertList(nav)
    assert.ok(chatReads > before, "Retry must make a real intercepted chats request")
    assert.equal(await retry.count(), 0)
    await shot(page, "desktop-side-chats-retry")
  })
  assert.deepEqual(report.errors, [], "No browser runtime errors (the injected 503 is intentional)")
  assert.equal(report.checks.filter(check => !check.passed).length, 0, "Navigation checks failed; see navigation-browser-report.json")
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(path.join(output, "navigation-browser-report.json"), JSON.stringify(report, null, 2))
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  console.log(JSON.stringify({ checks: report.checks.length, failures: report.checks.filter(check => !check.passed).length, baseline, screenshots: output, liveIntegration: false }, null, 2))
}
