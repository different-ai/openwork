import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { DynamicToolUIPart } from "ai"
import { ChevronRight, CodeXml, ExternalLink, FileText, FolderOpen, Monitor, Paperclip, Pause, PictureInPicture2, Play } from "lucide-react"

import { markFeatureUsed } from "@/app/lib/den"
import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Image } from "@/components/ui/image"
import { toast } from "@/components/ui/sonner"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { formatToolCallDuration } from "@/lib/tool-call-duration"
import { cn, formatFileSize } from "@/lib/utils"
import { computerHandedBackFiles, type ComputerActionMark, type ComputerFolderFile, type ComputerSessionHistory as History } from "@/lib/computer-session-history"
import { encodeComposerMentionValue } from "@/react-app/domains/session/surface/composer/mention-encoding"
import { getComposerDraft, getComposerMentions, useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store"

export type SavedFileActions = {
  open: (path: string) => void
  reveal: (path: string) => void
  attach: (path: string) => void
  /** The files in the chat's output folder, however they were made. */
  list?: () => Promise<ComputerFolderFile[]>
}

/** Puts a saved file in the chat's composer as a file mention, as the composer's own file picker does. */
export function attachFileToComposer(sessionId: string, path: string) {
  const state = useComposerStateStore.getState()
  const draft = getComposerDraft(state, sessionId)
  const mentions = getComposerMentions(state, sessionId)
  const token = `@${encodeComposerMentionValue(path)}`
  if (mentions[path] !== "file" || !draft.includes(token)) {
    state.setDraft(sessionId, `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${token} `)
    state.setMentions(sessionId, { ...mentions, [path]: "file" })
  }
  useComposerStateStore.setState({ pendingFocusSessionId: sessionId })
}

/**
 * Open and Show in Finder go through the desktop, which launches only a file this chat made
 * (a save it confirmed, or a file in its output folder) and otherwise shows it in its folder.
 */
export function desktopSavedFileActions(sessionId: string): SavedFileActions {
  const show = (path: string, reveal: boolean) => void desktopBridge.computerOpenSavedFile({ sessionId, path, ...(reveal ? { reveal } : {}) }).then(result => {
    if (!result.ok) toast.error(result.error || "Could not open this file.")
    else if (result.action === "unavailable") toast.error("This file is no longer on this computer.")
    else if (result.action === "revealed" && !reveal) toast.info("Shown in Finder: only files this chat made open directly.")
  }, () => toast.error("Could not reach this file."))
  return { open: path => show(path, false), reveal: path => show(path, true), attach: path => attachFileToComposer(sessionId, path),
    list: () => desktopBridge.computerChatFiles({ sessionId }).then(result => result.files) }
}

/**
 * `live` is the chat's working computer: the card shows its work, and its live
 * view opens only from here.
 */
/** Replay speeds, in turn: a capture every 1.5 s at 1×. */
const SPEEDS = [1, 2, 4, 0.5] as const

export function ComputerSessionHistory({ history, active, renderAction, live, fileActions, turnEndedAt = null }: {
  history: History
  active: boolean
  renderAction: (part: DynamicToolUIPart) => ReactNode
  live?: { watching: boolean; onWatch: (watching: boolean) => void }
  /** On the desktop: what the person can do with a file the session saved. */
  fileActions?: SavedFileActions
  /** When this session's turn ended; null while it runs. Output-folder files after it belong to a later turn. */
  turnEndedAt?: number | null
}) {
  // The output folder is read again as the session works and when its turn ends.
  const [folder, setFolder] = useState<ComputerFolderFile[]>([])
  const list = fileActions?.list
  const steps = history.parts.length
  useEffect(() => {
    let current = true
    void list?.().then(files => { if (current) setFolder(files) }, () => {})
    return () => { current = false }
  }, [list, steps, active, turnEndedAt])
  const handedBack = useMemo(() => computerHandedBackFiles(history, folder, turnEndedAt), [history, folder, turnEndedAt])
  const [open, setOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  // Null follows the newest capture. Browsing pins a stable frame as work continues.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  // The shown view's pixel size: action marks are in the image pixels the agent acted on.
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null)
  const { frames, parts } = history
  const selectedIndex = selectedId === null ? frames.length - 1 : frames.findIndex(frame => frame.id === selectedId)
  const index = selectedIndex < 0 ? frames.length - 1 : selectedIndex
  const frame = frames[index]
  const latest = frames.at(-1)
  const currentFrameId = frame?.id
  const nextFrameId = frames[index + 1]?.id
  const unfinished = parts.some(isToolPartInFlight)
  const title = unfinished ? active ? "Using computer" : "Computer status unavailable" : "Used computer"
  // With several apps in one session, each step says which one it ran in.
  const several = history.apps.length > 1

  useEffect(() => {
    if (!open || !playing) return
    const timer = setTimeout(() => {
      if (nextFrameId) setSelectedId(nextFrameId)
      else setPlaying(false)
    }, 1500 / speed)
    return () => clearTimeout(timer)
  }, [currentFrameId, nextFrameId, open, playing, speed])

  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false) }
    document.addEventListener("visibilitychange", pause)
    return () => document.removeEventListener("visibilitychange", pause)
  }, [])

  const select = (next: number) => {
    const target = frames[next]
    if (!target) return
    setPlaying(false)
    setSelectedId(next === frames.length - 1 ? null : target.id)
  }

  return (
    <Collapsible
      data-computer-session-history=""
      role="group"
      aria-label="Computer session history"
      className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-background"
      open={open}
      onOpenChange={value => {
        setOpen(value)
        if (!value) setPlaying(false)
        else markFeatureUsed("computerSessionHistory")
      }}
    >
      <div className="flex min-w-0 items-center">
        <CollapsibleTrigger render={<Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none p-3 text-left" />} aria-label="View computer session history">
          <Monitor aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className={cn("block text-sm font-medium", unfinished && active && "animate-text-shimmer motion-reduce:animate-none")}>{title}</span>
            {/* While it works, what it is doing now; afterwards, what it was for. */}
            {(unfinished && active ? history.latest : history.purpose ?? history.latest)
              ? <span data-computer-session-description="" className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">{unfinished && active ? history.latest : history.purpose ?? history.latest}</span> : null}
            <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs font-normal text-muted-foreground">
              <span>{parts.length} {parts.length === 1 ? "action" : "actions"}</span>
              {several ? <span data-computer-session-apps="">{history.apps.join(", ")}</span> : null}
              {history.durationMs !== null ? <span>{formatToolCallDuration(history.durationMs)}</span> : null}
            </span>
          </span>
          {latest ? <img src={latest.file.url} alt="" className="h-10 w-16 shrink-0 rounded object-contain" loading="lazy" decoding="async" /> : null}
          <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        </CollapsibleTrigger>
        {live ? <Button variant="ghost" size="sm" className="mr-2 shrink-0" aria-pressed={live.watching} onClick={() => live.onWatch(!live.watching)}>
          <PictureInPicture2 aria-hidden="true" />{live.watching ? "Hide live view" : "Watch live"}
        </Button> : null}
      </div>
      {/* What the session made for the person, without opening the card. */}
      {handedBack.length > 0 ? <ul data-computer-saved-files="" aria-label="Saved files" className="space-y-1 border-t border-border px-3 py-2">
        {handedBack.map(file => <li key={file.path} data-computer-saved-file="" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm" title={file.path}>{file.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatFileSize(file.bytes)}</span>
          {fileActions ? <span className="flex shrink-0 items-center">
            <Button variant="ghost" size="xs" aria-label={`Open ${file.name}`} onClick={() => fileActions.open(file.path)}><ExternalLink aria-hidden="true" />Open</Button>
            <Button variant="ghost" size="xs" aria-label={`Show ${file.name} in Finder`} onClick={() => fileActions.reveal(file.path)}><FolderOpen aria-hidden="true" />Show in Finder</Button>
            <Button variant="ghost" size="xs" aria-label={`Attach ${file.name} to chat`} onClick={() => fileActions.attach(file.path)}><Paperclip aria-hidden="true" />Attach to chat</Button>
          </span> : null}
        </li>)}
      </ul> : null}
      <CollapsibleContent>
        <div className="space-y-3 border-t border-border p-3">
          <Collapsible>
            {frame ? <>
              {unavailable === frame.file.url ? <p className="py-6 text-sm text-muted-foreground" role="status">This view is unavailable. Choose another captured view.</p> : <div className="relative mx-auto w-fit max-w-full">
                <Image
                  key={frame.id}
                  src={frame.file.url}
                  alt={`Captured view ${index + 1}: ${several && frame.app ? `${frame.app}, ` : ""}${frame.label}`}
                  previewMaxHeight={0}
                  previewMaxWidth={0}
                  className="block h-auto max-h-80 w-auto max-w-full rounded-md bg-muted/30"
                  onLoad={event => setSize({ url: frame.file.url, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                  onError={() => { setUnavailable(frame.file.url); setPlaying(false) }}
                />
                {size?.url === frame.file.url && size.width > 0 && size.height > 0 && frame.marks.length > 0
                  ? <ActionMarks marks={frame.marks} width={size.width} height={size.height} /> : null}
              </div>}
              <div data-computer-view-step="" className="pt-2 text-xs">
                <p className="font-medium text-foreground">{several && frame.app ? <span data-computer-view-app="" className="text-muted-foreground">{frame.app} · </span> : null}{frame.label}</p>
                {frame.thinking ? <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-muted-foreground">{frame.thinking}</p> : null}
              </div>
              <div className="group flex min-w-0 items-center gap-3 pt-2">
                <Button variant="ghost" size="icon-sm" aria-label={playing ? "Pause captured views" : "Play captured views"} disabled={frames.length < 2} onClick={() => {
                  if (playing) setPlaying(false)
                  else { if (index === frames.length - 1) setSelectedId(frames[0]!.id); setPlaying(true) }
                }}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
                {/* Native range: the shared UI has no slider primitive. Its end follows new captures. */}
                <input type="range" min={0} max={frames.length - 1} step={1} value={index} disabled={frames.length < 2} aria-label="Browse captured views" aria-valuetext={`${index + 1} of ${frames.length}: ${frame.label}`} className="min-w-0 flex-1 accent-foreground" onInput={event => select(Number(event.currentTarget.value))} />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-computer-view-count="">{index + 1} / {frames.length}</span>
                <Button variant="ghost" size="xs" className="shrink-0 tabular-nums text-muted-foreground" aria-label={`Playback speed ${speed}×`} disabled={frames.length < 2}
                  onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}>{speed}×</Button>
                <CollapsibleTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100" />} aria-label="View computer actions"><CodeXml aria-hidden="true" /></CollapsibleTrigger>
              </div>
            </> : <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">No captured views in this session.</p>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} aria-label="View computer actions">View actions</CollapsibleTrigger>
            </div>}
            <CollapsibleContent><div className="space-y-2 pt-3">{parts.map(part => <div key={part.toolCallId}>{renderAction(part)}</div>)}</div></CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Where the view's clicks landed and the paths its drags took, drawn over the capture. */
function ActionMarks({ marks, width, height }: { marks: ComputerActionMark[]; width: number; height: number }) {
  const radius = Math.max(width, height) * 0.012
  return (
    <svg data-computer-action-marks="" aria-hidden="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full text-primary">
      {marks.map((mark, index) => mark.kind === "point"
        ? <g key={index}>
          <circle cx={mark.x} cy={mark.y} r={radius * 1.8} className="fill-current opacity-20" />
          <circle cx={mark.x} cy={mark.y} r={radius * 0.6} className="fill-current" />
        </g>
        : <g key={index}>
          <polyline points={mark.points.map(point => `${point.x},${point.y}`).join(" ")} className="fill-none stroke-current" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <circle cx={mark.points[0]!.x} cy={mark.points[0]!.y} r={radius * 0.6} className="fill-current" />
        </g>)}
    </svg>
  )
}
