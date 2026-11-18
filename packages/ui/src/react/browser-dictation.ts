export interface BrowserSpeechRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  /** Optional host-provided microphone meter; browsers need no second stream. */
  onlevel?: ((level: number) => void) | null
  onstatus?: ((status: "installing", progress?: number) => void) | null
  start(): void
  stop(): void
  abort(): void
}
export type BrowserSpeechConstructor = new () => BrowserSpeechRecognition
declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechConstructor
    webkitSpeechRecognition?: BrowserSpeechConstructor
  }
}
export function browserSpeechConstructor(): BrowserSpeechConstructor | undefined {
  if (typeof window === "undefined" || !window.isSecureContext) return undefined
  return window.SpeechRecognition ?? window.webkitSpeechRecognition
}
function speechError(error: string) {
  if (error === "model-unavailable") return "The local speech model couldn’t download. Check your connection and free disk space, then try again."
  if (error === "finalization-timeout") return "Dictation took too long to finish. Review the captured words before sending."
  if (error === "not-allowed" || error === "service-not-allowed") return "Allow microphone access in your browser."
  if (error === "audio-capture") return "Connect a microphone and try again."
  if (error === "no-speech") return "No speech detected. Try again."
  if (error === "language-not-supported") return "Choose a supported speech language in your browser."
  return "Speech recognition couldn’t connect. Try again."
}
/** Each result replaces the session transcript, including revised interim words.
 * Sending commits the latest text and fences late events before clearing a draft. */
export function createBrowserDictation(options: {
  recognition: BrowserSpeechRecognition
  text: string
  selection: { start: number; end: number }
  language: string
  finalizationTimeoutMs?: number
  /** Optional display pacing; recognition and finalization never wait on it. */
  resultFrames?: {
    request(callback: (time: number) => void): number
    cancel(id: number): void
    now(): number
  }
  onLevel?(level: number): void
  onStatus?(status: "installing", progress?: number): void
  onText(text: string): void
  onState(state: "starting" | "listening" | "stopping" | "idle"): void
  onError(message: string, code?: string): void
}) {
  const recognition = options.recognition
  const start = Math.max(0, Math.min(options.text.length, options.selection.start))
  const end = Math.max(start, Math.min(options.text.length, options.selection.end))
  const before = options.text.slice(0, start)
  const after = options.text.slice(end)
  let latest = options.text
  let displayed = options.text
  let live = true
  let stopping = false
  let resolveFinished: (text: string | null) => void = () => {}
  const finished = new Promise<string | null>(resolve => { resolveFinished = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined
  const frames = options.resultFrames
  let frame: number | undefined
  let revealFrom = displayed
  let revealStartedAt = 0
  let receivedResult = false
  const graphemes = frames ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined
  const publishText = (text: string) => {
    if (displayed === text) return
    displayed = text
    options.onText(text)
  }
  const clearFrame = () => {
    if (frame !== undefined) frames?.cancel(frame)
    frame = undefined
  }
  const publish = () => { clearFrame(); publishText(latest) }
  const reveal = (time: number) => {
    frame = undefined
    if (!live || !frames || !graphemes) return
    const progress = Math.min(1, Math.max(0, (time - revealStartedAt) / 100))
    const tail = Array.from(graphemes.segment(latest.slice(revealFrom.length)), part => part.segment)
    const next = revealFrom + tail.slice(0, Math.ceil(tail.length * progress)).join("")
    // A revision can shorten the undisplayed tail during this same window.
    // Keep the visible prefix until the reveal catches up with it again.
    if (next.length >= displayed.length) publishText(next)
    if (displayed !== latest) frame = frames.request(reveal)
  }
  const publishResult = () => {
    // Show the first words and revisions immediately. Only appended text is
    // revealed over frames, coalescing new bursts into the same 100 ms window.
    if (!frames || !receivedResult || stopping || !latest.startsWith(displayed)) publish()
    else if (latest !== displayed && frame === undefined) {
      revealFrom = displayed
      revealStartedAt = frames.now()
      frame = frames.request(reveal)
    }
    receivedResult = true
  }
  const endSession = (keep = true, successful = true) => {
    live = false
    clearTimeout(timer)
    clearFrame()
    if (keep) publish()
    options.onState("idle")
    resolveFinished(successful ? latest : null)
  }
  recognition.lang = options.language
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onstart = () => { if (live) options.onState("listening") }
  recognition.onend = () => { if (live) endSession() }
  recognition.onlevel = level => { if (live && !stopping && Number.isFinite(level)) options.onLevel?.(Math.max(0, Math.min(1, level))) }
  recognition.onstatus = (status, progress) => {
    if (live && !stopping) options.onStatus?.(status,
      typeof progress === "number" && Number.isFinite(progress) && progress >= 0 && progress <= 1 ? progress : undefined)
  }
  recognition.onerror = event => {
    if (!live) return
    if (event.error !== "aborted") options.onError(speechError(event.error), event.error)
    endSession(true, false)
    try { recognition.abort() } catch { /* Already ended. */ }
  }
  recognition.onresult = event => {
    if (!live) return
    let transcript = ""
    for (let index = 0; index < event.results.length; index++) {
      const part = event.results[index]?.[0]?.transcript ?? ""
      if (transcript && part && !/\s$/.test(transcript) && !/^[\s.,!?;:]/.test(part)) transcript += " "
      transcript += part
    }
    if (!transcript) { latest = options.text; publishResult(); return }
    const left = before && !/\s$/.test(before) && !/^[\s.,!?;:]/.test(transcript) ? " " : ""
    const right = after && !/^[\s.,!?;:]/.test(after) && !/\s$/.test(transcript) ? " " : ""
    latest = before + left + transcript + right + after
    publishResult()
  }
  function commit() {
    if (live) {
      endSession(true, false)
      try { recognition.abort() } catch { /* Already ended. */ }
    }
    return latest
  }
  function stop() {
    if (!live || stopping) return
    stopping = true
    publish()
    options.onState("stopping")
    timer = setTimeout(() => {
      if (options.finalizationTimeoutMs) options.onError(speechError("finalization-timeout"))
      commit()
    }, options.finalizationTimeoutMs ?? 1500)
    try { recognition.stop() } catch { commit() }
  }
  return {
    text: () => displayed,
    start() {
      options.onState("starting")
      try { recognition.start() }
      catch { options.onError("Couldn’t start dictation. Check microphone access."); endSession(true, false) }
    },
    stop,
    /** Finalize before sending; errors and cancellation leave a draft to review. */
    finish() { stop(); return finished },
    cancel() {
      if (!live) return
      endSession(false, false)
      try { recognition.abort() } catch { /* Already ended. */ }
    },
    commit,
  }
}
