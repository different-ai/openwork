const { contextBridge, ipcRenderer } = require("electron")

// The app preload bridge.
//
// This is the entire surface an app renderer can see of the host. It is small on
// purpose, and every omission is deliberate:
//
//   * `ipcRenderer` is never exposed, in any wrapped or partial form. An app
//     cannot reach a channel this file does not name.
//   * There is no channel parameter. The app cannot choose what to send on;
//     there is one request channel and one event channel, both fixed here.
//   * Nothing synchronous. `sendSync` would block the main process on renderer
//     input.
//   * The app id comes from the main process at handshake time, not from the
//     renderer, so an app cannot claim to be another one.
//
// Requests are plain JSON. The main process validates every one against the
// versioned capability schema before it reaches any host service — this file
// does no authorisation of its own and must not be read as if it did.

const REQUEST_CHANNEL = "openwork-app:capability"
const EVENT_CHANNEL = "openwork-app:event"

const listeners = new Set()

ipcRenderer.on(EVENT_CHANNEL, (_event, payload) => {
  for (const listener of listeners) {
    try {
      listener(payload)
    } catch {
      // A throwing listener is the app's problem and must not break delivery to
      // the others, or take down the bridge.
    }
  }
})

function request(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return Promise.resolve({
      ok: false,
      error: { code: "invalid_request", message: "A capability request must be an object." },
    })
  }
  // Structured-clone the request so a getter or proxy on the app's object cannot
  // observe or change what is actually sent.
  return ipcRenderer.invoke(REQUEST_CHANNEL, JSON.parse(JSON.stringify(payload)))
}

function on(listener) {
  if (typeof listener !== "function") return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

contextBridge.exposeInMainWorld("openwork", Object.freeze({ request, on }))
