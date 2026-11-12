import assert from "node:assert/strict"
import { test } from "node:test"
import { CHROME_BOTTOM, CHROME_TOP, observeFloatingChrome } from "../../../packages/workbot-ui/src/floating-chrome.ts"

// The floating header and message box tell the conversation how far they reach over it; the conversation pads its
// ends by exactly that. Real layout (translucency, the arrow's place, the last message above the box) is covered by
// scroll-browser.mjs.
function fixture(t) {
  const saved = globalThis.ResizeObserver
  const observers = []
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.observed = []; this.connected = true; observers.push(this) }
    observe(node, options) { this.observed.push({ node, options }) }
    disconnect() { this.connected = false }
  }
  t.after(() => { globalThis.ResizeObserver = saved })
  const values = new Map()
  const writes = []
  const frame = { style: { getPropertyValue: name => values.get(name) ?? "", setProperty: (name, value) => { writes.push([name, value]); values.set(name, value) } } }
  const box = height => ({ height, getBoundingClientRect() { return { height: this.height } } })
  return { observers, values, writes, frame, box }
}

test("pads the conversation by the floating header's and message box's measured heights", t => {
  const { observers, values, frame, box } = fixture(t)
  const header = box(84)
  const dock = box(77.4)
  const owner = observeFloatingChrome(frame, header, dock)
  assert.equal(values.get(CHROME_TOP), "84px")
  assert.equal(values.get(CHROME_BOTTOM), "78px", "rounded up so the last line never sits under the box")
  assert.deepEqual(observers[0].observed.map(entry => entry.options), [{ box: "border-box" }, { box: "border-box" }])
  // The message box grows with a second line, a context chip or the keyboard dropping the safe area.
  dock.height = 121
  observers[0].callback()
  assert.equal(values.get(CHROME_BOTTOM), "121px")
  owner.dispose()
  assert.equal(observers[0].connected, false)
})

test("a part that is not floating reaches over nothing, and unchanged sizes cost no restyle", t => {
  const { observers, values, writes, frame, box } = fixture(t)
  observeFloatingChrome(frame, null, null)
  assert.equal(values.get(CHROME_TOP), "0px")
  assert.equal(values.get(CHROME_BOTTOM), "0px")
  assert.equal(observers.length, 0, "nothing to observe")
  const dock = box(60)
  const owner = observeFloatingChrome(frame, null, dock)
  const count = writes.length
  owner.measure()
  owner.measure()
  assert.equal(writes.length, count, "identical heights are not written again")
})
