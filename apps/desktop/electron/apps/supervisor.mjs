import { resolveSurfaceBounds, surfaceWindowOptions } from "./geometry.mjs"
import {
  APP_PROTOCOL,
  buildContentSecurityPolicy,
  isPermittedNavigation,
  isPermittedRequest,
} from "./protocol.mjs"

// The app runtime supervisor.
//
// Owns the lifetime of everything an app has in the desktop shell: its
// partitioned session, its surface windows, its global shortcuts, and its crash
// record. Electron is injected rather than imported so every decision here is
// testable — what options a window is created with, what happens on disable,
// what a crash loop leads to.
//
// The rule that shapes the whole file: **stopping an app must stop all of it.**
// A teardown that leaves a shortcut registered, a window on screen, or a
// microphone open is not a teardown, so `stop()` is written to be exhaustive and
// is tested for exactly that.

/**
 * What a media permission request actually asked for.
 *
 * `setPermissionRequestHandler` reports `details.mediaTypes` (an array) and
 * `setPermissionCheckHandler` reports `details.mediaType` (a string), so both
 * shapes are normalised here rather than at each call site.
 */
function requestedMediaTypes(details) {
  if (!details) return []
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes
  if (typeof details.mediaType === "string") {
    return details.mediaType === "unknown" ? [] : [details.mediaType]
  }
  return []
}

/**
 * Deny by default, and never answer a broader question than the app asked.
 *
 * Electron folds the microphone and the camera into one `media` permission, so a
 * handler that reads only the permission name hands the webcam to any app that
 * asked for the microphone. There is no camera permission in the vocabulary at
 * all, so video is refused unconditionally — and a request Electron cannot
 * describe is refused too, because it may include video.
 */
export function decideAppPermission(permission, plan, details) {
  if (plan?.allowMicrophone !== true) return false
  if (permission !== "media" && permission !== "audioCapture") return false
  const types = requestedMediaTypes(details)
  if (types.length === 0) return permission === "audioCapture"
  return types.every((type) => type === "audio")
}

/**
 * Whether a URL may be handed to the user's browser.
 *
 * Opening a link externally is still egress on the app's behalf, so it is held
 * to the same host grant as an in-sandbox request. An app with no `network.host`
 * permission cannot use `window.open` as an unfiltered side channel.
 */
export function isPermittedExternalTarget(rawUrl, allowedHosts) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  return (allowedHosts ?? []).includes(url.hostname)
}

export class AppRuntimeSupervisor {
  #electron
  #installedRoots
  #onCrash
  #onGesture
  #preloadPath
  /** appId -> { windows: Map<surfaceId, window>, shortcuts: string[], session, capturing } */
  #running = new Map()

  constructor({ electron, installedRoots, preloadPath, onCrash, onGesture }) {
    this.#electron = electron
    this.#installedRoots = installedRoots
    this.#preloadPath = preloadPath
    this.#onCrash = onCrash ?? (() => {})
    this.#onGesture = onGesture ?? (() => {})
  }

  isRunning(appId) {
    return this.#running.has(appId)
  }

  runningApps() {
    return [...this.#running.keys()]
  }

  /**
   * Bring an app up.
   *
   * Idempotent: starting an already-running app is a no-op rather than a second
   * set of windows and a second shortcut registration.
   */
  async start(appId, plan) {
    if (this.#running.has(appId)) return this.#running.get(appId)

    const partition = `persist:openwork-app-${appId}`
    const session = this.#electron.session.fromPartition(partition)
    this.#applySessionPolicy(appId, session, plan)

    const state = {
      partition,
      session,
      windows: new Map(),
      shortcuts: [],
      capturing: false,
      allowedHosts: plan.allowedHosts ?? [],
    }
    this.#running.set(appId, state)

    for (const shortcut of plan.shortcuts ?? []) {
      const registered = this.#electron.globalShortcut.register(shortcut.accelerator, () => {
        // A global shortcut is a real user gesture, so it is allowed to mint a
        // token. Nothing else in the runtime can.
        this.#onGesture(appId, shortcut.id)
      })
      if (registered) state.shortcuts.push(shortcut.accelerator)
    }

    return state
  }

  /**
   * Session-level policy.
   *
   * Applied to the partition rather than per-window, so it covers subframes,
   * workers, and anything else the renderer can originate.
   */
  #applySessionPolicy(appId, session, plan) {
    const allowedHosts = plan.allowedHosts ?? []

    // Network enforcement. CSP alone is not enough: this is the layer that
    // catches a request CSP does not cover.
    session.webRequest.onBeforeRequest({ urls: ["*://*/*", `${APP_PROTOCOL}://*/*`] }, (details, callback) => {
      callback({ cancel: !isPermittedRequest(details.url, appId, allowedHosts) })
    })

