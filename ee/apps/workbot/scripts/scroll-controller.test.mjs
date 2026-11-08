import assert from "node:assert/strict"
import { test } from "node:test"
import { createConversationScrollState, observeConversationScroll } from "../../../packages/workbot-ui/src/conversation-scroll.ts"

// DOM doubles make the browser's ordering deterministic: scroll can arrive before ResizeObserver.
// Real layout, image decode, tap and screenshots are covered by scroll-browser.mjs.
function fixture(t, height = 1000, viewport = 300) {
  const saved = { window: globalThis.window, ResizeObserver: globalThis.ResizeObserver }
  const callbacks = []
  globalThis.ResizeObserver = class {
    constructor(callback) { callbacks.push(callback) }
    observe() {}
    disconnect() {}
  }
  globalThis.window = { matchMedia: () => ({ matches: false }) }
  t.after(() => { globalThis.window = saved.window; globalThis.ResizeObserver = saved.ResizeObserver })
  let top = 0
  const node = Object.assign(new EventTarget(), {
    scrollHeight: height, clientHeight: viewport, clientWidth: 390,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0 }),
    scrollTo({ top: value, behavior }) { if (behavior !== "smooth") this.scrollTop = value },
  })
  Object.defineProperty(node, "scrollTop", { get: () => top, set: value => { top = Math.max(0, Math.min(value, node.scrollHeight - node.clientHeight)) } })
  const content = { querySelectorAll: () => [] }
  const state = createConversationScrollState(8)
  const controller = observeConversationScroll(node, content, state, () => {})
  t.after(() => controller.dispose())
  const event = (type, properties = {}) => node.dispatchEvent(Object.assign(new Event(type), properties))
  return { node, state, controller, event, resize: () => callbacks.forEach(callback => callback()) }
}

test("a layout-generated scroll before ResizeObserver never unpins the newest message", t => {
  const { node, state, event, resize } = fixture(t)
  assert.equal(node.scrollTop, 700)
  node.scrollHeight = 2400
  event("scroll")
  assert.equal(state.following, true)
  assert.equal(node.scrollTop, 2100)
  resize()
  assert.equal(node.scrollTop, 2100)
  node.clientHeight = 150
  resize()
  assert.equal(node.scrollTop, 2250)
})

test("an upward gesture that cannot move a short conversation does not disable following", t => {
  const { node, state, event, resize } = fixture(t, 100)
  event("wheel", { deltaY: -100 })
  event("keydown", { key: "PageUp" })
  event("touchstart", { touches: [{ clientY: 100 }] })
  event("touchmove", { touches: [{ clientY: 180 }] })
  assert.equal(state.following, true)
  node.scrollHeight = 1300
  resize()
  assert.equal(node.scrollTop, 1000)
})

test("every scroll-navigation key and pointer takeover interrupts a smooth latest jump", t => {
  const { node, state, controller, event, resize } = fixture(t, 4000)
  for (const key of ["PageDown", "ArrowDown", " ", "End", "PageUp", "Home"]) {
    node.scrollTop = 1500
    event("scroll")
    controller.latest(true)
    event("keydown", { key })
    assert.equal(state.following, false, key)
    node.scrollHeight += 400
    resize()
    assert.equal(node.scrollTop, 1500, key)
  }
  controller.latest(true)
  event("pointerdown")
  assert.equal(state.following, false)
})

test("an interrupted animation settles even when a browser does not send scrollend", async t => {
  const { node, state, controller, event } = fixture(t, 4000)
  node.scrollTop = 1500
  event("scroll")
  controller.latest(true)
  node.scrollTop = 1700
  event("scroll")
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(state.following, false)
  node.scrollTop = 1800
  event("scroll")
  assert.equal(state.top, 1800)
})
