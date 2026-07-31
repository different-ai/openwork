import assert from "node:assert/strict"
import test from "node:test"

import { isFullyVisible, resolveSurfaceBounds, surfaceWindowOptions } from "./geometry.mjs"
import {
  buildContentSecurityPolicy,
  isPermittedNavigation,
  isPermittedRequest,
  resolveAppUrl,
} from "./protocol.mjs"
import { AppRuntimeSupervisor } from "./supervisor.mjs"

const APP = "com.openworklabs.station"
const ROOT = "/data/apps/com.openworklabs.station/1.0.0"
const installed = new Map([[APP, ROOT]])

// ---------------------------------------------------------------------------
// Protocol resolution
// ---------------------------------------------------------------------------

test("a surface entrypoint resolves inside the app's own directory", () => {
  const result = resolveAppUrl(`openwork-app://${APP}/dist/station/index.html`, installed)
  assert.equal(result.ok, true)
  assert.equal(result.path, `${ROOT}/dist/station/index.html`)
  assert.equal(result.mimeType, "text/html; charset=utf-8")
})

test("a bare app URL resolves to index.html", () => {
  const result = resolveAppUrl(`openwork-app://${APP}/`, installed)
  assert.equal(result.ok, true)
  assert.equal(result.path, `${ROOT}/index.html`)
})

test("no input resolves outside the app's own directory", () => {
  // The property that matters is containment, not which specific rule caught it.
  // The URL parser already collapses literal `..` segments for this scheme, so a
  // path like `/dist/../../secrets.json` becomes `/secrets.json` and stays
  // inside the root; percent-encoded traversal survives parsing and is caught by
  // the explicit segment check. Both outcomes are safe, and this asserts that
  // directly rather than asserting a reason string that depends on which layer
  // happened to fire.
  for (const path of [
    "/../../../etc/passwd",
    "/dist/../../secrets.json",
    "/./../other-app/index.html",
    "/%2e%2e%2f%2e%2e%2fsecrets.json",
    "/%2e%2e/%2e%2e/etc/hosts.json",
    "/dist/%2e%2e%2f%2e%2e%2fprivate.json",
  ]) {
    const result = resolveAppUrl(`openwork-app://${APP}${path}`, installed)
    if (result.ok) {
      assert.ok(
        result.path.startsWith(`${ROOT}/`),
        `${path} resolved outside the app root: ${result.path}`,
      )
    }
  }
})

test("percent-encoded traversal is caught explicitly, because the parser does not decode it", () => {
  const result = resolveAppUrl(`openwork-app://${APP}/%2e%2e%2f%2e%2e%2fsecrets.json`, installed)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "path_traversal")
})

test("a backslash path is refused", () => {
  const result = resolveAppUrl(`openwork-app://${APP}/..%5C..%5Cwindows`, installed)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "invalid_path")
})

test("one app cannot address another app's files", () => {
  const result = resolveAppUrl("openwork-app://com.someone.else/index.html", installed)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "app_not_running")
})

test("a stopped app serves nothing", () => {
  const result = resolveAppUrl(`openwork-app://${APP}/index.html`, new Map())
  assert.equal(result.ok, false)
  assert.equal(result.reason, "app_not_running")
})

test("an executable or unknown file type is not servable", () => {
  for (const path of ["/native.node", "/run.sh", "/lib.dylib", "/data.sqlite", "/noextension"]) {
    const result = resolveAppUrl(`openwork-app://${APP}${path}`, installed)
    assert.equal(result.ok, false, `expected refusal for ${path}`)
    assert.equal(result.reason, "unsupported_type")
  }
})

test("a non-app protocol is refused", () => {
  assert.equal(resolveAppUrl("file:///etc/passwd", installed).reason, "wrong_protocol")
  assert.equal(resolveAppUrl("https://evil.example.com/", installed).reason, "wrong_protocol")
})

test("an app id that is not reverse-DNS is refused", () => {
  assert.equal(resolveAppUrl("openwork-app://openwork-voice/index.html", installed).reason, "invalid_app_id")
})

// ---------------------------------------------------------------------------
// Content policy and network
// ---------------------------------------------------------------------------

