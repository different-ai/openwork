import { randomBytes } from "node:crypto"
import { KEY_DEFINITIONS, LIMITS, validateAction, validateHumanInput, type BrowserAction, type KeyDefinition } from "./actions"
import { CdpCommandError, debuggerUrlFor, endpointUrl, isRecord, numberField, stringField, type CdpConnection } from "./cdp"
import { CloudBrowserError, type BrowserEndpoint, type CloudBrowserErrorCode } from "./contract"
import { cookiesToRemember } from "./cookies"
import { OBSERVE_SCRIPT, PREPARE_ACTION_SCRIPT } from "./page-scripts"
import { displayUrl, isReadableUrl, parseNavigableUrl } from "./url"

/**
 * Stateless page operations. Each call finds its tab again, so consecutive
 * calls may come from different Den replicas. Semantics follow the desktop
 * browser task host (apps/desktop/electron/browser-task.mjs): observe before
 * acting, refs expire with the observation, every action is consumed before it
 * is dispatched, and password or one-time-code fields are never filled by the
 * agent.
 *
 * Every round trip counts when the browser sits behind a remote proxy, so
 * reads that need no DevTools socket (tabs, status) use plain HTTP, and input
 * events are pipelined on one socket (CDP applies them in order).
 */

/** What HTTP-only reads need. */
export type PageEndpoint = {
  endpoint: BrowserEndpoint
  fetch?: typeof fetch
}

export type BrowserSession = PageEndpoint & {
  cdp: CdpConnection
  /** Set once input may have reached the page; timeouts after that are never retry-safe. */
  progress: { dispatched: boolean }
}

export type BrowserTab = { tabId: string; url: string; title: string }

export type NavigationResult = {
  ok: true
  tabId: string
  url: string
  title: string
  /** False when the page was still loading at the wait bound. */
  loaded: boolean
  next: "observe"
}

export type ObservedElement = {
  ref: string
  role: string
  name: string
  bounds: { x: number; y: number; width: number; height: number }
  sensitive: boolean
  disabled?: true
}

export type Observation = {
  ok: true
  tabId: string
  observationId: string
  url: string
  title: string
  text: string
  elements: ObservedElement[]
  moreElements: boolean
  viewport: { width: number; height: number }
  scroll: { x: number; y: number }
  hasPasswordField: boolean
  trust: "untrusted-site-content"
  /** Present when more than one tab is open. */
  tabs?: Array<BrowserTab & { active: boolean }>
  image?: { mimeType: "image/jpeg"; data: string }
  /** Why an image was requested but not taken. */
  imageOmitted?: "sign_in_page"
  next: "act" | "handoff"
}

export type ActReceipt = {
  ok: true
  dispatched: true
  outcome: "not_yet_verified"
  retrySafe: false
  tabId: string
  next: "observe"
  message: string
}

export type BrowserStatus = {
  running: boolean
  /** Origin and path of the active tab; never the query or fragment. */
  url: string | null
  title: string | null
}

export type ScreenshotOptions = { format?: "jpeg" | "png"; quality?: number }

const WORLD_NAME = "openwork-cloud-browser"
const MAX_TABS = 5
const TRUST = "untrusted-site-content"
const DOCUMENT_WAIT_MS = 5_000

const ACTION_MESSAGES: Partial<Record<CloudBrowserErrorCode, string>> = {
  stale_observation: "The page changed since it was observed. Observe again before acting.",
  stale_element: "That control is gone. Observe again before acting.",
  sign_in_required: "This needs the person: call browser_handoff so they can sign in or enter it themselves.",
  element_disabled: "That control is disabled. Observe again and choose another.",
  element_obscured: "Something covers that control. Observe again; close the overlay or scroll first.",
  element_outside_viewport: "That control is outside the visible page. Scroll, then observe again.",
  outside_viewport: "Those coordinates are outside the visible page.",
  not_editable: "That control does not accept text. Choose a text field from the observation.",
  image_required: "Observe with includeImage before clicking image coordinates.",
  unverifiable_focus: "Keys can't be sent into an embedded frame. Hand off to the person for this step.",
}

