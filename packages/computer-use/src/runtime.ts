import { CodeMode, Tool } from "@openwork/codemode"
import { Effect } from "effect"
import { z } from "zod"

export type Surface = "computer" | "browser"
export type ProgramHost = {
  computer: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  browser: (operation: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}
export type ProgramRequest = {
  surface: Surface
  code: string
  tabId?: string
  input?: unknown
  timeoutMs?: number
}
export type JsonValue = null | string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ProgramResult = {
  ok: boolean; value?: JsonValue; error?: { message: string; code?: string; kind?: string };
  receipts: Array<{ index: number; status: string; completed?: number; failed?: number; skipped?: number }>;
  mayHaveActed: boolean; metrics: { durationMs: number; transportCalls: number; observations: number; actions: number }; images: ProgramImage[];
}
export type ProgramImage = { type: "image"; data: string; mimeType: string }

const record = z.record(z.string(), z.unknown())
const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
const content = z.object({ isError: z.boolean().optional(), content: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }), image])) })
const selector = z.object({
  role: z.string().max(80).optional(), name: z.string().max(300).optional(), text: z.string().max(300).optional(),
  exact: z.boolean().optional(), nth: z.number().int().min(0).max(499).optional(),
}).strict().refine((value) => value.role || value.name || value.text, "Name a role, name or text to find.")
const targetInput = z.object({ target: selector }).strict()
const bounds = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() })
const node = z.object({
  ref: z.string(), name: z.string(), role: z.string(), bounds,
  disabled: z.boolean(), editable: z.boolean(), press: z.boolean(), settable: z.boolean(),
  checked: z.boolean().optional(), value: z.string().optional(), visible: z.boolean().optional(),
  needsReveal: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string(), disabled: z.boolean() })).optional(),
})
type Selector = z.infer<typeof selector>
type Node = z.infer<typeof node>
type Observation = { observationId: string; elements: Node[]; text: string; width: number; height: number; scroll?: { x: number; y: number }; truncated: boolean; progress?: string }