test("the CSP denies everything by default and allows only the app's own origin", () => {
  const csp = buildContentSecurityPolicy(APP, ["api.openai.com"])
  assert.match(csp, /^default-src 'none'/)
  assert.match(csp, new RegExp(`script-src openwork-app://${APP.replace(/\./g, "\\.")}`))
  assert.match(csp, /connect-src https:\/\/api\.openai\.com wss:\/\/api\.openai\.com/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.ok(!csp.includes("unsafe-eval"))
  assert.ok(!csp.includes("*"))
})

test("an app with no network permission gets no connect-src", () => {
  assert.match(buildContentSecurityPolicy(APP, []), /connect-src 'none'/)
})

test("network requests are allowed only to exactly the granted hosts", () => {
  const hosts = ["api.openai.com"]
  assert.equal(isPermittedRequest("https://api.openai.com/v1/realtime", APP, hosts), true)
  assert.equal(isPermittedRequest("wss://api.openai.com/v1/realtime", APP, hosts), true)
  // A suffix or lookalike host must not satisfy the permission.
  assert.equal(isPermittedRequest("https://evil-api.openai.com.attacker.net/", APP, hosts), false)
  assert.equal(isPermittedRequest("https://openai.com/", APP, hosts), false)
  assert.equal(isPermittedRequest("https://sub.api.openai.com/", APP, hosts), false)
  assert.equal(isPermittedRequest("http://api.openai.com/", APP, hosts), false)
  assert.equal(isPermittedRequest("file:///etc/passwd", APP, hosts), false)
})

test("an app can load its own protocol content and nothing else's", () => {
  assert.equal(isPermittedRequest(`openwork-app://${APP}/index.html`, APP, []), true)
  assert.equal(isPermittedRequest("openwork-app://com.other.app/index.html", APP, []), false)
})

test("navigation is confined to the app's own origin", () => {
  assert.equal(isPermittedNavigation(`openwork-app://${APP}/other.html`, APP), true)
  assert.equal(isPermittedNavigation("https://example.com", APP), false)
  assert.equal(isPermittedNavigation("openwork-app://com.other.app/x.html", APP), false)
  assert.equal(isPermittedNavigation("javascript:alert(1)", APP), false)
})

// ---------------------------------------------------------------------------
// Window options
// ---------------------------------------------------------------------------

test("surface windows are sandboxed, isolated, and node-free", () => {
  const options = surfaceWindowOptions({
    appId: APP,
    bounds: { x: 0, y: 0, width: 360, height: 220 },
    alwaysOnTop: true,
    preloadPath: "/preload.mjs",
    partition: "persist:openwork-app-station",
  })
  assert.equal(options.webPreferences.sandbox, true)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.nodeIntegrationInWorker, false)
  assert.equal(options.webPreferences.nodeIntegrationInSubFrames, false)
  assert.equal(options.webPreferences.webviewTag, false)
  assert.equal(options.webPreferences.webSecurity, true)
  assert.equal(options.webPreferences.allowRunningInsecureContent, false)
  assert.equal(options.webPreferences.partition, "persist:openwork-app-station")
  assert.equal(options.alwaysOnTop, true)
})

test("two apps never share a session partition", () => {
  const a = surfaceWindowOptions({
    appId: "com.a.app",
    bounds: { x: 0, y: 0, width: 200, height: 200 },
    alwaysOnTop: false,
    preloadPath: "/p",
    partition: "persist:openwork-app-com.a.app",
  })
  const b = surfaceWindowOptions({
    appId: "com.b.app",
    bounds: { x: 0, y: 0, width: 200, height: 200 },
    alwaysOnTop: false,
    preloadPath: "/p",
    partition: "persist:openwork-app-com.b.app",
  })
  assert.notEqual(a.webPreferences.partition, b.webPreferences.partition)
})

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const LAPTOP = { x: 0, y: 25, width: 1440, height: 875 }

test("a right-anchored surface sits inside the work area", () => {
  const bounds = resolveSurfaceBounds({ width: 380, height: 240 }, LAPTOP, "right-center")
  assert.equal(isFullyVisible(bounds, LAPTOP), true)
  assert.equal(bounds.x + bounds.width, LAPTOP.x + LAPTOP.width - 16)
})

test("every anchor keeps the surface fully on screen", () => {
  for (const anchor of [
    "right-center",
    "right-top",
    "right-bottom",
    "left-center",
    "top-center",
    "bottom-center",
  ]) {
    const bounds = resolveSurfaceBounds({ width: 380, height: 240 }, LAPTOP, anchor)
    assert.equal(isFullyVisible(bounds, LAPTOP), true, `${anchor} escaped the work area`)
  }
})