function isActionErrorCode(value: unknown): value is CloudBrowserErrorCode {
  return typeof value === "string" && Object.hasOwn(ACTION_MESSAGES, value)
}

type TabTarget = BrowserTab & { webSocketDebuggerUrl: string | null }

/** Page targets, most recently active first, as Chrome's `/json/list` reports them. */
async function listTargets(page: PageEndpoint): Promise<TabTarget[]> {
  const fetchImpl = page.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(endpointUrl(page.endpoint, "/json/list"), {
      headers: page.endpoint.headers,
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    throw new CloudBrowserError("not_running", "The browser is not answering.", { cause: error })
  }
  const payload: unknown = response.ok ? await response.json().catch(() => null) : null
  if (!Array.isArray(payload)) throw new CloudBrowserError("not_running", "The browser did not list its tabs.")
  const tabs: TabTarget[] = []
  for (const entry of payload) {
    if (!isRecord(entry) || entry.type !== "page") continue
    const tabId = stringField(entry, "id")
    const url = stringField(entry, "url") ?? ""
    if (!tabId || url.startsWith("devtools://")) continue
    tabs.push({ tabId, url, title: stringField(entry, "title") ?? "", webSocketDebuggerUrl: stringField(entry, "webSocketDebuggerUrl") ?? null })
  }
  return tabs
}

/** Open tabs, most recently active first. */
export async function listTabs(page: PageEndpoint): Promise<BrowserTab[]> {
  return (await listTargets(page)).map(({ tabId, url, title }) => ({ tabId, url, title }))
}

function pickTab(tabs: BrowserTab[], tabId: string | undefined): BrowserTab {
  const tab = tabId ? tabs.find((candidate) => candidate.tabId === tabId) : tabs[0]
  if (tab) return tab
  throw new CloudBrowserError(
    "tab_not_found",
    tabId ? "That tab is closed. Observe without a tabId to use the active tab." : "No page is open. Open a website first.",
  )
}

function assertReadable(url: string) {
  if (/^https?:/i.test(url) && !isReadableUrl(url)) {
    throw new CloudBrowserError("blocked_url", "This tab shows a private or internal address, which can't be read.")
  }
}

async function attach(session: BrowserSession, tabId: string): Promise<string> {
  try {
    const result = await session.cdp.send("Target.attachToTarget", { targetId: tabId, flatten: true })
    const sessionId = stringField(result, "sessionId")
    if (!sessionId) throw new CloudBrowserError("browser_operation_failed", "The browser did not attach to the tab.")
    return sessionId
  } catch (error) {
    if (error instanceof CdpCommandError) throw new CloudBrowserError("tab_not_found", "That tab is closed. Observe again.", { cause: error })
    throw error
  }
}

/** Makes the tab the active one (and renders it, which background tabs may not). */
async function activate(session: BrowserSession, tabId: string) {
  await session.cdp.send("Target.activateTarget", { targetId: tabId }).catch(() => undefined)
}

async function isolatedContext(session: BrowserSession, sessionId: string, tabId: string): Promise<number> {
  // A page target's id is its main frame's id, which saves a round trip.
  let world = await session.cdp.send("Page.createIsolatedWorld", { frameId: tabId, worldName: WORLD_NAME }, { sessionId }).catch(() => null)
  if (!world) {
    const tree = await session.cdp.send("Page.getFrameTree", {}, { sessionId })
    const frameTree = isRecord(tree.frameTree) ? tree.frameTree : {}
    const frame = isRecord(frameTree.frame) ? frameTree.frame : {}
    world = await session.cdp.send("Page.createIsolatedWorld", { frameId: stringField(frame, "id") ?? "", worldName: WORLD_NAME }, { sessionId })
  }
  const contextId = numberField(world, "executionContextId")
  if (contextId === undefined) throw new CloudBrowserError("browser_operation_failed", "The page did not create a script context.")
  return contextId
}

async function evaluate(session: BrowserSession, sessionId: string, contextId: number, source: string, argument: unknown): Promise<unknown> {
  let result: Record<string, unknown>
  try {
    result = await session.cdp.send("Runtime.evaluate", {
      expression: `(${source})(${JSON.stringify(argument)})`,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    }, { sessionId })
  } catch (error) {
    // The context disappears when the page navigates mid-call.
    if (error instanceof CdpCommandError) throw new CloudBrowserError("stale_observation", "The page changed. Observe again.", { cause: error })
    throw error
  }
  if (isRecord(result.exceptionDetails)) throw new CloudBrowserError("browser_operation_failed", "The page could not be read. Observe again.")
  const remote = isRecord(result.result) ? result.result : {}
  return remote.value
}

async function targetInfo(session: BrowserSession, tabId: string): Promise<BrowserTab> {
  const result = await session.cdp.send("Target.getTargetInfo", { targetId: tabId })
  const info = isRecord(result.targetInfo) ? result.targetInfo : {}
  return { tabId, url: stringField(info, "url") ?? "", title: stringField(info, "title") ?? "" }
}

async function navigateTab(session: BrowserSession, tabId: string, url: URL): Promise<NavigationResult> {
  const sessionId = await attach(session, tabId)
  await session.cdp.send("Page.enable", {}, { sessionId })
  const loaded = session.cdp.waitForEvent((event) => event.sessionId === sessionId && event.method === "Page.loadEventFired", LIMITS.loadWaitMs)
  let result: Record<string, unknown>
  try {
    result = await session.cdp.send("Page.navigate", { url: url.href }, { sessionId, timeoutMs: LIMITS.loadWaitMs })
  } catch (error) {
    loaded.cancel()
    if (error instanceof CdpCommandError) throw new CloudBrowserError("navigation_failed", "The site could not be opened.", { cause: error })
    throw error
  }
  const errorText = stringField(result, "errorText")
  if (errorText) {
    loaded.cancel()
    throw new CloudBrowserError("navigation_failed", `The site could not be opened (${errorText}). Check the address.`)
  }
  let finished = true
  if (stringField(result, "loaderId")) {
    try {
      await loaded.promise
    } catch (error) {
      if (!(error instanceof CloudBrowserError) || error.code !== "timeout") throw error
      finished = false
    }
  } else {
    loaded.cancel()
  }
  await activate(session, tabId)
  const info = await targetInfo(session, tabId)
  if (/^https?:/i.test(info.url) && !isReadableUrl(info.url)) {
    const blank = session.cdp.waitForEvent((event) => event.sessionId === sessionId && event.method === "Page.loadEventFired", 3_000)
    await session.cdp.send("Page.navigate", { url: "about:blank" }, { sessionId }).catch(() => undefined)
    await blank.promise.catch(() => undefined)
    throw new CloudBrowserError("blocked_url", "The site redirected to a private or internal address, which can't be opened.")
  }
  return { ok: true, tabId, url: displayUrl(info.url), title: info.title.slice(0, 300), loaded: finished, next: "observe" }
}

/** Opens a website: reuses a tab already showing it, else navigates the active tab. */
export async function openUrl(session: BrowserSession, input: { url: string }): Promise<NavigationResult> {
  const url = parseNavigableUrl(input.url)
  const tabs = await listTabs(session)
  const existing = tabs.find((tab) => tab.url === url.href)
  if (existing) {
    await activate(session, existing.tabId)
    return { ok: true, tabId: existing.tabId, url: displayUrl(existing.url), title: existing.title.slice(0, 300), loaded: true, next: "observe" }
  }
  let tabId: string | undefined = tabs[0]?.tabId
  if (!tabId) {
    const created = await session.cdp.send("Target.createTarget", { url: "about:blank" })
    tabId = stringField(created, "targetId")
    if (!tabId) throw new CloudBrowserError("browser_operation_failed", "The browser could not open a tab.")
  }
  // Popups and new-tab links accumulate; keep the most recently used few.
  for (const extra of tabs.slice(MAX_TABS)) {
    if (extra.tabId !== tabId) await session.cdp.send("Target.closeTarget", { targetId: extra.tabId }).catch(() => undefined)
  }
  return navigateTab(session, tabId, url)
}

export async function navigate(session: BrowserSession, input: { tabId?: string; url: string }): Promise<NavigationResult> {
  const url = parseNavigableUrl(input.url)
  const tab = pickTab(await listTabs(session), input.tabId)
  return navigateTab(session, tab.tabId, url)
}

/** `<base36 time>.<random>`: freshness can be checked by any replica without shared state. */
export function newObservationId(now: number = Date.now()): string {
  return `${now.toString(36)}.${randomBytes(6).toString("hex")}`
}

export function observationAgeMs(observationId: string, now: number = Date.now()): number {
  const match = /^([0-9a-z]{1,12})\.[0-9a-f]{12}$/.exec(observationId)
  if (!match?.[1]) return Number.POSITIVE_INFINITY
  const issuedAt = Number.parseInt(match[1], 36)
  return Number.isFinite(issuedAt) && issuedAt <= now + 1_000 ? now - issuedAt : Number.POSITIVE_INFINITY
}

function parseBounds(value: unknown): ObservedElement["bounds"] | null {
  if (!isRecord(value)) return null
  const x = numberField(value, "x")
  const y = numberField(value, "y")
  const width = numberField(value, "width")
  const height = numberField(value, "height")
  return x === undefined || y === undefined || width === undefined || height === undefined ? null : { x, y, width, height }
}

function parseObservedPage(value: unknown) {
  if (!isRecord(value)) throw new CloudBrowserError("browser_operation_failed", "The page could not be read. Observe again.")
  const elements: ObservedElement[] = []
  for (const entry of Array.isArray(value.elements) ? value.elements : []) {
    if (!isRecord(entry)) continue
    const ref = stringField(entry, "ref")
    const bounds = parseBounds(entry.bounds)
    if (!ref || !bounds) continue
    const element: ObservedElement = {
      ref,
      role: stringField(entry, "role") ?? "",
      name: stringField(entry, "name") ?? "",
      bounds,
      sensitive: entry.sensitive === true,
    }
    if (entry.disabled === true) element.disabled = true
    elements.push(element)
  }
  const viewport = isRecord(value.viewport) ? value.viewport : {}
  const scroll = isRecord(value.scroll) ? value.scroll : {}
  return {
    url: stringField(value, "url") ?? "",
    title: stringField(value, "title") ?? "",
    text: stringField(value, "text") ?? "",
    elements,
    moreElements: value.moreElements === true,
    viewport: { width: numberField(viewport, "width") ?? 0, height: numberField(viewport, "height") ?? 0 },
    scroll: { x: numberField(scroll, "x") ?? 0, y: numberField(scroll, "y") ?? 0 },
    hasPasswordField: value.hasPasswordField === true,
  }
}

export async function capture(cdp: CdpConnection, sessionId: string | undefined, options: ScreenshotOptions, timeoutMs?: number): Promise<Buffer> {
  const format = options.format ?? "jpeg"
  const result = await cdp.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: Math.max(10, Math.min(100, Math.round(options.quality ?? 60))) } : {}),
    fromSurface: true,
    captureBeyondViewport: false,
  }, { sessionId, timeoutMs })
  const data = stringField(result, "data")
  if (!data) throw new CloudBrowserError("browser_operation_failed", "The browser did not return a screenshot.")
  return Buffer.from(data, "base64")
}

