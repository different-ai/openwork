// OpenWork's optional Collabora integration. MIT; engine notices and About stay intact.
// This is the only module that reads the pinned engine's selection state and layout.
interface OpenWorkEngineMap {
  wopi?: { PostMessageOrigin?: string }
  stateChangeHandler?: { getItemValue(command: string): unknown }
  on(event: string, listener: () => void): void
  invalidateSize(): void
}
interface Window { app?: { map?: OpenWorkEngineMap }; autoShowWelcome?: boolean; autoShowFeedback?: boolean }

(() => {
  if (new URL(location.href).searchParams.get("integrator") !== "openwork") return
  document.documentElement.dataset.openworkEditor = "true"
  window.autoShowWelcome = false
  window.autoShowFeedback = false
  let map: OpenWorkEngineMap | undefined
  let queued = false
  const origin = () => {
    const value = map?.wopi?.PostMessageOrigin
    if (!value || value === "*") return null
    try { const url = new URL(value); return url.origin === value && ["https:", "http:"].includes(url.protocol) ? value : null } catch { return null }
  }
  const emit = (MessageId: string, Values: object) => {
    const target = origin()
    if (target) parent.postMessage(JSON.stringify({ MessageId, Values }), target)
  }
  const selection = () => {
    const value = (command: string) => map?.stateChangeHandler?.getItemValue(`.uno:${command}`)
    const flag = (command: string) => value(command) === true || value(command) === "true"
    const text = (command: string) => { const result = value(command); return typeof result === "string" && result.length <= 100 ? result : undefined }
    const size = Number(value("FontHeight"))
    const available = (command: string) => { const result = value(command); return result !== undefined && result !== "disabled" && result !== false }
    emit("OpenWork_Selection", {
      bold: flag("Bold"), italic: flag("Italic"), underline: flag("Underline"), font: text("CharFontName"),
      fontSize: Number.isFinite(size) && size > 0 ? size : undefined, style: text("StyleApply"),
      alignment: flag("CenterPara") ? "center" : flag("RightPara") ? "right" : flag("JustifyPara") ? "justify" : "left",
      canUndo: available("Undo"), canRedo: available("Redo"),
    })
  }
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; selection() })
  }
  const resize = () => requestAnimationFrame(() => { window.dispatchEvent(new Event("resize")); map?.invalidateSize() })
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const target = origin()
    if (!target || event.source !== parent || event.origin !== target) return
    let data = event.data
    if (typeof data === "string") { if (data.length > 4000) return; try { data = JSON.parse(data) } catch { return } }
    if (!data || typeof data !== "object" || !("MessageId" in data)) return
    if (data.MessageId === "OpenWork_Connect") { emit("OpenWork_Ready", { version: 1 }); selection(); resize() }
    if (data.MessageId === "OpenWork_Tools" && "Values" in data && data.Values && typeof data.Values === "object" && "open" in data.Values && typeof data.Values.open === "boolean") {
      document.documentElement.dataset.openworkTools = String(data.Values.open)
      emit("OpenWork_Tools", { open: data.Values.open }); resize()
    }
    if (data.MessageId === "OpenWork_Theme" && "Values" in data && data.Values && typeof data.Values === "object") {
      for (const [key, value] of Object.entries(data.Values)) {
        if (["bg", "text", "muted", "chip", "line", "surface"].includes(key) && typeof value === "string" && value.length <= 100 && CSS.supports("color", value)) document.documentElement.style.setProperty(`--ow-doc-${key}`, value)
      }
    }
  })
  // Engine initialization is asynchronous. Bound the wait; never poll a closed frame indefinitely.
  const until = Date.now() + 60_000
  const connect = () => {
    map = window.app?.map
    if (!map?.stateChangeHandler) { if (Date.now() < until) setTimeout(connect, 100); return }
    map.on("commandstatechanged", schedule)
    map.on("docloaded", () => { emit("OpenWork_Ready", { version: 1 }); schedule(); resize() })
    emit("OpenWork_Ready", { version: 1 }); schedule()
  }
  connect()
})()
