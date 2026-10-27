export interface BrowserSpeechRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
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
  onText(text: string): void
  onState(state: "starting" | "listening" | "stopping" | "idle"): void
  onError(message: string): void
}) {
  const recognition = options.recognition
  const start = Math.max(0, Math.min(options.text.length, options.selection.start))
  const end = Math.max(start, Math.min(options.text.length, options.selection.end))
  const before = options.text.slice(0, start)
  const after = options.text.slice(end)
  let latest = options.text
  let live = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const endSession = () => { live = false; clearTimeout(timer); options.onState("idle") }
  recognition.lang = options.language
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onstart = () => { if (live) options.onState("listening") }
  recognition.onend = () => { if (live) endSession() }
  recognition.onerror = event => {
    if (!live) return
    if (event.error !== "aborted") options.onError(speechError(event.error))
    endSession()
  }
  recognition.onresult = event => {
    if (!live) return
    let transcript = ""
    for (let index = 0; index < event.results.length; index++) {
      const part = event.results[index]?.[0]?.transcript ?? ""
      if (transcript && part && !/\s$/.test(transcript) && !/^[\s.,!?;:]/.test(part)) transcript += " "
      transcript += part
    }
    if (!transcript) { latest = options.text; options.onText(latest); return }
    const left = before && !/\s$/.test(before) && !/^[\s.,!?;:]/.test(transcript) ? " " : ""
    const right = after && !/^[\s.,!?;:]/.test(after) && !/\s$/.test(transcript) ? " " : ""
    latest = before + left + transcript + right + after
    options.onText(latest)
  }
  function commit() {
    if (live) {
      endSession()
      try { recognition.abort() } catch { /* Already ended. */ }
    }
    return latest
  }
  return {
    text: () => latest,
    start() {
      options.onState("starting")
      try { recognition.start() }
      catch { options.onError("Couldn’t start dictation. Check microphone access."); endSession() }
    },
    stop() {
      if (!live) return
      options.onState("stopping")
      timer = setTimeout(commit, 1500)
      try { recognition.stop() } catch { commit() }
    },
    commit,
  }
}
