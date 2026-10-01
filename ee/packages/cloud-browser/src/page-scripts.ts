/**
 * Scripts evaluated inside the page, in an isolated world: they share the DOM
 * with the site but not its JavaScript globals, so a site cannot patch the
 * functions they rely on. Plain JavaScript source (not serialized TypeScript)
 * so no transpiler helper ever leaks into the page.
 *
 * Observation state lives in the page itself, never in Den: each observed
 * control carries `data-ow-ref` and `data-ow-bounds`, and the document root
 * carries the observation id. Any Den replica can therefore resolve a ref that
 * a different replica handed out. Observations never read form values.
 */

/** Argument: `{ id, image, maxElements, maxText, waitMs }`. Waits (bounded) for the document to parse. */
export const OBSERVE_SCRIPT = String.raw`async (input) => {
  if (document.readyState === 'loading') {
    await new Promise((resolve) => {
      addEventListener('DOMContentLoaded', resolve, { once: true })
      setTimeout(resolve, input.waitMs)
    })
  }
  const SENSITIVE = 'input[type="password" i], input[autocomplete~="one-time-code" i]'
  const CANDIDATES = [
    'a[href]', 'button', 'input:not([type="hidden" i])', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
    '[role="searchbox"]', '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',')
  const root = document.documentElement
  const vw = innerWidth
  const vh = innerHeight
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const roleOf = (element) => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName
    if (tag === 'A') return 'link'
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button'
    if (tag === 'SELECT') return 'combobox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'INPUT') {
      const type = element.type
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'file') return 'file'
      return type === 'search' ? 'searchbox' : 'textbox'
    }
    return element.isContentEditable ? 'textbox' : tag.toLowerCase()
  }
  const nameOf = (element) => {
    const aria = clean(element.getAttribute('aria-label'))
    if (aria) return aria
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = clean(labelledBy.split(/\s+/).map((id) => {
        const label = document.getElementById(id)
        return label ? label.innerText : ''
      }).join(' '))
      if (text) return text
    }
    if (element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type)) {
      return clean(element.value) || element.type
    }
    if (element.labels && element.labels.length) {
      const text = clean(element.labels[0].innerText)
      if (text) return text
    }
    if (!(element instanceof HTMLSelectElement)) {
      const text = clean(element.innerText)
      if (text) return text
    }
    const image = element.querySelector('img[alt]')
    if (image && clean(image.alt)) return clean(image.alt)
    return clean(element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('name'))
  }

  for (const old of document.querySelectorAll('[data-ow-ref]')) {
    old.removeAttribute('data-ow-ref')
    old.removeAttribute('data-ow-bounds')
  }

  const found = []
  let index = 0
  for (const element of document.querySelectorAll(CANDIDATES)) {
    index += 1
    if (!(element instanceof HTMLElement)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    const inView = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw
    // Visible controls first, then the ones just below, then the ones above.
    const group = inView ? 0 : rect.top >= vh ? 1 : 2
    const distance = group === 1 ? rect.top - vh : group === 2 ? -rect.bottom : 0
    found.push({ element, rect, group, distance, index })
  }
  found.sort((a, b) => a.group - b.group || a.distance - b.distance || a.index - b.index)

  const elements = []
  for (const item of found.slice(0, input.maxElements)) {
    const { element, rect } = item
    const ref = 'e' + (elements.length + 1)
    const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    element.setAttribute('data-ow-ref', ref)
    element.setAttribute('data-ow-bounds', [bounds.x, bounds.y, bounds.width, bounds.height].join(','))
    const entry = { ref, role: roleOf(element), name: nameOf(element).slice(0, 200), bounds, sensitive: element.matches(SENSITIVE) }
    if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') entry.disabled = true
    elements.push(entry)
  }

  const hasPasswordField = [...document.querySelectorAll(SENSITIVE)].some((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  root.setAttribute('data-ow-observation', input.id)
  root.setAttribute('data-ow-scroll', scrollX + ',' + scrollY)
  root.setAttribute('data-ow-image', input.image ? '1' : '0')
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    text: (document.body ? document.body.innerText : '').slice(0, input.maxText),
    elements,
    moreElements: found.length > elements.length,
    viewport: { width: vw, height: vh },
    scroll: { x: scrollX, y: scrollY },
    hasPasswordField,
  }
}`

/**
 * Argument: `{ id, action }`. Verifies the action against the observation that
 * produced its ref, consumes the observation (a lost reply must never replay
 * an action), focuses fill targets, and returns the viewport point to use.
 * Returns `{ error }` with a CloudBrowserErrorCode instead of throwing.
 */
export const PREPARE_ACTION_SCRIPT = String.raw`(input) => {
  const SENSITIVE = 'input[type="password" i], input[autocomplete~="one-time-code" i]'
  const BLOCKED = SENSITIVE + ', input[type="file" i]'
  const root = document.documentElement
  const action = input.action
  if (!root || root.getAttribute('data-ow-observation') !== input.id) return { error: 'stale_observation' }
  if (root.getAttribute('data-ow-scroll') !== scrollX + ',' + scrollY) return { error: 'stale_observation' }
  const inViewport = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
  const deepActive = () => {
    let active = document.activeElement
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement
    return active
  }
  let element = null
  let x = action.x
  let y = action.y
  if (action.ref) {
    element = document.querySelector('[data-ow-ref="' + action.ref + '"]')
    if (!element || !element.isConnected) return { error: 'stale_element' }
    if (element.matches(SENSITIVE)) return { error: 'sign_in_required' }
    if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return { error: 'element_disabled' }
    const rect = element.getBoundingClientRect()
    const bounds = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(',')
    if (bounds !== element.getAttribute('data-ow-bounds')) return { error: 'stale_observation' }
    x = rect.x + rect.width / 2
    y = rect.y + rect.height / 2
    if (!inViewport(x, y)) return { error: 'element_outside_viewport' }
    const hit = document.elementFromPoint(x, y)
    if (!hit || (hit !== element && !element.contains(hit))) return { error: 'element_obscured' }
  }
  if (action.type === 'click' && !action.ref) {
    if (root.getAttribute('data-ow-image') !== '1') return { error: 'image_required' }
    if (!inViewport(x, y)) return { error: 'outside_viewport' }
    const hit = document.elementFromPoint(x, y)
    if (hit && hit.matches(BLOCKED)) return { error: 'sign_in_required' }
  }
  if (action.type === 'fill') {
    const textInput = element instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type)
    const editable = textInput || element instanceof HTMLTextAreaElement || (element && element.isContentEditable)
    if (!editable || element.readOnly === true) return { error: 'not_editable' }
  }
  if (action.type === 'key') {
    const active = deepActive()
    if (active && active.matches && active.matches(BLOCKED)) return { error: 'sign_in_required' }
    if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) return { error: 'unverifiable_focus' }
  }
  if (action.type === 'scroll') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = innerWidth / 2
      y = innerHeight / 2
    }
    if (!inViewport(x, y)) return { error: 'outside_viewport' }
  }
  root.removeAttribute('data-ow-observation')
  if (action.type === 'fill') {
    element.focus()
    if (deepActive() !== element) return { error: 'stale_element' }
    if (element.isContentEditable) {
      const selection = getSelection()
      if (selection) selection.selectAllChildren(element)
    } else {
      element.select()
    }
  }
  return { x, y }
}`
