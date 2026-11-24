import { useId, useRef, useState, type ReactNode } from "react"
import { KeyRound, Monitor, SquareTerminal } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import type { PrivateValueFill, PrivateValueUse, ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { SecretField, type SecretFieldHandle } from "@/components/secret-field"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { settingsNavigationFromPathname } from "@/react-app/shell/workspace-routes"

import { browserSecretKindLabel } from "../panel/browser-secrets"

function appLabel(appId: string | undefined) {
  const name = appId?.split(".").filter(Boolean).at(-1)
  return name && name.length <= 48 ? name : "a Mac app"
}

const SCRIPT_APPS = { applescript: "AppleScript", jxa: "JavaScript for Automation", blender: "Blender" } as const

const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F-\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu

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

function ScriptCode({ code, label }: { code: string; label: string }) {
  const { parts, hidden } = revealHidden(code)
  return (
    <>
      {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-script-hidden">This script has {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't run it unless you expected them.</div> : null}
      <pre dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="mt-2 max-h-48 overflow-auto rounded-lg border border-dls-border bg-dls-hover p-2 font-mono text-[12px] leading-5 text-dls-text whitespace-pre-wrap break-words" data-testid="session-computer-script" aria-label={label}>{parts}</pre>
    </>
  )
}

function ScriptRequest({ sessionId, request, script }: { sessionId: string; request: ComputerRequest; script: NonNullable<ComputerRequest["script"]> }) {
  const name = SCRIPT_APPS[script.app]
  const [busy, setBusy] = useState<"allow" | "dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "allow" | "dismiss") {
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
          <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-script-run" onClick={() => void answer("allow")}>Run</Button>
        </div>
      </div>
    </div>
  )
}

function FilesRequest({ sessionId, request, files }: { sessionId: string; request: ComputerRequest; files: NonNullable<ComputerRequest["files"]> }) {
  const [busy, setBusy] = useState<"allow" | "always" | "dismiss" | "remember" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "allow" | "always" | "dismiss" | "remember") {
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
  const saving = files.save === true && count === 1 ? files.names[0]! : null
  const savingName = saving?.slice(saving.lastIndexOf("/") + 1)
  const savingFolder = saving ? saving.slice(0, saving.lastIndexOf("/")).split("/").pop() || "/" : null
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
            <div className="text-[13px] font-medium leading-5 text-dls-text" title={saving ?? undefined}>{saving ? `Save ${savingName} to ${savingFolder} from ${files.app}?` : count ? `Give ${count === 1 ? "this file" : `these ${count} files`} to ${files.app}?` : `Let the agent look through your files for ${files.app}?`}</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">{saving
              ? `The agent chose where ${files.app} saves on ${request.computer}.`
              : count
              ? `The agent chose ${count === 1 ? "it" : "them"} on ${request.computer}. ${files.app} can upload what it receives.`
              : `${files.app} opened a file panel on ${request.computer}. The agent sees the file names it shows, and asks again before handing any file over.`}</div>
            {files.canRemember && files.site ? <div className="mt-1 text-[12px] leading-5 text-dls-secondary" data-testid="session-computer-files-remember-scope">Choosing a folder remembers file sharing with {files.site} from that folder across chats and Slack tasks on this computer. A system folder picker opens next. Remove permission in Settings → Computer use.</div> : null}
            {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-files-hidden">These names have {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't give them unless you expected that.</div> : null}
            {count ? <ul dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="mt-2 max-h-32 overflow-auto rounded-lg border border-dls-border bg-dls-hover p-2 font-mono text-[12px] leading-5 text-dls-text" data-testid="session-computer-files">
              {shown.map((name, index) => <li key={index} className="break-all">{name.parts}</li>)}
            </ul> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-files-dismiss" onClick={() => void answer("dismiss")}>{saving ? "Don't save" : count ? "Don't give" : "Don't allow"}</Button>
          {count && !saving && request.standing !== false ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-files-always" onClick={() => void answer("always")}>Always give files to {files.app} in this chat</Button> : null}
          {files.canRemember ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "remember"} data-testid="session-computer-files-remember" onClick={() => void answer("remember")}>Choose folder and remember</Button> : null}
          <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-files-allow" onClick={() => void answer("allow")}>{saving ? "Save" : count ? `Give ${count === 1 ? "file" : "files"}` : "Allow"}</Button>
        </div>
      </div>
    </div>
  )
}

function CredentialRequest({ sessionId, request, credential }: { sessionId: string; request: ComputerRequest; credential: NonNullable<ComputerRequest["credential"]> }) {
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

  const site = credential.site?.replace(/^https:\/\//, "")
  const name = !site && credential.app && credential.app !== credential.appId ? revealHidden(credential.app) : null
  const id = revealHidden(site ?? credential.appId ?? credential.app ?? "this app")
  const hidden = id.hidden + (name?.hidden ?? 0)
  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason="credential">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <Monitor size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-dls-text">Enter your password or code {site ? "on" : "in"} <span dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="break-all font-mono" data-testid="session-computer-credential-site">{name ? <>{name.parts} (</> : null}{id.parts}{name ? ")" : null}</span>?</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">{site
              ? "The agent types what you gave it into this site's sign-in field. Check the address is the site you meant; any other site asks again."
              : `The agent types what you gave it into this app on ${request.computer}. It asks again each time.`}</div>
            {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-credential-hidden">This name has {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't enter anything unless you expected that.</div> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-credential-dismiss" onClick={() => void answer("dismiss")}>Don't enter</Button>
          {request.standing !== false ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-credential-always" onClick={() => void answer("always")}>Always for this site in this chat</Button> : null}
          <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-credential-allow" onClick={() => void answer("allow")}>Enter</Button>
        </div>
      </div>
    </div>
  )
}

const SECRET_FIELDS = new Map([
  ["password", "a password field"],
  ["text", "a text field"],
  ["email", "an email field"],
  ["tel", "a phone number field"],
  ["url", "a web address field"],
  ["search", "a search field"],
  ["textarea", "a multi-line text field"],
])

function SecretRequest({ sessionId, request, site, secret }: { sessionId: string; request: ComputerRequest; site: string | undefined; secret: NonNullable<NonNullable<ComputerRequest["credential"]>["secret"]> }) {
  const [busy, setBusy] = useState<"allow" | "dismiss" | null>(null)
  const [error, setError] = useState("")

  async function answer(next: "allow" | "dismiss") {
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

  const label = revealHidden(secret.label)
  const where = site ? revealHidden(site) : null
  const hidden = label.hidden + (where?.hidden ?? 0)
  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason="credential" data-credential="secret">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            <KeyRound size={16} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-dls-text">
              Fill “<span dir="auto" style={{ unicodeBidi: "isolate" }} className="break-words" data-testid="session-computer-credential-secret-label">{label.parts}</span>”
              {where ? <> on <span dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="break-all font-mono" data-testid="session-computer-credential-site">{where.parts}</span></> : null}?
            </div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary" data-testid="session-computer-credential-field">{browserSecretKindLabel(secret.kind)}, into {SECRET_FIELDS.get(secret.field) ?? "a field on this page"}.</div>
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">{where
              ? "OpenWork fills it without showing it to the agent, and sends it only to the sites you allowed for it. Check the address is the site you meant."
              : "OpenWork can't tell which site this is for, so it won't be filled."}</div>
            {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-credential-hidden">This request has {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't fill it unless you expected that.</div> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-credential-dismiss" onClick={() => void answer("dismiss")}>Don't fill</Button>
          {where ? <Button type="button" size="sm" disabled={busy !== null} aria-busy={busy === "allow"} data-testid="session-computer-credential-allow" onClick={() => void answer("allow")}>Fill</Button> : null}
        </div>
      </div>
    </div>
  )
}

const VALUE_FIELDS = new Map([...SECRET_FIELDS, ["number", "a number field"]])

function shellQuotedLine(command: string[]) {
  return command.map((part) => part !== "" && /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(" ")
}

function valuePlace(field: string) {
  if (field.startsWith("file in $")) return `In a private file, its path in ${field.slice("file in ".length)}`
  if (field.startsWith("$")) return `As ${field}`
  if (field.startsWith("header ")) return `In the ${field.slice("header ".length)} header`
  return "In the request body"
}

function ValuesRequest({ sessionId, request, site, use, fills }: { sessionId: string; request: ComputerRequest; site: string | undefined; use: PrivateValueUse | undefined; fills: PrivateValueFill[] }) {
  const [busy, setBusy] = useState<"allow" | "always" | "dismiss" | null>(null)
  const [error, setError] = useState("")
  const [switched, setSwitched] = useState<boolean[]>(() => fills.map(() => false))
  const [filled, setFilled] = useState<boolean[]>(() => fills.map(() => false))
  const [keep, setKeep] = useState<boolean[]>(() => fills.map(() => false))
  const handles = useRef<Array<SecretFieldHandle | null>>([])
  const formId = useId()
  const at = (index: number, value: boolean) => (current: boolean[]) => current.map((item, position) => position === index ? value : item)

  const swapped = fills.map((fill, index) => fill.command !== undefined && switched[index] === true)
  const needed = fills.map((fill) => fill.unlock === undefined || fills.some((row, index) => row.command !== undefined && row.needs === fill.unlock && row.command[0] === fill.program && !swapped[index]))
  const typed = fills.map((fill, index) => needed[index] === true && (fill.ask === undefined ? switched[index] === true : fill.kept !== true || switched[index] === true))
  const pasting = typed.some(Boolean)
  const ready = typed.every((needed, index) => !needed || filled[index] === true)

  async function answer(next: "allow" | "always" | "dismiss") {
    if (busy || (next !== "dismiss" && !ready)) return
    setBusy(next)
    setError("")
    try {
      const given = next !== "dismiss" && pasting
        ? { values: typed.map((needed, index) => needed ? handles.current[index]?.take() ?? null : null), keep: typed.map((needed, index) => needed && keep[index] === true && fills[index]?.ask !== undefined) }
        : {}
      await desktopBridge.computerAnswerRequest({ sessionId, answer: next, id: request.id, ...given })
    } catch (cause) {
      setError(`That wasn't saved. ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const where = use ? revealHidden(use.kind === "run" ? shellQuotedLine(use.command) : `${use.method} ${use.url}`) : site ? revealHidden(site.replace(/^https:\/\//, "")) : null
  const shown = fills.map((fill) => ({
    source: revealHidden(fill.ask === undefined ? shellQuotedLine(fill.command) : fill.ask),
    field: fill.field === undefined ? "" : use ? valuePlace(fill.field) : VALUE_FIELDS.get(fill.field) ?? "a field on this page",
    program: fill.unlock === undefined ? null : revealHidden(fill.program),
  }))
  const sealed = use?.kind === "request" ? (use.seal ?? []).map((entry) => ({ name: entry.name, from: entry.from, for: revealHidden(entry.for.replace(/^https:\/\//, "")) })) : []
  const hidden = shown.reduce((total, fill) => total + fill.source.hidden + (fill.program?.hidden ?? 0), (where?.hidden ?? 0) + sealed.reduce((total, entry) => total + entry.for.hidden, 0))
  const canPaste = request.credential?.paste !== false
  const canKeep = request.credential?.keep !== false
  const fields = fills.filter((fill) => fill.unlock === undefined).length
  const one = fields === 1
  const running = fills.filter((fill, index) => fill.command !== undefined && !typed[index]).length
  const keyed = fills.some((fill, index) => fill.unlock !== undefined && needed[index] === true)
  const pastingField = fills.some((fill, index) => fill.unlock === undefined && typed[index] === true)
  const sent = use?.kind === "request"
  const explained = use ? (sent
      ? `OpenWork gets each value${running > 0 ? `, running ${running === 1 ? "the command" : "the commands"} on ${request.computer} as you,` : ""} and sends this one request with them. The agent sees the answer with every value hidden, never the values. Check the address is the site you meant.`
      : `OpenWork gets each value${running > 0 ? `, running ${running === 1 ? "the command that prints it" : "the commands that print them"},` : ""} and runs this command on ${request.computer} as you with them. The agent chose it and sees what it prints with every value hidden, never the values. Approve only what you recognize.`)
    : !where ? "OpenWork can't tell which site this is for, so nothing will be filled."
    : running > 0 && keyed && !pastingField ? `OpenWork runs ${one ? "it" : "each one"} on ${request.computer} as you, with the key ${pasting ? "you paste here" : "you kept for this chat"}, and types the result into the field. The agent chose the command and never sees the key or the result. Approve only what you recognize.`
    : !pasting && running > 0 ? `OpenWork runs ${one ? "it" : "each one"} on ${request.computer} as you and types the result into the field. The agent chose the command and never sees the result. Approve only what you recognize.`
    : running > 0 ? `OpenWork runs each command on ${request.computer} as you and types what it prints, and types what you paste here. The agent never sees any of it. Approve only what you recognize.`
    : pasting ? `Paste ${one ? "it" : "each one"} here. OpenWork types ${one ? "it" : "them"} into the page, and the agent never sees ${one ? "it" : "them"}. Check the address is the site you meant.`
    : `OpenWork types what you kept for this chat into the page. The agent never sees it. Check the address is the site you meant.`
  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="session-computer-request" data-reason="credential" data-credential="values">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
            {running > 0 ? <SquareTerminal size={16} strokeWidth={1.9} /> : <KeyRound size={16} strokeWidth={1.9} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-dls-text" data-testid="session-computer-credential-title">
              {use ? (sent ? <>Send {one ? "a private value" : `${fields} private values`} in this request?</> : <>Run this command with {one ? "a private value" : `${fields} private values`}?</>) : (
                <>{running > 0 && !pastingField
                  ? <>Run {one ? "this command" : `these ${fields} commands`} and fill what {one ? "it prints" : "they print"}</>
                  : <>Fill {one ? "this field" : `these ${fields} fields`}</>}
                {where ? <> on <span dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="wrap-anywhere font-mono" data-testid="session-computer-credential-site">{where.parts}</span></> : null}?</>)}
            </div>
            {use && where ? <code dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="mt-1 block whitespace-pre-wrap wrap-anywhere rounded-lg border border-dls-border bg-dls-hover px-2 py-1 font-mono text-[12px] leading-5 text-dls-text" data-testid="session-computer-credential-use" data-use={use.kind}>{where.parts}</code> : null}
            <div className="mt-0.5 text-[12px] leading-5 text-dls-secondary">{explained}</div>
            {sealed.length ? (
              <div className="mt-2 rounded-lg border border-dls-border bg-dls-hover p-2 text-[12px] leading-5 text-dls-secondary" data-testid="session-computer-credential-seal">
                <div className="font-medium text-dls-text">Keeps from the answer, hidden from the agent, for this chat</div>
                <ul className="mt-1 flex flex-col gap-1">
                  {sealed.map((entry) => (
                    <li key={entry.name} data-testid="session-computer-credential-seal-row">
                      <span className="font-mono text-dls-text">{entry.name}</span> from <span className="font-mono">{entry.from}</span>, sent only to <span dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="wrap-anywhere font-mono">{entry.for.parts}</span> when you approve
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="mt-2 flex max-h-72 flex-col gap-3 overflow-auto rounded-lg border border-dls-border bg-dls-hover p-2" data-testid="session-computer-credential-fills">
              {fills.map((fill, index) => {
                const row = shown[index]
                if (!row) return null
                const asked = fill.ask !== undefined
                const keptHere = asked && fill.kept === true
                const key = fill.unlock !== undefined
                if (key && needed[index] !== true) return null
                return (
                  <li key={index} className="flex min-w-0 flex-col gap-1" data-testid="session-computer-credential-fill" data-row={key ? "key" : "field"} data-source={typed[index] ? "paste" : asked ? "kept" : "command"}>
                    {asked
                      ? <div dir="auto" style={{ unicodeBidi: "isolate" }} className="break-words text-[12px] font-medium leading-5 text-dls-text" data-testid="session-computer-credential-ask">{row.source.parts}</div>
                      : <code dir="ltr" style={{ unicodeBidi: "bidi-override" }} className={`block whitespace-pre-wrap wrap-anywhere font-mono text-[12px] leading-5 ${typed[index] ? "text-dls-secondary line-through" : "text-dls-text"}`} data-testid="session-computer-credential-command">{row.source.parts}</code>}
                    {key
                      ? <div className="text-[12px] leading-5 text-dls-secondary" data-testid="session-computer-credential-field">Given to <span dir="ltr" style={{ unicodeBidi: "bidi-override" }} className="wrap-anywhere font-mono">{row.program?.parts}</span> as <span className="font-mono">{fill.unlock}</span>, for this run only{keptHere && !typed[index] ? ", from what you kept for this chat" : ""}</div>
                      : <div className="text-[12px] leading-5 text-dls-secondary" data-testid="session-computer-credential-field">{use ? row.field : <>Into {row.field}</>}{keptHere && !typed[index] ? ", from what you kept for this chat" : ""}{fill.needs !== undefined && !typed[index] ? <>, with <span className="font-mono">{fill.needs}</span> set</> : null}</div>}
                    {where && typed[index] ? (
                      <SecretField id={`${formId}-${index}`} label={asked ? `Paste ${fill.ask}` : `Paste the value for ${row.field}`} labelHidden placeholder={key ? "Paste the key here" : "Paste it here"} multiline={fill.field === "textarea"}
                        disabled={busy !== null} testId="session-computer-credential-paste" className="bg-dls-surface"
                        handleRef={(handle) => { handles.current[index] = handle }}
                        onValueChange={(has) => setFilled(at(index, has))} onSubmit={() => void answer("allow")} />
                    ) : null}
                    {where && typed[index] && asked && canKeep ? (
                      <label className="flex items-center gap-2 text-[12px] leading-5 text-dls-secondary">
                        <Checkbox checked={keep[index] === true} disabled={busy !== null} data-testid="session-computer-credential-keep" onCheckedChange={(checked) => setKeep(at(index, checked === true))} />
                        Keep for this chat, in memory only
                      </label>
                    ) : null}
                    {where && canPaste && (!asked || keptHere) ? (
                      <div>
                        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[12px]" disabled={busy !== null} data-testid="session-computer-credential-switch"
                          onClick={() => { setSwitched(at(index, switched[index] !== true)); setFilled(at(index, false)) }}>
                          {asked ? (typed[index] ? "Use the one you kept" : "Paste a different one") : (typed[index] ? "Run the command instead" : "Paste it instead")}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {hidden ? <div className="mt-2 text-[12px] font-medium leading-5 text-amber-11" data-testid="session-computer-credential-hidden">This request has {hidden === 1 ? "1 hidden character" : `${hidden} hidden characters`}, shown as &lt;U+…&gt;. Don't {running > 0 ? "run" : "fill"} it unless you expected that.</div> : null}
            {error ? <div role="alert" className="mt-1 text-[12px] leading-5 text-red-11">{error}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "dismiss"} data-testid="session-computer-credential-dismiss" onClick={() => void answer("dismiss")}>{use ? (sent ? "Don't send" : "Don't run") : running > 0 && !pastingField ? "Don't run" : "Don't fill"}</Button>
          {where && request.standing !== false && !pasting ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === "always"} data-testid="session-computer-credential-always" onClick={() => void answer("always")}>{use ? (sent ? "Always for this request in this chat" : "Always for this command in this chat") : "Always for this site in this chat"}</Button> : null}
          {where ? <Button type="button" size="sm" disabled={busy !== null || !ready} aria-busy={busy === "allow"} data-testid="session-computer-credential-allow" onClick={() => void answer("allow")}>{use ? (sent ? "Send" : "Run") : running > 0 ? "Run and fill" : "Fill"}</Button> : null}
        </div>
      </div>
    </div>
  )
}

export function ComputerRequestPanel({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  if (request.reason === "script" && request.script) return <ScriptRequest sessionId={sessionId} request={request} script={request.script} />
  if (request.reason === "files" && request.files) return <FilesRequest sessionId={sessionId} request={request} files={request.files} />
  if (request.reason === "credential" && request.credential?.fills) return <ValuesRequest sessionId={sessionId} request={request} site={request.credential.site} use={request.credential.use} fills={request.credential.fills} />
  if (request.reason === "credential" && request.credential?.secret) return <SecretRequest sessionId={sessionId} request={request} site={request.credential.site} secret={request.credential.secret} />
  if (request.reason === "credential" && request.credential) return <CredentialRequest sessionId={sessionId} request={request} credential={request.credential} />
  return <SetupRequest sessionId={sessionId} request={request} />
}

function SetupRequest({ sessionId, request }: { sessionId: string; request: ComputerRequest }) {
  const remote = request.placement === "remote"
  const navigate = useNavigate()
  const { pathname } = useLocation()
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
