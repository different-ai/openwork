import { useState, type ReactNode } from "react"
import { Monitor } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"
import { settingsNavigationFromPathname } from "@/react-app/shell/workspace-routes"

/** "com.apple.TextEdit" reads as "TextEdit"; the agent's own purpose says the rest. */
function appLabel(appId: string | undefined) {
  const name = appId?.split(".").filter(Boolean).at(-1)
  return name && name.length <= 48 ? name : "a Mac app"
}

const SCRIPT_APPS = { applescript: "AppleScript", jxa: "JavaScript for Automation", blender: "Blender" } as const

/** Bidi controls, zero-width and other invisible characters change how code reads without changing what runs. */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F-\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu

/** Text with every hidden character shown as its code point, and how many there were. */
function revealHidden(text: string): { parts: ReactNode[]; hidden: number } {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(HIDDEN_CHARACTERS)) {
    const at = match.index ?? 0
    parts.push(text.slice(last, at))
    parts.push(<mark key={at} className="rounded bg-amber-3 px-0.5 text-amber-11">{`<U+${(match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`}</mark>)
    last = at + match[0].length
  }
  parts.push(text.slice(last))
  return { parts, hidden: (parts.length - 1) / 2 }
}

/**
 * The script exactly as it runs: every hidden character is shown as its code point,
 * and the text keeps its stored order instead of being reordered for right-to-left.
 */
function ScriptCode({ code, label }: { code: string; label: string }) {
  const { parts, hidden } = revealHidden(code)
  return (
    <>
      {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-script-hidden">This script has {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't run it unless you expected them.</div> : null}
      <pre dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="mt-2 max-h-48 overflow-auto rounded-lg border border-dls-border bg-dls-hover p-2 font-mono text-[12px] leading-5 text-dls-text whitespace-pre-wrap break-words" data-testid="session-computer-script" aria-label={label}>{parts}</pre>
    </>
  )
}

/**
 * The agent wants to run an app script. Nothing runs until the person approves this
 * exact code here; the broker checks the answer against this request.
 */
function ScriptRequest({ sessionId, request, script }: { sessionId: string; request: ComputerRequest; script: NonNullable<ComputerRequest["script"]> }) {
  const name = SCRIPT_APPS[script.app]
  const [busy, setBusy] = useState<"allow" | "always" | "dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "allow" | "always" | "dismiss") {
    if (busy) return
    setBusy(next)
    setError("")
    try {
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next, id: request.id })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason="script">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-dls-text">Run a {name} script?</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">It runs on {request.computer} as you and can change your files and apps.</div>
            <ScriptCode code={script.code} label={`${name} script`} />
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-script-dismiss" onClick={() => void answer("dismiss")}>Don't run</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-script-always" onClick={() => void answer("always")}>Always run {name} in this chat</Button>
          <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-script-run" onClick={() => void answer("allow")}>Run</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * An app's file panel or a web page is about to receive these files. Nothing is
 * handed over until the person approves this list; the broker checks the answer.
 */
function FilesRequest({ sessionId, request, files }: { sessionId: string; request: ComputerRequest; files: NonNullable<ComputerRequest["files"]> }) {
  const [busy, setBusy] = useState<"allow" | "always" | "dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "allow" | "always" | "dismiss") {
    if (busy) return
    setBusy(next)
    setError("")
    try {
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next, id: request.id })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const count = files.names.length
  // Each name exactly as stored: hidden characters shown, no right-to-left reordering.
  const shown = files.names.map(revealHidden)
  const hidden = shown.reduce((sum, name) => sum + name.hidden, 0)
  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason="files">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-dls-text">{count ? `Give ${count === 1 ? "this file" : `these ${count} files`} to ${files.app}?` : `Let the agent look through your files for ${files.app}?`}</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">{count
              ? `The agent chose ${count === 1 ? "it" : "them"} on ${request.computer}. ${files.app} can upload what it receives.`
              : `${files.app} opened a file panel on ${request.computer}. The agent sees the file names it shows, and asks again before handing any file over.`}</div>
            {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-files-hidden">These names have {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't give them unless you expected that.</div> : null}
            {count ? <ul dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="mt-2 max-h-32 overflow-auto rounded-lg border border-dls-border bg-dls-hover p-2 font-mono text-[12px] leading-5 text-dls-text" data-testid="session-computer-files">
              {shown.map((name, index) => <li key={index} className="break-all">{name.parts}</li>)}
            </ul> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-files-dismiss" onClick={() => void answer("dismiss")}>{count ? "Don't give" : "Don't allow"}</Button>
          {count ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-files-always" onClick={() => void answer("always")}>Always give files to {files.app} in this chat</Button> : null}
          <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-files-allow" onClick={() => void answer("allow")}>{count ? `Give ${count === 1 ? "file" : "files"}` : "Allow"}</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Shown above the composer while the agent waits for computer use. The tool
 * call carries on by itself once the person answers, so the agent never has
 * to ask them to go set it up and try again.
 */
export function ComputerRequestPanel({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  if (request.reason === "script" && request.script) return <ScriptRequest sessionId={sessionId} request={request} script={request.script} />
  if (request.reason === "files" && request.files) return <FilesRequest sessionId={sessionId} request={request} files={request.files} />
  return <SetupRequest sessionId={sessionId} request={request} />
}

function SetupRequest({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  const remote = request.placement === "remote"
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Setup lives in Settings; the agent keeps waiting and continues once the computer is ready.
  const openSetup = () => {
    const target = settingsNavigationFromPathname(pathname, "computer")
    navigate(target.to, { state: target.state })
  }
  const [busy, setBusy] = useState<"dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "dismiss") {
    if (busy) return
    setBusy(next)
    setError("")
    try {
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason={request.reason}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-dls-text">Set up computer use</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">
              {remote ? request.detail || `${request.computer} needs a desktop connection.` : <>Turn on the macOS permissions to continue working in {appLabel(request.appId)}.</>}
            </div>
            {request.purpose ? <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-dls-secondary">{request.purpose}</div> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-request-dismiss" onClick={() => void answer("dismiss")}>
            Not now
          </Button>
          <Button type="button" size="sm" data-testid="session-computer-request-setup" onClick={openSetup}>Set up</Button>
        </div>
      </div>
    </div>
  )
}
