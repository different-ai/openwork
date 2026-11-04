import { useEffect, useState, type ReactNode } from "react"
import type { DynamicToolUIPart } from "ai"
import { ChevronRight, CodeXml, Globe, Monitor, Pause, PictureInPicture2, Play } from "lucide-react"

import { markFeatureUsed } from "@/app/lib/den"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Image } from "@/components/ui/image"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { formatToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"
import { isBrowserToolName, type ComputerActionMark, type ComputerSessionHistory as History } from "@/lib/computer-session-history"

/**
 * `live` is the chat's working computer: the card shows its work, and its live
 * view opens only from here.
 */
/** Replay speeds, in turn: a capture every 1.5 s at 1×. */
const SPEEDS = [1, 2, 4, 0.5] as const

export function ComputerSessionHistory({ history, active, renderAction, live }: {
  history: History
  active: boolean
  renderAction: (part: DynamicToolUIPart) => ReactNode
  live?: { watching: boolean; onWatch: (watching: boolean) => void }
}) {
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
  const browserOnly = parts.every(part => isBrowserToolName(part.toolName))
  const surface = browserOnly ? "browser" : "computer"
  const surfaceTitle = browserOnly ? "Browser" : "Computer"
  const Icon = browserOnly ? Globe : Monitor
  const title = unfinished ? active ? `Using ${surface}` : `${surfaceTitle} status unavailable` : `Used ${surface}`

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
      aria-label={`${surfaceTitle} session history`}
      className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-background"
      open={open}
      onOpenChange={value => {
        setOpen(value)
        if (!value) setPlaying(false)
        else markFeatureUsed("computerSessionHistory")
      }}
    >
      <div className="flex min-w-0 items-center">
        <CollapsibleTrigger render={<Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none p-3 text-left" />} aria-label={`View ${surface} session history`}>
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className={cn("block text-sm font-medium", unfinished && active && "animate-text-shimmer motion-reduce:animate-none")}>{title}</span>
            <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs font-normal text-muted-foreground">
              <span>{parts.length} {parts.length === 1 ? "action" : "actions"}</span>
              {history.durationMs !== null ? <span>{formatToolCallDuration(history.durationMs)}</span> : null}
            </span>
          </span>
          {latest ? <img src={latest.file.url} alt="" className="h-10 w-16 shrink-0 rounded object-contain" loading="lazy" decoding="async" /> : null}
          <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        </CollapsibleTrigger>
        {live && !browserOnly ? <Button variant="ghost" size="sm" className="mr-2 shrink-0" aria-pressed={live.watching} onClick={() => live.onWatch(!live.watching)}>
          <PictureInPicture2 aria-hidden="true" />{live.watching ? "Hide live view" : "Watch live"}
        </Button> : null}
      </div>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-border p-3">
          <Collapsible>
            {frame ? <>
              {unavailable === frame.file.url ? <p className="py-6 text-sm text-muted-foreground" role="status">This view is unavailable. Choose another captured view.</p> : <div className="relative mx-auto w-fit max-w-full">
                <Image
                  key={frame.id}
                  src={frame.file.url}
                  alt={`Captured view ${index + 1}: ${frame.label}`}
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
                <p className="font-medium text-foreground">{frame.label}</p>
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
                <CollapsibleTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100" />} aria-label={`View ${surface} actions`}><CodeXml aria-hidden="true" /></CollapsibleTrigger>
              </div>
            </> : <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">No captured views in this session.</p>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} aria-label={`View ${surface} actions`}>View actions</CollapsibleTrigger>
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
