import { Button } from "@base-ui/react/button"
import { useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { readBrowserSkillRunPrompt, type BrowserTeachingContext } from "@openwork/types/browser-demonstration"
import { TeachButton, WorkbotTeaching } from "../../../packages/workbot-ui/src/teaching"
import { WorkbotComposer } from "../../../packages/workbot-ui/src/screen"
import { createComposerState, type Pending } from "../../../packages/workbot-ui/src/composer-state"
import { errorMessage, setWorkbotHost } from "../../../packages/workbot-ui/src/host"
import "../src/client/styles.css"

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } })
  return { response, payload: await response.json() }
}
setWorkbotHost({ requestJson, async prepare(path) { return { url: path, headers: new Headers(), credentials: "same-origin" } }, user: { name: "Member" }, useConnectedApps: () => [], appIcons: () => [], homeHref: "/", browserDemonstrations: true })
function Fixture() {
  const [teaching, setTeaching] = useState<BrowserTeachingContext>()
  const [status, setStatus] = useState("")
  const [browser, setBrowser] = useState(true)
  const [teachOpen, setTeachOpen] = useState(false)
  const [sent, setSent] = useState<string[]>([])
  const [composer] = useState(() => createComposerState(async () => { throw new Error("Attachments are outside this browser-teaching proof") }))
  const draft = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot)
  const send = async (entry: Pending, run = false) => {
    const result = await requestJson("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: entry.id, text: entry.text, teachingId: entry.teachingId, teachingStepId: entry.teachingStepId }) })
    if (!result.response.ok) throw new Error(errorMessage(result.payload, "That didn't send. Try again."))
    composer.acknowledge(new Set([entry.id]))
    setSent(current => [...current, readBrowserSkillRunPrompt(entry.text)])
    if (run) {
      const result = await requestJson("/fixture/result")
      setStatus(JSON.stringify(result.payload))
    } else setStatus("Explanation added to the conversation")
  }
  const submit = async (text: string, run = false) => {
    setStatus("");
    const id = composer.enqueue({ id: crypto.randomUUID(), text, ...(!run && teaching ? { teachingId: teaching.id, teachingStepId: teaching.stepId } : {}) })
    await composer.send(id, entry => send(entry, run))
  }
  return <main className="workbot mx-auto flex min-h-screen max-w-5xl flex-col gap-4 bg-[var(--wb-bg)] p-6 text-[var(--wb-text)]">
    <h1 className="text-lg font-medium">Teach a browser lookup</h1>
    <nav className="flex gap-2" aria-label="Workspace"><Button onClick={() => setBrowser(false)}>Home</Button><Button onClick={() => setBrowser(true)}>Browser</Button></nav>
    {/* Laid out as Workbot's Browser view: the toolbar's whiteboard opens the window floating over the page. Tailwind
        doesn't scan fixtures, so their own sizes are inline. */}
    <div hidden={!browser} style={{ display: browser ? undefined : "none", height: 640 }} className="flex flex-col overflow-hidden rounded-xl shadow-[var(--wb-card-shadow)]">
      <div className="flex h-12 shrink-0 items-center justify-end gap-1 border-b border-[var(--wb-hairline)] px-3">
        <TeachButton open={teachOpen} recording={teaching?.phase === "recording"} onClick={() => setTeachOpen(current => !current)} />
      </div>
      <div className="relative min-h-0 flex-1 bg-[#f5f6f7]">
        <div className="absolute bottom-3 right-3 z-10 flex max-h-[calc(100%-24px)] w-[min(22rem,calc(100%-24px))] flex-col">
          <WorkbotTeaching open={teachOpen} onOpenChange={setTeachOpen} onTakeControl={() => setStatus("You have browser control")} onTeachingChange={setTeaching} onRun={text => submit(text, true)} />
        </div>
      </div>
    </div>
    <div className="flex flex-col gap-2 text-[13px]" aria-label="Conversation">
      {sent.slice(-2).map((text, index) => <p key={index} className="whitespace-pre-wrap">{text}</p>)}
      {draft.pending.map(entry => <div key={entry.id}><p>{readBrowserSkillRunPrompt(entry.text)}</p>{entry.failed && <><p role="alert">{entry.failed}</p><Button onClick={() => void composer.send(entry.id, entry => send(entry), true)}>Send again</Button></>}</div>)}
    </div>
    <WorkbotComposer teaching={teaching} text={draft.text} onText={composer.setText} name="Workbot" busy={false} stopping={false} filesEnabled={false} uploads={[]} onFiles={() => {}} onRemoveUpload={() => {}} onRetryUpload={() => {}} onSend={text => { void submit(text) }} onStop={() => {}} autoFocus={false} />
    <output className="whitespace-pre-wrap text-[13px]" role="status">{status}</output>
  </main>
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