/** Reads the page and its visible controls; page content is untrusted data. */
export async function observe(session: BrowserSession, input: { tabId?: string; includeImage?: boolean; imageQuality?: number } = {}): Promise<Observation> {
  const tabs = await listTabs(session)
  const tab = pickTab(tabs, input.tabId)
  assertReadable(tab.url)
  if (tab.tabId !== tabs[0]?.tabId) await activate(session, tab.tabId)
  const sessionId = await attach(session, tab.tabId)
  const contextId = await isolatedContext(session, sessionId, tab.tabId)
  const includeImage = input.includeImage !== false
  const observationId = newObservationId()
  const page = parseObservedPage(await evaluate(session, sessionId, contextId, OBSERVE_SCRIPT, {
    id: observationId,
    image: includeImage,
    maxElements: LIMITS.elements,
    maxText: LIMITS.textChars,
    waitMs: DOCUMENT_WAIT_MS,
  }))
  assertReadable(page.url)
  const observation: Observation = {
    ok: true,
    tabId: tab.tabId,
    observationId,
    url: displayUrl(page.url),
    title: page.title,
    text: page.text,
    elements: page.elements,
    moreElements: page.moreElements,
    viewport: page.viewport,
    scroll: page.scroll,
    hasPasswordField: page.hasPasswordField,
    trust: TRUST,
    next: page.hasPasswordField ? "handoff" : "act",
  }
  if (tabs.length > 1) {
    observation.tabs = tabs.slice(0, MAX_TABS).map((entry) => ({
      tabId: entry.tabId,
      url: displayUrl(entry.url),
      title: entry.title.slice(0, 120),
      active: entry.tabId === tab.tabId,
    }))
  }
  if (includeImage) {
    // Sign-in pages can show one-time codes in clear text; the person takes over instead.
    if (page.hasPasswordField) observation.imageOmitted = "sign_in_page"
    else observation.image = { mimeType: "image/jpeg", data: (await capture(session.cdp, sessionId, { format: "jpeg", quality: input.imageQuality ?? 60 })).toString("base64") }
  }
  return observation
}