test("a surface larger than the display is clamped rather than clipped", () => {
  const bounds = resolveSurfaceBounds({ width: 4000, height: 4000 }, LAPTOP, "right-center")
  assert.ok(bounds.width <= LAPTOP.width)
  assert.ok(bounds.height <= LAPTOP.height)
  assert.equal(isFullyVisible(bounds, LAPTOP), true)
})

test("a display left of the primary one, with negative origin, is handled", () => {
  const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
  const bounds = resolveSurfaceBounds({ width: 380, height: 240 }, secondary, "right-center")
  assert.equal(isFullyVisible(bounds, secondary), true)
  assert.ok(bounds.x < 0)
})

test("a tiny work area still produces visible bounds", () => {
  const tiny = { x: 0, y: 0, width: 200, height: 150 }
  const bounds = resolveSurfaceBounds({ width: 380, height: 240 }, tiny, "right-center")
  assert.equal(isFullyVisible(bounds, tiny), true)
})

// ---------------------------------------------------------------------------
// Supervisor lifecycle
// ---------------------------------------------------------------------------

function fakeElectron() {
  const events = []
  const windows = []
  const registered = new Set()
  const sessions = new Map()
  /** Registered accelerator -> its callback, so tests can fire a real press. */
  const handlers = new Map()
  /** Mutable knobs a test can set before driving the supervisor. */
  const control = { nextLoadError: null }

  const electron = {
    session: {
      fromPartition(partition) {
        if (!sessions.has(partition)) {
          sessions.set(partition, {
            partition,
            handlers: {},
            cleared: false,
            webRequest: {
              onBeforeRequest(_filter, handler) {
                this.beforeRequest = handler
              },
              onHeadersReceived(handler) {
                this.headersReceived = handler
              },
            },
            setPermissionRequestHandler(handler) {
              this.handlers.request = handler
            },
            setPermissionCheckHandler(handler) {
              this.handlers.check = handler
            },
            setDevicePermissionHandler(handler) {
              this.handlers.device = handler
            },
            clearStorageData() {
              this.cleared = true
            },
          })
        }
        return sessions.get(partition)
      },
    },
    globalShortcut: {
      register(accelerator, handler) {
        if (registered.has(accelerator)) return false
        registered.add(accelerator)
        events.push(`register:${accelerator}`)
        // Keep the callback so a test can fire the accelerator the way Electron
        // would. Discarding it made every assertion about gesture minting vacuous.
        handlers.set(accelerator, handler)
        return true
      },
      unregister(accelerator) {
        registered.delete(accelerator)
        handlers.delete(accelerator)
        events.push(`unregister:${accelerator}`)
      },
    },
    createWindow(options) {
      const window = {
        options,
        destroyed: false,
        loaded: null,
        listeners: {},
        webContents: {
          on(name, handler) {
            window.listeners[name] = handler
          },
          setWindowOpenHandler(handler) {
            window.openHandler = handler
          },
        },
        setAlwaysOnTop() {},
        setVisibleOnAllWorkspaces() {},
        show() {},
        isDestroyed: () => window.destroyed,
        destroy() {
          window.destroyed = true
          events.push("destroy")
        },
        async loadURL(url) {
          if (control.nextLoadError) {
            const error = control.nextLoadError
            control.nextLoadError = null
            throw error
          }
          window.loaded = url
        },
      }
      windows.push(window)
      return window
    },
    openExternal(url) {
      events.push(`external:${url}`)
    },
    stopCapture(appId) {
      events.push(`stopCapture:${appId}`)
    },
  }
  return { electron, events, windows, registered, sessions, control, handlers }
}

const PLAN = {
  allowedHosts: ["api.openai.com"],
  allowMicrophone: true,
  shortcuts: [{ id: "toggle", accelerator: "CommandOrControl+Shift+Space" }],
}

const SURFACE = {
  id: "station",
  entrypoint: "dist/station/index.html",
  defaultSize: { width: 380, height: 240 },
  anchor: "right-center",
  alwaysOnTop: true,
}

const DISPLAY = { workArea: LAPTOP }

function supervisor(fake, hooks = {}) {
  return new AppRuntimeSupervisor({
    electron: fake.electron,
    installedRoots: installed,
    preloadPath: "/preload.mjs",
    // Defaults so the shape is complete before `hooks` overrides any of it.
    onCrash: () => {},
    onGesture: () => {},
    ...hooks,
  })
}

test("starting an app registers its shortcuts and opens its surface", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)

  assert.equal(runtime.isRunning(APP), true)
  assert.ok(fake.events.includes("register:CommandOrControl+Shift+Space"))
  assert.equal(fake.windows.length, 1)
  assert.equal(fake.windows[0].loaded, `openwork-app://${APP}/dist/station/index.html`)
})