    session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [buildContentSecurityPolicy(appId, allowedHosts)],
          "X-Content-Type-Options": ["nosniff"],
        },
      })
    })

    // Device and capability permissions. Everything is denied unless the app's
    // manifest permission put it on this list, and the list has no entry for
    // geolocation, notifications, clipboard reads, or screen capture at all.
    session.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(decideAppPermission(permission, plan, details))
    })
    session.setPermissionCheckHandler((_contents, permission, _origin, details) => {
      return decideAppPermission(permission, plan, details)
    })
    // Refuse device selection outright: an app may use the default microphone
    // once granted, and may not enumerate or pick hardware.
    session.setDevicePermissionHandler?.(() => false)
  }

  /**
   * Refuse everything on this session.
   *
   * Used at teardown in place of clearing the handlers. A `null` handler is not
   * "no opinion" — it is Electron's default, which grants several permissions
   * outright, so the deny-all state has to be written explicitly.
   */
  #denyAllPermissions(session) {
    session.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler?.(() => false)
    session.setDevicePermissionHandler?.(() => false)
  }

  /** Open one declared surface. */
  async openSurface(appId, surface, display) {
    const state = this.#running.get(appId)
    if (!state) throw new Error(`app ${appId} is not running`)
    const existing = state.windows.get(surface.id)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      return existing
    }

    const bounds = resolveSurfaceBounds(surface.defaultSize, display.workArea, surface.anchor)
    const window = this.#electron.createWindow(
      surfaceWindowOptions({
        appId,
        bounds,
        alwaysOnTop: surface.alwaysOnTop,
        preloadPath: this.#preloadPath,
        partition: state.partition,
      }),
    )

    // Navigation and window creation are refused at the contents level. An app
    // cannot open a popup, and a link to an external site opens in the user's
    // browser instead of inside the sandbox.
    window.webContents.on("will-navigate", (event, url) => {
      if (!isPermittedNavigation(url, appId)) event.preventDefault()
    })
    window.webContents.setWindowOpenHandler((details) => {
      if (isPermittedExternalTarget(details.url, state.allowedHosts)) {
        this.#electron.openExternal(details.url)
      }
      return { action: "deny" }
    })
    window.webContents.on("render-process-gone", (_event, details) => {
      this.#onCrash(appId, details?.reason ?? "unknown")
    })
    window.webContents.on("preload-error", () => {
      this.#onCrash(appId, "preload-error")
    })

    if (surface.alwaysOnTop) {
      // `floating` sits above ordinary windows but below system UI, and
      // `visibleOnFullScreenWorkspaces` keeps an ambient surface present without
      // pulling the user out of a full-screen app.
      window.setAlwaysOnTop?.(true, "floating")
      window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreenWorkspaces: true })
    }

    // Track the window before the load, not after. A load that fails used to
    // leave a live, untracked window that no teardown path could ever destroy —
    // and an orphan in this session is exactly what teardown must be able to
    // reach.
    state.windows.set(surface.id, window)
    try {
      await window.loadURL(`${APP_PROTOCOL}://${appId}/${surface.entrypoint}`)
    } catch (error) {
      state.windows.delete(surface.id)
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
    return window
  }

  closeSurface(appId, surfaceId) {
    const state = this.#running.get(appId)
    const window = state?.windows.get(surfaceId)
    if (!window) return false
    state.windows.delete(surfaceId)
    if (!window.isDestroyed()) window.destroy()
    return true
  }

  /**
   * Tear an app down completely.
   *
   * Order matters: capture stops before windows close, so the microphone is
   * released even if destroying a window throws. Every step is attempted
   * regardless of earlier failures — a partial teardown is the failure mode
   * this method exists to prevent.
   */
  async stop(appId, options = {}) {
    const state = this.#running.get(appId)
    if (!state) return false
    this.#running.delete(appId)

    const problems = []
    const attempt = async (label, action) => {
      try {
        // Awaited, so a rejecting step is recorded as a problem instead of
        // escaping as an unhandled rejection that takes the main process down
        // while `stop()` reports success.
        await action()
      } catch (error) {
        problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Lock the session down first, so every later step can fail without the app
    // regaining authority. Clearing the handlers to `null` would restore
    // Electron's grant-by-default, which turns a surface that outlives teardown
    // into an escalation from "everything denied" to microphone and camera.
    await attempt("session-handlers", () => this.#denyAllPermissions(state.session))

    await attempt("capture", () => {
      state.capturing = false
      this.#electron.stopCapture?.(appId)
    })

    for (const accelerator of state.shortcuts) {
      await attempt(`shortcut ${accelerator}`, () =>
        this.#electron.globalShortcut.unregister(accelerator),
      )
    }
    state.shortcuts = []

    for (const [surfaceId, window] of state.windows) {
      await attempt(`window ${surfaceId}`, () => {
        if (!window.isDestroyed()) window.destroy()
      })
    }
    state.windows.clear()

    // Clearing the partition is the difference between "stopped" and "gone".
    // On uninstall the app must keep nothing: no cache, no storage, no service
    // worker that could run again.
    if (options.purgeStorage === true) {
      await attempt("storage", () => state.session.clearStorageData?.())
      // `clearStorageData` leaves the HTTP and code caches alone, so without
      // these an uninstalled app keeps its fetched resources and compiled script.
      await attempt("cache", () => state.session.clearCache?.())
      await attempt("code-cache", () => state.session.clearCodeCaches?.({ urls: [] }))
    }

    if (problems.length > 0 && options.throwOnPartial === true) {
      throw new Error(`incomplete teardown for ${appId}: ${problems.join("; ")}`)
    }
    return true
  }

  /** Stop everything. Used on quit and on workspace teardown. */
  async stopAll(options = {}) {
    const ids = this.runningApps()
    for (const appId of ids) await this.stop(appId, options)
    return ids
  }

  markCapturing(appId, capturing) {
    const state = this.#running.get(appId)
    if (!state) return false
    state.capturing = capturing
    return true
  }

  isCapturing(appId) {
    return this.#running.get(appId)?.capturing === true
  }

  /** Absolute install root for the running version of each app. */
  installedRoots() {
    return this.#installedRoots
  }
}
