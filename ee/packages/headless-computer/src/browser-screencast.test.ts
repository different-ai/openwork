import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { WebSocketServer } from "ws"
import { streamBrowser } from "./browser-screencast.mjs"

/** A stand-in for Chromium's debugging endpoint: a tab list, and per-tab sockets that record commands. */
async function fakeChromium({ listDelayMs = 10 } = {}) {
  const commands: { tab: string; method: string; params: Record<string, unknown> }[] = []
  const requests: string[] = []
  const answers = new Map<string, unknown>()
  const tabs = new Map<string, import("ws").WebSocket>()
  let list: { id: string; url: string; title: string }[] = []
  const server = createServer(async (request, response) => {
    const { port } = server.address() as AddressInfo
    // Like Chromium, listing tabs takes a moment, so polls overlap with whatever else happens.
    if (request.url === "/json/list") await new Promise(resolve => setTimeout(resolve, listDelayMs))
    requests.push(request.method === "GET" ? request.url! : `${request.method} ${request.url}`)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(list.map(tab => ({ ...tab, type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${tab.id}` }))))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on("connection", (socket, request) => {
    const tab = request.url!.split("/").pop()!
    tabs.set(tab, socket)
    socket.on("message", data => {
      const { id, method, params } = JSON.parse(String(data))
      commands.push({ tab, method, params })
      socket.send(JSON.stringify({ id, result: answers.get(method) ?? {} }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    commands,
    requests,
    show(next: typeof list) { list = next },
    answer(method: string, result: unknown) { answers.set(method, result) },
    event(tab: string, method: string, params: unknown) { tabs.get(tab)!.send(JSON.stringify({ method, params })) },
    frame(tab: string, sessionId: number, metadata = {}) {
      tabs.get(tab)!.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: Buffer.from(`jpeg-${sessionId}`).toString("base64"), sessionId, metadata } }))
    },
    close() { sockets.close(); server.close() },
  }
}

function fakeViewer() {
  const sent: (string | Buffer)[] = []
  return Object.assign(new EventEmitter(), { readyState: 1, sent, send(message: string | Buffer) { sent.push(message) } })
}

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check())
}

test("streams the front tab's frames and pages, acknowledging only frames the viewer drew", async () => {
  const chromium = await fakeChromium()
  const viewer = fakeViewer()
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }, { id: "b", url: "https://example.org/", title: "Other" }])
  const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 20 })
  try {
    await until(() => chromium.commands.some(command => command.tab === "a" && command.method === "Page.startScreencast"))
    assert.deepEqual(JSON.parse(String(viewer.sent[0])), { type: "page", id: "a", url: "https://example.com/", title: "Example", loading: false, back: false, forward: false, tabs: [{ id: "b", url: "https://example.org/", title: "Other" }, { id: "a", url: "https://example.com/", title: "Example" }] })

    chromium.frame("a", 7)
    chromium.frame("a", 8)
    await until(() => viewer.sent.filter(Buffer.isBuffer).length === 2)
    assert.equal(String(viewer.sent.find(Buffer.isBuffer)), "jpeg-7")
    assert.equal(chromium.commands.filter(command => command.method === "Page.screencastFrameAck").length, 0)

    viewer.emit("message", Buffer.from("ack"), false)
    await until(() => chromium.commands.some(command => command.method === "Page.screencastFrameAck"))
    assert.deepEqual(chromium.commands.filter(command => command.method === "Page.screencastFrameAck").map(command => command.params.sessionId), [7])

    // Bringing another tab to the front moves the stream to it.
    chromium.show([{ id: "b", url: "https://example.org/", title: "Other" }, { id: "a", url: "https://example.com/", title: "Example" }])
    await until(() => chromium.commands.some(command => command.tab === "b" && command.method === "Page.startScreencast"))
    await until(() => viewer.sent.some(message => typeof message === "string" && JSON.parse(message).url === "https://example.org/"))
    // Chromium lists the front tab first, so the tabs start least recently used first, the order they likely opened in,
    // and keep it whichever comes to the front.
    const switched = JSON.parse(String(viewer.sent.findLast(message => typeof message === "string")))
    assert.deepEqual(switched.tabs.map((tab: { id: string }) => tab.id), ["b", "a"])

    // A closed tab leaves the strip; a new one joins at the end.
    chromium.show([{ id: "c", url: "https://example.net/", title: "New" }, { id: "b", url: "https://example.org/", title: "Other" }])
    await until(() => viewer.sent.some(message => typeof message === "string" && JSON.parse(message).url === "https://example.net/"))
    assert.deepEqual(JSON.parse(String(viewer.sent.findLast(message => typeof message === "string"))).tabs.map((tab: { id: string }) => tab.id), ["b", "c"])
  } finally { stop(); chromium.close() }
})

test("the next connection keeps the tabs where they were", async () => {
  const chromium = await fakeChromium()
  chromium.show([{ id: "b", url: "https://example.org/", title: "Second" }, { id: "a", url: "https://example.com/", title: "First" }])
  const order = async () => {
    const viewer = fakeViewer()
    const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 20 })
    try {
      await until(() => viewer.sent.some(message => typeof message === "string"))
      return JSON.parse(String(viewer.sent.find(message => typeof message === "string"))).tabs.map((tab: { id: string }) => tab.id)
    } finally { stop() }
  }
  try {
    assert.deepEqual(await order(), ["a", "b"])
    // The person brings the first tab to the front, and the viewer renews its connection.
    chromium.show([{ id: "a", url: "https://example.com/", title: "First" }, { id: "b", url: "https://example.org/", title: "Second" }])
    assert.deepEqual(await order(), ["a", "b"])
  } finally { chromium.close() }
})

test("anything but an acknowledgement ends the stream, so a viewer cannot send input", async () => {
  const chromium = await fakeChromium()
  const viewer = fakeViewer()
  let closed = false
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }])
  streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 20, onClose: () => { closed = true } })
  try {
    await until(() => chromium.commands.some(command => command.method === "Page.startScreencast"))
    viewer.emit("message", Buffer.from('{"method":"Input.dispatchMouseEvent"}'), true)
    assert.equal(closed, true)
    const sent = chromium.commands.length
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(chromium.commands.length, sent)
  } finally { chromium.close() }
})

test("switches and closes the viewer's tabs, but only tabs the browser has open and never the last one", async () => {
  const chromium = await fakeChromium()
  const viewer = fakeViewer()
  let closed = false
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }, { id: "b", url: "https://example.org/", title: "Other" }])
  const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 1000, onClose: () => { closed = true } })
  try {
    await until(() => viewer.sent.length > 0)
    viewer.emit("message", Buffer.from(JSON.stringify({ type: "tab", action: "activate", id: "b" })), false)
    viewer.emit("message", Buffer.from(JSON.stringify({ type: "tab", action: "close", id: "a" })), false)
    await until(() => chromium.requests.includes("/json/activate/b") && chromium.requests.includes("/json/close/a"))

    chromium.show([{ id: "b", url: "https://example.org/", title: "Other" }])
    await until(() => JSON.parse(String(viewer.sent.findLast(message => typeof message === "string"))).tabs.length === 1)
    viewer.emit("message", Buffer.from(JSON.stringify({ type: "tab", action: "close", id: "b" })), false)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(!chromium.requests.includes("/json/close/b"))
    assert.equal(closed, false)

    // A tab the browser doesn't have, such as a path, ends the stream.
    viewer.emit("message", Buffer.from(JSON.stringify({ type: "tab", action: "close", id: "../version" })), false)
    assert.equal(closed, true)
  } finally { stop(); chromium.close() }
})

test("takes the person's input only with control, placed in the page's own pixels", async () => {
  const click = { type: "mouse", event: "down", x: 0.5, y: 0.25, button: "left", buttons: 1, clickCount: 1, modifiers: 0 }
  for (const control of [false, true]) {
    const chromium = await fakeChromium()
    const viewer = fakeViewer()
    let closed = false
    chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }])
    const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 20, control, onClose: () => { closed = true } })
    try {
      await until(() => chromium.commands.some(command => command.method === "Page.startScreencast"))
      chromium.frame("a", 1, { deviceWidth: 1200, deviceHeight: 800 })
      await until(() => viewer.sent.some(Buffer.isBuffer))
      viewer.emit("message", Buffer.from(JSON.stringify(click)), false)
      if (!control) { assert.equal(closed, true); continue }
      viewer.emit("message", Buffer.from(JSON.stringify({ type: "key", event: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 0, text: "a" })), false)
      viewer.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "pasted" })), false)
      await until(() => chromium.commands.some(command => command.method === "Input.insertText"))
      assert.deepEqual(chromium.commands.find(command => command.method === "Input.dispatchMouseEvent")?.params, { type: "mousePressed", x: 600, y: 200, button: "left", buttons: 1, clickCount: 1, modifiers: 0 })
      assert.equal(chromium.commands.find(command => command.method === "Input.dispatchKeyEvent")?.params.text, "a")
      // Anything but the known input shapes still ends the stream.
      viewer.emit("message", Buffer.from(JSON.stringify({ method: "Runtime.evaluate", params: { expression: "1" } })), false)
      assert.equal(closed, true)
    } finally { stop(); chromium.close() }
  }
})

test("with control, goes to web addresses only, moves through history, opens tabs and copies the selection", async () => {
  const chromium = await fakeChromium()
  const viewer = fakeViewer()
  let closed = false
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }])
  chromium.answer("Page.getNavigationHistory", { currentIndex: 1, entries: [{ id: 10, url: "https://example.org/" }, { id: 11, url: "https://example.com/" }] })
  chromium.answer("Runtime.evaluate", { result: { type: "string", value: "selected words" } })
  const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 1000, control: true, onClose: () => { closed = true } })
  const send = (message: unknown) => viewer.emit("message", Buffer.from(JSON.stringify(message)), false)
  const pages = () => viewer.sent.filter((message): message is string => typeof message === "string").map(message => JSON.parse(message))
  try {
    // The tab's history says it can go back but not forward.
    await until(() => pages().some(page => page.back === true && page.forward === false))

    send({ type: "navigate", url: "https://example.net/path" })
    send({ type: "history", action: "back" })
    send({ type: "history", action: "reload" })
    send({ type: "tab", action: "new" })
    send({ type: "copy" })
    await until(() => chromium.commands.some(command => command.method === "Page.navigateToHistoryEntry") && chromium.requests.includes("PUT /json/new?about:blank"))
    assert.deepEqual(chromium.commands.find(command => command.method === "Page.navigate")?.params, { url: "https://example.net/path" })
    assert.deepEqual(chromium.commands.find(command => command.method === "Page.navigateToHistoryEntry")?.params, { entryId: 10 })
    assert.ok(chromium.commands.some(command => command.method === "Page.reload"))
    await until(() => pages().length > 0 && viewer.sent.some(message => typeof message === "string" && JSON.parse(message).type === "clipboard"))
    assert.deepEqual(JSON.parse(String(viewer.sent.find(message => typeof message === "string" && JSON.parse(message).type === "clipboard"))), { type: "clipboard", text: "selected words" })

    // The page's own loading shows on its tab.
    chromium.event("a", "Page.frameStartedLoading", { frameId: "a" })
    await until(() => pages().at(-1)?.loading === true)
    chromium.event("a", "Page.frameStoppedLoading", { frameId: "a" })
    await until(() => pages().at(-1)?.loading === false)
    assert.equal(closed, false)

    // The browser's own pages and other schemes are never opened.
    send({ type: "navigate", url: "chrome://settings" })
    assert.equal(closed, true)
  } finally { stop(); chromium.close() }

  for (const unsafe of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
    const other = await fakeChromium()
    const watcher = fakeViewer()
    let ended = false
    other.show([{ id: "a", url: "https://example.com/", title: "Example" }])
    const end = streamBrowser(watcher, { endpoint: other.endpoint, control: true, onClose: () => { ended = true } })
    try {
      await until(() => watcher.sent.length > 0)
      watcher.emit("message", Buffer.from(JSON.stringify({ type: "navigate", url: unsafe })), false)
      assert.equal(ended, true, unsafe)
      assert.ok(!other.commands.some(command => command.method === "Page.navigate"))
    } finally { end(); other.close() }
  }
})

test("without control, browsing, new tabs and copying end the stream", async () => {
  for (const message of [{ type: "navigate", url: "https://example.net/" }, { type: "history", action: "back" }, { type: "tab", action: "new" }, { type: "copy" }]) {
    const chromium = await fakeChromium()
    const viewer = fakeViewer()
    let closed = false
    chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }])
    const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, onClose: () => { closed = true } })
    try {
      await until(() => viewer.sent.length > 0)
      viewer.emit("message", Buffer.from(JSON.stringify(message)), false)
      assert.equal(closed, true, message.type)
      assert.ok(!chromium.requests.some(request => request.startsWith("PUT")))
    } finally { stop(); chromium.close() }
  }
})

test("tab commands while the tab list is loading never start a second poll loop", async () => {
  const chromium = await fakeChromium({ listDelayMs: 100 })
  const viewer = fakeViewer()
  chromium.show([{ id: "a", url: "https://example.com/", title: "Example" }, { id: "b", url: "https://example.org/", title: "Other" }])
  const stop = streamBrowser(viewer, { endpoint: chromium.endpoint, pollMs: 300 })
  const polls = () => chromium.requests.filter(request => request === "/json/list").length
  try {
    await until(() => viewer.sent.length > 0)
    // 80 ms apart: each command's follow-up poll is still loading when the next command arrives.
    for (let index = 0; index < 15; index++) {
      viewer.emit("message", Buffer.from(JSON.stringify({ type: "tab", action: "activate", id: index % 2 ? "a" : "b" })), false)
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    const before = polls()
    await new Promise(resolve => setTimeout(resolve, 1200))
    // One loop lists tabs about every 400 ms (300 ms apart, 100 ms to answer); extra loops would list far more often.
    assert.ok(polls() - before <= 4, `${polls() - before} polls in 1.2 s`)
  } finally { stop(); chromium.close() }
})

test("refuses a debugging address that isn't Chromium's own loopback endpoint", async () => {
  const viewer = fakeViewer()
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify([{ id: "a", type: "page", url: "https://example.com/", title: "Example", webSocketDebuggerUrl: "ws://attacker.example:9222/devtools/page/a" }]))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const stop = streamBrowser(viewer, { endpoint: `http://127.0.0.1:${port}`, pollMs: 20 })
  try {
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(viewer.sent.length, 0)
  } finally { stop(); server.close() }
})