test("starting twice does not double-register anything", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.start(APP, PLAN)
  assert.equal(fake.events.filter((entry) => entry.startsWith("register:")).length, 1)
})

test("stopping tears down shortcuts, windows, and capture together", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  runtime.markCapturing(APP, true)

  await runtime.stop(APP)

  assert.equal(runtime.isRunning(APP), false)
  assert.equal(runtime.isCapturing(APP), false)
  assert.ok(fake.events.includes(`stopCapture:${APP}`))
  assert.ok(fake.events.includes("unregister:CommandOrControl+Shift+Space"))
  assert.equal(fake.registered.size, 0)
  assert.equal(fake.windows[0].destroyed, true)
})

test("a window that throws on destroy does not abandon the rest of the teardown", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  fake.windows[0].destroy = () => {
    throw new Error("window is wedged")
  }

  await runtime.stop(APP)
  // The shortcut still came back, which is the point: a stuck window must not
  // leave a global accelerator bound to a dead app.
  assert.equal(fake.registered.size, 0)
  assert.equal(runtime.isRunning(APP), false)
})

test("uninstall purges the app's partitioned storage", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.stop(APP, { purgeStorage: true })
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)
  assert.equal(session.cleared, true)
})

test("stopping without purging leaves storage intact", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.stop(APP)
  assert.equal(fake.sessions.get(`persist:openwork-app-${APP}`).cleared, false)
})

test("the session denies every permission except a granted microphone", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)

  const answers = []
  const ask = (permission, details) =>
    session.handlers.request({}, permission, (allowed) => answers.push([permission, allowed]), details)

  ask("media", { mediaTypes: ["audio"] })
  ask("geolocation")
  ask("notifications")
  ask("display-capture")
  ask("clipboard-read")

  assert.deepEqual(answers, [
    ["media", true],
    ["geolocation", false],
    ["notifications", false],
    ["display-capture", false],
    ["clipboard-read", false],
  ])
  assert.equal(session.handlers.device(), false)
})

// Electron folds the microphone and the camera into one `media` permission, and
// the vocabulary has no camera permission at all — so the microphone grant must
// not carry video with it.
test("a granted microphone does not also grant the camera", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)

  const decide = (details) => {
    let allowed = null
    session.handlers.request({}, "media", (value) => {
      allowed = value
    }, details)
    return allowed
  }

  assert.equal(decide({ mediaTypes: ["audio"] }), true)
  assert.equal(decide({ mediaTypes: ["video"] }), false)
  assert.equal(decide({ mediaTypes: ["audio", "video"] }), false)
  // A request Electron cannot describe may include video, so it is refused.
  assert.equal(decide(undefined), false)
  assert.equal(decide({ mediaType: "unknown" }), false)
  // The check handler reports a single `mediaType` rather than an array.
  assert.equal(session.handlers.check({}, "media", "openwork-app://x", { mediaType: "video" }), false)
  assert.equal(session.handlers.check({}, "media", "openwork-app://x", { mediaType: "audio" }), true)
})

test("an app without the microphone permission is denied media", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, { ...PLAN, allowMicrophone: false })
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)
  let allowed = null
  session.handlers.request({}, "media", (value) => {
    allowed = value
  }, { mediaTypes: ["audio"] })
  assert.equal(allowed, false)
})

test("the session cancels requests to hosts the app was not granted", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)

  const decide = (url) => {
    let result = null
    session.webRequest.beforeRequest({ url }, (value) => {
      result = value
    })
    return result
  }
  assert.deepEqual(decide("https://api.openai.com/v1/realtime"), { cancel: false })
  assert.deepEqual(decide("https://telemetry.example.com/collect"), { cancel: true })
})

test("the session stamps a CSP on every response", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)
  let headers = null
  session.webRequest.headersReceived({ responseHeaders: {} }, (value) => {
    headers = value.responseHeaders
  })
  assert.ok(headers, "the session must supply response headers")
  assert.match(headers["Content-Security-Policy"][0], /default-src 'none'/)
  assert.deepEqual(headers["X-Content-Type-Options"], ["nosniff"])
})

test("a renderer crash is reported to the host", async () => {
  const fake = fakeElectron()
  const crashes = []
  const runtime = supervisor(fake, { onCrash: (appId, reason) => crashes.push([appId, reason]) })
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  fake.windows[0].listeners["render-process-gone"]({}, { reason: "crashed" })
  assert.deepEqual(crashes, [[APP, "crashed"]])
})