function keyEvents(definition: KeyDefinition): Array<Record<string, unknown>> {
  const common = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, nativeVirtualKeyCode: definition.keyCode }
  return [
    { type: definition.text ? "keyDown" : "rawKeyDown", ...common, ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}) },
    { type: "keyUp", ...common },
  ]
}

function clickEvents(x: number, y: number, clickCount = 1): Array<Record<string, unknown>> {
  return [
    { type: "mouseMoved", x, y },
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount },
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount },
  ]
}

function characterKey(character: string): KeyDefinition {
  const upper = character.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: character }
  if (/^[0-9]$/.test(character)) return { key: character, code: `Digit${character}`, keyCode: character.charCodeAt(0), text: character }
  if (character === " ") return KEY_DEFINITIONS.Space
  return { key: character, code: "", keyCode: 0, text: character }
}

type InputCommand = { method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText"; params: Record<string, unknown> }

/**
 * Sends one group of input without waiting for each reply. Only safe within a
 * kind: keyboard events stay in order among themselves, but they can overtake
 * a mouse event (and the focus it moves), so mouse groups are awaited first.
 */
async function sendInput(session: BrowserSession, sessionId: string, commands: InputCommand[]) {
  await Promise.all(commands.map((command) => session.cdp.send(command.method, command.params, { sessionId })))
}

const mouse = (events: Array<Record<string, unknown>>): InputCommand[] => events.map((params) => ({ method: "Input.dispatchMouseEvent", params }))
const keys = (events: Array<Record<string, unknown>>): InputCommand[] => events.map((params) => ({ method: "Input.dispatchKeyEvent", params }))

/** Real key events for ordinary typing (sites listen for them); one insert for pastes and other scripts. */
function typing(text: string): InputCommand[] {
  if (text.length <= 64 && /^[\x20-\x7e]+$/.test(text)) return [...text].flatMap((character) => keys(keyEvents(characterKey(character))))
  return [{ method: "Input.insertText", params: { text } }]
}

function actionInput(action: BrowserAction, point: { x: number; y: number }): InputCommand[] {
  switch (action.type) {
    case "click":
      return mouse(clickEvents(point.x, point.y))
    case "fill":
      // The prepared field's value is selected: inserting replaces it, an empty fill clears it.
      return action.text === "" ? keys(keyEvents(KEY_DEFINITIONS.Backspace)) : [{ method: "Input.insertText", params: { text: action.text } }]
    case "key":
      return keys(keyEvents(KEY_DEFINITIONS[action.key]))
    case "scroll":
      return mouse([{ type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: action.deltaY }])
  }
}

/** Dispatches one action against a fresh observation. Returns a receipt, never proof of success. */
export async function act(
  session: BrowserSession,
  input: { tabId?: string; observationId: string; action: unknown },
  now: number = Date.now(),
): Promise<ActReceipt> {
  const action = validateAction(input.action)
  if (observationAgeMs(input.observationId, now) > LIMITS.observationMs) {
    throw new CloudBrowserError("stale_observation", "The observation expired. Observe again before acting.")
  }
  const tab = pickTab(await listTabs(session), input.tabId)
  assertReadable(tab.url)
  const sessionId = await attach(session, tab.tabId)
  const contextId = await isolatedContext(session, sessionId, tab.tabId)
  const prepared = await evaluate(session, sessionId, contextId, PREPARE_ACTION_SCRIPT, { id: input.observationId, action })
  if (isRecord(prepared) && isActionErrorCode(prepared.error)) {
    throw new CloudBrowserError(prepared.error, ACTION_MESSAGES[prepared.error] ?? "Observe again before acting.")
  }
  const x = isRecord(prepared) ? numberField(prepared, "x") : undefined
  const y = isRecord(prepared) ? numberField(prepared, "y") : undefined
  if (x === undefined || y === undefined) throw new CloudBrowserError("browser_operation_failed", "The action could not be prepared. Observe again.")
  session.progress.dispatched = true
  try {
    await sendInput(session, sessionId, actionInput(action, { x, y }))
  } catch (error) {
    throw new CloudBrowserError("browser_operation_failed", "The action may have reached the page. Observe before deciding what remains.", { dispatched: true, cause: error })
  }
  return {
    ok: true,
    dispatched: true,
    outcome: "not_yet_verified",
    retrySafe: false,
    tabId: tab.tabId,
    next: "observe",
    message: "Observe the page and verify the requested outcome before reporting success.",
  }
}

/**
 * The active tab and its own DevTools socket URL (reachable through the
 * endpoint), for the live view: capturing over the tab's socket needs no
 * browser socket or attach.
 */
export async function activeTabSocket(page: PageEndpoint): Promise<{ tabId: string; socketUrl: string } | null> {
  const tab = (await listTargets(page))[0]
  if (!tab?.webSocketDebuggerUrl) return null
  return { tabId: tab.tabId, socketUrl: debuggerUrlFor(page.endpoint.cdpUrl, tab.webSocketDebuggerUrl) }
}

/**
 * The person's own input during take-over. Unlike agent actions this may type
 * into password fields: it is the person signing in, straight to the site.
 */
export async function dispatchInput(session: BrowserSession, input: { tabId?: string; events: unknown }): Promise<void> {
  const events = validateHumanInput(input.events)
  const tab = pickTab(await listTabs(session), input.tabId)
  const sessionId = await attach(session, tab.tabId)
  session.progress.dispatched = true
  // Each mouse event completes (and moves focus) before what follows; runs of
  // typing are pipelined.
  let typed: InputCommand[] = []
  for (const event of events) {
    if (event.type === "text" || event.type === "key") {
      typed.push(...(event.type === "text" ? typing(event.text) : keys(keyEvents(KEY_DEFINITIONS[event.key]))))
      continue
    }
    if (typed.length > 0) await sendInput(session, sessionId, typed)
    typed = []
    await sendInput(session, sessionId, event.type === "click"
      ? mouse(clickEvents(event.x, event.y, event.clickCount ?? 1))
      : mouse([{ type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX ?? 0, deltaY: event.deltaY }]))
  }
  if (typed.length > 0) await sendInput(session, sessionId, typed)
}

/** The active tab's address and title, over HTTP only. */
export async function readStatus(page: PageEndpoint): Promise<BrowserStatus> {
  const tab = (await listTabs(page))[0]
  if (!tab) return { running: true, url: null, title: null }
  return { running: true, url: displayUrl(tab.url) || null, title: tab.title.slice(0, 300) || null }
}

/** Makes the current sign-in survive a browser restart: session cookies become persistent. */
export async function rememberLogins(session: BrowserSession, now: number = Date.now()): Promise<{ remembered: number }> {
  const result = await session.cdp.send("Storage.getCookies", {})
  const cookies = cookiesToRemember(Array.isArray(result.cookies) ? result.cookies : [], now)
  if (cookies.length > 0) await session.cdp.send("Storage.setCookies", { cookies })
  return { remembered: cookies.length }
}