export class ComputerProgramError extends Error {
  constructor(readonly code: string, message: string, readonly mayHaveActed = false) { super(message) }
}
const issue = (code: string, message: string, mayHaveActed = false): never => { throw new ComputerProgramError(code, message, mayHaveActed) }
const stringAt = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback
const numberAt = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback
function roleName(value: unknown, tag?: unknown) {
  const role = stringAt(value).replace(/^AX/, "").toLowerCase()
  const roles: Record<string, string> = { textfield: "textbox", textarea: "textbox", searchfield: "searchbox", popupbutton: "combobox", checkbox: "checkbox", menuitem: "menuitem", statictext: "text", outline: "tree", scrollarea: "region", outlinerow: "row" }
  if (role) return roles[role] ?? role
  const tags: Record<string, string> = { input: "textbox", textarea: "textbox", select: "combobox", button: "button", a: "link", tr: "row", table: "table", h1: "heading", h2: "heading", h3: "heading" }
  return tags[stringAt(tag)] ?? stringAt(tag, "text")
}
function normalizeNode(raw: unknown): Node | null {
  const parsed = record.safeParse(raw)
  if (!parsed.success || typeof parsed.data.ref !== "string") return null
  const value = parsed.data
  const b = record.safeParse(value.bounds)
  const rect = b.success ? b.data : value
  const role = roleName(value.role, value.tag)
  return {
    ref: stringAt(value.ref), name: stringAt(value.label, stringAt(value.name)), role,
    bounds: { x: numberAt(rect.x), y: numberAt(rect.y), width: numberAt(rect.width, numberAt(rect.w)), height: numberAt(rect.height, numberAt(rect.h)) },
    disabled: value.disabled === true || value.enabled === false, editable: ["textbox", "searchbox", "combobox"].includes(role),
    press: value.press === true || Array.isArray(value.actions) && value.actions.includes("press"), settable: value.settable === true,
    ...(typeof value.checked === "boolean" ? { checked: value.checked } : ["checkbox", "switch", "radio"].includes(role) && value.value !== undefined ? { checked: value.value === true || value.value === 1 || value.value === "1" } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(typeof value.visible === "boolean" ? { visible: value.visible } : {}),
    ...(value.needsReveal === true ? { needsReveal: true } : {}),
    ...(Array.isArray(value.options) ? { options: value.options.flatMap(option => {
      const parsed = z.object({value:z.string(),label:z.string(),disabled:z.boolean().default(false)}).safeParse(option)
      return parsed.success ? [parsed.data] : []
    }) } : {}),
  }
}
function matches(element: Node, target: Selector) {
  const compare = (actual: string, expected: string) => target.exact === false ? actual.toLowerCase().includes(expected.toLowerCase()) : actual.toLowerCase() === expected.toLowerCase()
  return (!target.role || compare(element.role, roleName(target.role)))
    && (!target.name || compare(element.name, target.name)) && (!target.text || compare(element.name, target.text))
}
function select(observation: Observation, target: Selector, required = true): Node | null {
  const found = observation.elements.filter((element) => matches(element, target))
  if (target.nth !== undefined) return found[target.nth] ?? (required ? issue("target_not_found", "That matching control is unavailable.") : null)
  if (found.length > 1) return issue("ambiguous_target", "Several controls match. Add a role, a more specific name, or nth; no action ran.")
  return found[0] ?? (required ? issue("target_not_found", "The requested control was not found. Inspect the observation or scroll its container.") : null)
}
function point(element: Node, observation: Observation) {
  const { x, y, width, height } = element.bounds
  const left = Math.max(0, x), top = Math.max(0, y)
  const right = Math.min(observation.width, x + width), bottom = Math.min(observation.height, y + height)
  if (right <= left || bottom <= top) return issue("target_outside_viewport", "The target is outside the current image. Scroll it into view before clicking.")
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}

/** One bounded program, one chat and one surface. Images stay outside the interpreter. */
export async function runComputerProgram(request: ProgramRequest, host: ProgramHost, parentSignal: AbortSignal): Promise<ProgramResult> {
  const timeoutMs = Math.min(60_000, Math.max(1_000, request.timeoutMs ?? 30_000))
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
  let tabId = request.tabId
  let latest: Observation | null = null
  let latestQuery: string | null = null
  let images: ProgramImage[] = []
  let lastFailure: { code: string; message: string } | undefined
  let mayHaveActed = false
  let transportCalls = 0
  let observations = 0
  let actions = 0
  const started = performance.now()
  const receipts: ProgramResult["receipts"] = []
  const metrics = () => ({ durationMs: Math.round(performance.now() - started), transportCalls, observations, actions })
  const invoke = async (name: string, args: Record<string, unknown>, receipt?: ProgramResult["receipts"][number]) => {
    signal.throwIfAborted()
    transportCalls++
    const raw = request.surface === "browser" ? await host.browser(name, { ...args, ...(tabId ? { tabId } : {}) }, signal) : await host.computer(name, args, signal)
    if (request.surface === "browser") {
      const result = record.parse(raw)
      if (receipt) receipt.status = result.ok === true ? result.dispatched === false ? "unchanged" : "dispatched" : result.mayHaveChangedState === true ? "unconfirmed" : "failed"
      signal.throwIfAborted()
      if (typeof result.tabId === "string") tabId = result.tabId
      const bitmap = z.object({ data: z.string(), mimeType: z.string() }).safeParse(result.image)
      if (bitmap.success) images = [{ type: "image", ...bitmap.data }]
      if (result.ok !== true) return issue(stringAt(result.code, "browser_failed"), stringAt(result.error, "The browser operation did not complete."), result.mayHaveChangedState === true)
      return result
    }
    const result = content.safeParse(raw)
    if (!result.success) return issue("computer_unavailable", "The desktop returned no computer receipt.")
    const payloads = result.data.content.flatMap((part) => {
      if (part.type !== "text") return []
      try { const parsed = record.safeParse(JSON.parse(part.text)); return parsed.success ? [parsed.data] : [] } catch { return [] }
    })
    if (receipt) for (const value of payloads) {
      if (typeof value.status === "string") receipt.status = value.status
      else if (value.ok === false) receipt.status = "failed"
      for (const key of ["completed", "failed", "skipped"] as const) if (typeof value[key] === "number") receipt[key] = value[key]
    }
    signal.throwIfAborted()
    const bitmap = result.data.content.filter((part): part is ProgramImage => part.type === "image")
    if (bitmap.length) images = bitmap.slice(-1)
    for (const value of payloads) {
      if (value.ok === false || value.status === "partial") return issue(stringAt(value.code, "action_incomplete"), stringAt(value.message, "The action did not finish. Inspect its receipt before continuing."), value.may_have_acted === true)
      const post = record.safeParse(value.post_observation)
      if (post.success && post.data.ok === false) return issue("post_observation_failed", "Input may have run, but the resulting view is unavailable. Do not replay the program.", true)
    }
    if (result.data.isError) return issue("computer_failed", "The computer tool did not complete.")
    return payloads.findLast((value) => typeof value.observation_id === "string") ?? payloads[0] ?? issue("invalid_receipt", "No readable computer receipt was returned.")
  }
  const normalize = (value: Record<string, unknown>): Observation => {
    const imageInfo = record.safeParse(value.image)
    const viewport = record.safeParse(value.viewport)
    const geometry = viewport.success ? viewport.data : imageInfo.success ? imageInfo.data : value
    const scroll = z.object({ x: z.number(), y: z.number() }).safeParse(value.scroll)
    return {
      observationId: stringAt(value.observationId, stringAt(value.observation_id)),
      elements: Array.isArray(value.elements) ? value.elements.flatMap((item) => { const normalized = normalizeNode(item); return normalized ? [normalized] : [] }) : [],
      text: stringAt(value.text), width: numberAt(geometry.width, 1), height: numberAt(geometry.height, 1),
      truncated: value.truncated === true, progress: JSON.stringify(value.scrollRegions ?? null), ...(scroll.success ? { scroll: scroll.data } : {}),
    }
  }
  const observe = async (includeImage = false, query?: Selector) => {
    images = []
    const value = await invoke(request.surface === "browser" ? "observe" : "computer_observe", request.surface === "browser" ? { includeImage, ...(query ? { query } : {}) } : { include_image: includeImage, elements: "all" })
    latest = normalize(value); latestQuery = query ? JSON.stringify(query) : null; observations++
    if (!latest.observationId) return issue("observation_unavailable", "The current view has no observation identity.")
    return latest
  }
  const act = async (action: Record<string, unknown>) => {
    if (!latest) await observe(request.surface === "computer")
    const observation = latest ?? issue("observation_required", "Observe the current surface first.")
    latest = null
    images = []
    actions++
    // Record before transport: a lost response must never authorize a replay.
    mayHaveActed = true
    const receipt = { index: receipts.length, status: "unconfirmed" }
    receipts.push(receipt)
    const value = await invoke(request.surface === "browser" ? "act" : "computer_act", request.surface === "browser" ? { observationId: observation.observationId, action } : { observation_id: observation.observationId, action }, receipt)
    if (request.surface === "computer" && typeof value.observation_id === "string") { latest = normalize(value); latestQuery = null; observations++ }
    return value
  }
  const pause = async (ms: number) => {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", abort); resolve() }
      const timer = setTimeout(finish, ms)
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  const find = async (target: Selector, required = true, fresh = false) => {
    if (!fresh && latest && (latestQuery === null || latestQuery === JSON.stringify(target))) {
      const cached = select(latest, target, false)
      if (cached) return cached
    }
    return select(await observe(false, target), target, required)
  }
  const ready = (element: Node | null) => {
    if (!element) return issue("target_not_found", "The target is unavailable.")
    if (element.disabled) return issue("element_disabled", "The target is disabled. Wait for it to become ready.")
    return element
  }
  const reveal = async (target: Selector) => {
    let element = ready(await find(target))
    const view = latest
    if (request.surface === "browser" && view && (element.needsReveal || element.visible === false || element.bounds.x < 0 || element.bounds.y < 0 || element.bounds.x + element.bounds.width > view.width || element.bounds.y + element.bounds.height > view.height)) {
      await act({ type: "reveal", ref: element.ref }); element = ready(await find(target))
    }
    return element
  }
  const click = async (target: Selector) => {
    const element = await reveal(target)
    if (request.surface === "browser") await act({ type: "click", ref: element.ref })
    else if (element.press) await act({ type: "press", ref: element.ref })
    else { await observe(true); const fresh = ready(select(latest ?? await observe(true), target)); await act({ type: "click", ...point(fresh, latest ?? await observe(true)) }) }
    return { clicked: true }
  }
  const fill = async (target: Selector, text: string, append = false) => {
    const element = await reveal(target)
    if (!element.editable) return issue("not_editable", "The target is not an editable control.")
    if (request.surface === "browser") {
      if (append && element.value === undefined) return issue("state_unavailable", "Observe the current field value before appending.")
      await act({ type: "fill", ref: element.ref, text: append ? element.value + text : text })
    }
    else if (element.settable && !append) await act({ type: "set_value", ref: element.ref, text })
    else {
      await click(target)
      if (!append) await act({ type: "key", key: "a", modifiers: ["command"] })
      await act({ type: "type", text })
    }
    return { filled: true }
  }
  const waitFor = async (target: Selector, state: "visible" | "hidden" | "enabled", within: number) => {
    const until = Math.min(started + timeoutMs, performance.now() + within)
    do {
      const element = await find(target, false, true)
      const view = latest;
      const visible = element && view && element.visible !== false && element.bounds.width > 0 && element.bounds.height > 0 && element.bounds.x < view.width && element.bounds.y < view.height && element.bounds.x + element.bounds.width > 0 && element.bounds.y + element.bounds.height > 0;
      if (state === "hidden" ? !visible : visible && (state !== "enabled" || !element.disabled)) return { matched: true, state }
      await pause(100)
    } while (performance.now() < until)
    return issue("condition_timeout", "The requested UI condition did not appear before the deadline.")
  }
  const scroll = async (direction: "up" | "down", pages: number, container?: Selector) => {
    const view = await observe(request.surface === "computer", container)
    const region = container ? ready(select(view, container)) : null
    const at = region ? point(region, view) : { x: view.width * 0.65, y: view.height * 0.65 }
    const distance = Math.min(1200, Math.max(100, Math.round((region?.bounds.height ?? view.height) * 0.75 * pages)))
    await act(request.surface === "browser" ? { type: "scroll", ...at, deltaY: direction === "down" ? distance : -distance } : { type: "scroll", ...at, delta_x: 0, delta_y: direction === "down" ? -distance : distance })
    return { scrolled: true }
  }
  const add = <T extends z.ZodType>(description: string, schema: T, run: (input: z.output<T>) => Promise<unknown>) => Tool.make({
    description, input: { type: "object" },
    run: (raw) => Effect.tryPromise({ try: async () => {
      signal.throwIfAborted()
      try { return await run(schema.parse(raw)) }
      catch (error) {
        lastFailure = { code: error instanceof ComputerProgramError ? error.code : "helper_failed", message: error instanceof Error ? error.message : "The UI helper failed." }
        throw error
      }
    }, catch: (error) => error }),
  })
  const tools = { ui: {
    open: add("Open a website or app on this program's surface. Access follows the enabled rollout; no application approval is requested.", z.object({ url: z.url().optional(), appId: z.string().max(256).optional(), mode: z.enum(["observe", "assist", "control"]).default("control"), purpose: z.string().max(500).default("Complete the requested task") }).strict(), async (args) => {
      const input = request.surface === "browser" ? { url: args.url ?? issue("invalid_url", "Provide a website URL.") } : { app_id: args.appId ?? issue("missing_app", "Provide an appId from discovery, or desktop for a Linux VM."), mode: args.mode, purpose: args.purpose }
      latest = null; images = []; mayHaveActed = true; actions++
      const receipt = { index: receipts.length, status: "unconfirmed" }
      receipts.push(receipt)
      await invoke(request.surface === "browser" ? "open" : "computer_open", input, receipt)
      receipt.status = "dispatched"
      return observe(false)
    }),
    observe: add("Read current controls and text; request an image for visual decisions. Images are attached outside the program result.", z.object({ screenshot: z.boolean().default(false) }).strict(), ({ screenshot }) => observe(screenshot)),
    act: add("Dispatch a low-level action against the current observation when semantic controls are unavailable. Observe with screenshot=true before coordinate input.", z.object({ action: z.record(z.string(), z.unknown()) }).strict(), ({ action }) => act(action)),
    find: add("Find one current control by role/name/text. Matching is exact unless exact=false. Ambiguous matches require nth.", targetInput, async ({ target }) => ({ found: Boolean(await find(target, false)), target })),
    exists: add("Read whether a matching current control exists.", targetInput, async ({ target }) => Boolean(await find(target, false))),
    click: add("Resolve and activate a current control, revealing it when supported.", targetInput, ({ target }) => click(target)),
    fill: add("Replace text, or append=true, in a current editable field.", z.object({ target: selector, text: z.string().max(8000), append: z.boolean().default(false) }).strict(), ({ target, text, append }) => fill(target, text, append)),
    fillForm: add("Fill named fields in order. The program stops on the first failure without replaying earlier fields.", z.object({ fields: z.array(z.object({ target: selector, text: z.string().max(8000) }).strict()).min(1).max(20) }).strict(), async ({ fields }) => { for (const field of fields) await fill(field.target, field.text); return { filled: fields.length } }),
    setChecked: add("Set a checkbox to the requested state; do nothing if already correct.", z.object({ target: selector, checked: z.boolean() }).strict(), async ({ target, checked }) => {
      const current = ready(await find(target))
      if (current.checked === undefined) return issue("state_unavailable", "This control exposes no checked state.")
      if (current.checked !== checked) {
        if (request.surface === "browser") { const element = await reveal(target); await act({ type: "set_checked", ref: element.ref, checked }) }
        else await click(target)
      }
      await pause(50)
      if ((await find(target, true, true))?.checked !== checked) return issue("state_not_confirmed", "The requested checkbox state was not confirmed; do not toggle it again blindly.", true)
      return { checked }
    }),
    select: add("Choose an option by its visible label in a browser select or native menu.", z.object({ target: selector, option: z.string().min(1).max(300) }).strict(), async ({ target, option }) => {
      if (request.surface === "browser") {
        const element = await reveal(target)
        const options = element.options?.filter(value => !value.disabled && value.label === option) ?? []
        if (options.length !== 1) return issue("option_unavailable", "Choose a unique enabled option label from the current observation.")
        await act({ type: "select", ref: element.ref, values: [options[0].value] })
      }
      else { await click(target); await waitFor({ role: "menuitem", name: option }, "enabled", 3000); await click({ role: "menuitem", name: option }) }
      return { selected: option }
    }),
    key: add("Send one key/shortcut, refreshing focus before input. Native key names follow computer_discover.", z.object({ key: z.string().min(1).max(24), modifiers: z.array(z.enum(["command", "control", "shift", "option"])).max(4).default([]) }).strict(), async ({ key, modifiers }) => {
      if (request.surface === "browser" && modifiers.length) return issue("unsupported_shortcut", "Use browser semantic controls or findText for browser commands.")
      await observe(false)
      await act({ type: "key", key, ...(request.surface === "computer" ? { modifiers } : {}) })
      return { dispatched: true }
    }),
    findText: add("Find text through the native app's Find field, handling the focus transition locally. Browser programs read matching page text directly.", z.object({ text: z.string().min(1).max(1000) }).strict(), async ({ text }) => {
      if (request.surface === "browser") { const view = await observe(false); return { found: view.text.toLowerCase().includes(text.toLowerCase()) } }
      await observe(false); await act({ type: "key", key: "f", modifiers: ["command"] })
      const until = performance.now() + 3000
      do {
        const view = await observe(false)
        const candidates = view.elements.filter((element) => element.editable && !element.disabled && /find|search/i.test(element.name))
        if (candidates.length === 1) { await fill({ role: candidates[0].role, name: candidates[0].name }, text); await observe(false); await act({ type: "key", key: "enter" }); return { searched: true } }
        await pause(100)
      } while (performance.now() < until)
      return issue("find_field_unavailable", "Find opened but its text field could not be uniquely identified. Inspect the current view.", true)
    }),
    menu: add("Activate a native menu path or successive named browser controls, re-resolving after each transition.", z.object({ path: z.array(z.string().min(1).max(200)).min(1).max(6) }).strict(), async ({ path }) => { for (const name of path) { await waitFor({ name }, "enabled", 3000); await click({ name }) }; return { activated: path.at(-1) } }),
    waitFor: add("Wait locally for a control to become visible, hidden, or enabled; no fixed sleep or model turn is needed.", z.object({ target: selector, state: z.enum(["visible", "hidden", "enabled"]).default("visible"), timeoutMs: z.number().int().min(100).max(15000).default(5000) }).strict(), ({ target, state, timeoutMs }) => waitFor(target, state, timeoutMs)),
    scroll: add("Scroll the intended container by an overlapping page. Positive down/up direction is platform-independent.", z.object({ direction: z.enum(["up", "down"]).default("down"), pages: z.number().min(0.1).max(2).default(1), container: selector.optional() }).strict(), ({ direction, pages, container }) => scroll(direction, pages, container)),
    scrollUntil: add("Search and scroll locally until a target appears, content stops changing, or maxPages is reached. Virtualized lists are searched after each scroll.", z.object({ target: selector, container: selector.optional(), direction: z.enum(["up", "down"]).default("down"), maxPages: z.number().int().min(1).max(12).default(6) }).strict(), async ({ target, container, direction, maxPages }) => {
      let previous = ""
      for (let page = 0; page <= maxPages; page++) {
        const view = await observe(false, target)
        const found = select(view, target, false)
        if (found) { await reveal(target); return { found: true, target, pages: page } }
        const fingerprint = JSON.stringify([view.scroll, view.progress, view.text, view.elements.map((element) => [element.name, element.bounds])])
        if (page > 0 && fingerprint === previous) return { found: false, reason: "no_progress", pages: page }
        if (page === maxPages) return { found: false, reason: "page_limit", pages: page }
        previous = fingerprint
        await scroll(direction, 1, container); await pause(80)
      }
      return { found: false }
    }),
  } }
  try {
    const result = await Effect.runPromise(CodeMode.execute({ code: request.code, tools, bindings: { input: z.json().parse(request.input ?? null) }, readonlyBindings: true,
      limits: { timeoutMs, maxToolCalls: 80, maxOutputBytes: 32_000 },
    }), { signal })
    return { ok: result.ok, ...(result.ok ? { value: result.value } : { error: lastFailure ?? result.error }), receipts, mayHaveActed, metrics: metrics(), images }
  } catch (error) {
    return { ok: false, error: { code: signal.aborted ? "program_stopped" : error instanceof ComputerProgramError ? error.code : "program_failed", message: signal.aborted ? "The program stopped. Completed input was not replayed." : error instanceof Error ? error.message : "The program could not finish." }, receipts, mayHaveActed, metrics: metrics(), images: signal.aborted ? [] : images }
  }
}