test("a global shortcut is the only thing that mints a gesture", async () => {
  const fake = fakeElectron()
  const gestures = []
  const runtime = supervisor(fake, { onGesture: (appId, id) => gestures.push([appId, id]) })
  await runtime.start(APP, PLAN)

  // Nothing has been pressed yet.
  assert.equal(gestures.length, 0)

  // Fire the registered accelerator the way Electron would.
  fake.handlers.get("CommandOrControl+Shift+Space")()
  assert.deepEqual(gestures, [[APP, "toggle"]])

  // Opening a surface is not a user gesture, so it must not mint one.
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  assert.equal(gestures.length, 1)
})

test("an unregistered shortcut cannot mint a gesture after teardown", async () => {
  const fake = fakeElectron()
  const gestures = []
  const runtime = supervisor(fake, { onGesture: (appId, id) => gestures.push([appId, id]) })
  await runtime.start(APP, PLAN)
  await runtime.stop(APP)

  // Teardown unregisters the accelerator, so Electron would never call back.
  assert.equal(fake.handlers.has("CommandOrControl+Shift+Space"), false)
  assert.equal(gestures.length, 0)
})

test("an external link to a granted host opens in the browser, not the sandbox", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  const decision = fake.windows[0].openHandler({ url: "https://api.openai.com/docs" })
  assert.deepEqual(decision, { action: "deny" })
  assert.ok(fake.events.includes("external:https://api.openai.com/docs"))
})

// Handing a URL to the user's browser is still egress on the app's behalf, so
// `window.open` must not be a way around the host grant.
test("an external link to an ungranted host is not opened at all", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)

  for (const url of [
    "https://attacker.example/collect?q=secret",
    "https://api.openai.com.attacker.example/x",
    "https://API.OPENAI.COM.attacker.example/x",
    "http://api.openai.com/insecure",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) {
    const decision = fake.windows[0].openHandler({ url })
    assert.deepEqual(decision, { action: "deny" })
    assert.ok(
      !fake.events.some((event) => event.startsWith("external:")),
      `${url} must not reach the browser`,
    )
  }
})

test("an app with no network grant cannot open anything externally", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, { ...PLAN, allowedHosts: [] })
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  fake.windows[0].openHandler({ url: "https://api.openai.com/docs" })
  assert.ok(!fake.events.some((event) => event.startsWith("external:")))
})

test("stopAll stops every running app", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.start("com.other.app", { ...PLAN, shortcuts: [] })
  const stopped = await runtime.stopAll()
  assert.deepEqual(stopped.sort(), [APP, "com.other.app"].sort())
  assert.deepEqual(runtime.runningApps(), [])
})

// Teardown must leave the session refusing everything. Clearing the handlers to
// `null` restores Electron's grant-by-default, so anything that outlives the
// teardown would be escalated rather than cut off.
test("teardown leaves the session denying every permission", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)

  await runtime.stop(APP)

  assert.equal(typeof session.handlers.request, "function")
  assert.equal(typeof session.handlers.check, "function")

  let allowed = null
  session.handlers.request({}, "media", (value) => {
    allowed = value
  }, { mediaTypes: ["audio"] })
  assert.equal(allowed, false)
  assert.equal(session.handlers.check({}, "media", "openwork-app://x", { mediaType: "audio" }), false)
  assert.equal(session.handlers.device(), false)
})

test("the session is still locked down when destroying a window throws", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  await runtime.openSurface(APP, SURFACE, DISPLAY)
  const session = fake.sessions.get(`persist:openwork-app-${APP}`)
  fake.windows[0].destroy = () => {
    throw new Error("destroy failed")
  }

  await runtime.stop(APP)

  let allowed = null
  session.handlers.request({}, "media", (value) => {
    allowed = value
  }, { mediaTypes: ["audio"] })
  assert.equal(allowed, false)
})

test("a surface whose load fails leaves no window behind", async () => {
  const fake = fakeElectron()
  const runtime = supervisor(fake)
  await runtime.start(APP, PLAN)
  fake.control.nextLoadError = new Error("entrypoint missing")

  await assert.rejects(() => runtime.openSurface(APP, SURFACE, DISPLAY))

  // An untracked window is one no teardown path can ever reach.
  assert.equal(await runtime.stop(APP), true)
  assert.ok(fake.windows.every((window) => window.isDestroyed()))
})
