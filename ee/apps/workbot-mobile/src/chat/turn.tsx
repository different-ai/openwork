import {
  duration,
  HELLO_FAILED,
  isOpenTask,
  joinNames,
  replyProgress,
  retryTaskMessage,
  taskDetail,
  UPDATE_HOLD_MS,
  usedApps,
  type LiveText,
  type UsedApp,
  type WorkbotAttachment,
  type WorkbotStep,
  type WorkbotTask,
  type WorkbotTurn,
} from "@openwork-ee/workbot-client"
import { useStopWorkbotTask } from "@openwork-ee/workbot-client/hooks"
import * as Clipboard from "expo-clipboard"
import { Check, Copy, Pencil } from "lucide-react-native"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { FileCard, SentAttachments } from "../files/ui"
import { AppMark } from "../ui/app-mark"
import { ErrorLine, IconButton, QuietButton, QuietLine } from "../ui/controls"
import { WorkbotMarkdown } from "../ui/markdown"
import { Pulse, useLessMotion, useNow, WorkerGlyph } from "../ui/motion"
import { color, shadow } from "../theme"

/** Workbot's reaction to a message: one emoji pinned to the message's corner, like a messaging app's tapback. */
function Reaction({ emoji }: { emoji: string }) {
  return (
    <View accessibilityLabel={`Reacted ${emoji}`} style={styles.reaction}>
      <Text style={styles.reactionText}>{emoji}</Text>
    </View>
  )
}

export function UserBubble({ text, muted = false, reaction = null, action }: { text: string; muted?: boolean; reaction?: string | null; action?: ReactNode }) {
  if (!text) return reaction ? <View style={styles.end}><Reaction emoji={reaction} /></View> : null
  return (
    <View style={styles.userColumn}>
      <View style={styles.userWrap}>
        <Text selectable style={[styles.userBubble, muted ? styles.dim : null]}>{text}</Text>
        {reaction ? <View style={styles.reactionPin}><Reaction emoji={reaction} /></View> : null}
      </View>
      {action ? <View style={styles.ownAction}>{action}</View> : null}
    </View>
  )
}

/** Edit rests under the person's own message; dimmed while it can't be used, so nothing shifts when it can. */
function EditButton({ disabled, onPress }: { disabled: boolean; onPress?: () => void }) {
  return (
    <IconButton label="Edit message" disabled={disabled} onPress={onPress} style={styles.smallIcon}>
      <Pencil size={14} strokeWidth={1.75} color={color.muted} />
    </IconButton>
  )
}

function OwnMessage({ turn, canChange, onEdit, error }: { turn: WorkbotTurn; canChange: boolean; onEdit: (turn: WorkbotTurn, text: string) => void; error: string | null }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.text)
  const save = () => {
    const text = draft.trim()
    if (!text) return
    setEditing(false)
    if (text === turn.text.trim()) return
    onEdit(turn, text)
  }
  if (editing) {
    return (
      <View style={styles.editWrap}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          accessibilityLabel="Edit your message"
          style={styles.editField}
        />
        <View style={styles.editActions}>
          <QuietButton label="Cancel" tone="muted" onPress={() => { setDraft(turn.text); setEditing(false) }} />
          <Pressable accessibilityRole="button" disabled={!draft.trim()} onPress={save} style={[styles.sendSmall, !draft.trim() ? styles.disabled : null]}>
            <Text style={styles.sendSmallText}>Send</Text>
          </Pressable>
        </View>
      </View>
    )
  }
  return (
    <View style={styles.ownColumn}>
      <UserBubble text={turn.text} reaction={turn.reaction} action={<EditButton disabled={!canChange} onPress={() => { setDraft(turn.text); setEditing(true) }} />} />
      {error ? <ErrorLine align="end">{error}</ErrorLine> : null}
    </View>
  )
}

/** Copies one of Workbot's answers, with a moment of "Copied" to say it worked. */
function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <View style={styles.copyRow}>
      <IconButton label={copied ? "Copied" : "Copy answer"} onPress={() => void Clipboard.setStringAsync(text).then(() => setCopied(true))} style={styles.smallIcon}>
        {copied ? <Check size={14} strokeWidth={2} color={color.muted} /> : <Copy size={14} strokeWidth={1.75} color={color.muted} />}
      </IconButton>
    </View>
  )
}

/** Workbot's words in a bubble on the left: white with a hairline, so the two sides of the conversation read apart. */
function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantBubble}>{children}</View>
    </View>
  )
}

/**
 * Streamed text arrives in bursts; this reveals it at a steady pace that speeds up when it falls behind, so the reply
 * reads as written rather than jumping a sentence at a time (the web page's pace).
 */
function useSmoothText(target: string) {
  const less = useLessMotion()
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const previous = useRef("")
  useEffect(() => {
    const goal = target.length
    if (!target.startsWith(previous.current.slice(0, shownRef.current))) shownRef.current = 0
    previous.current = target
    if (less) {
      shownRef.current = goal
      setShown(goal)
      return
    }
    let frame = 0
    const tick = () => {
      const current = shownRef.current
      if (current >= goal) return
      shownRef.current = Math.min(goal, current + Math.max(2, Math.ceil((goal - current) / 45)))
      setShown(shownRef.current)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, less])
  return target.slice(0, Math.min(shown, target.length))
}

function StreamingText({ text }: { text: string }) {
  return <WorkbotMarkdown text={useSmoothText(text)} />
}

/** The value, but each one stays at least `minMs` before the next replaces it, so quick changes read as one. */
function useHeld<T>(value: T, key: string, minMs: number): T {
  const [shown, setShown] = useState({ key, value })
  const shownAt = useRef(Date.now())
  useEffect(() => {
    if (key === shown.key) return
    const timer = setTimeout(() => {
      shownAt.current = Date.now()
      setShown({ key, value })
    }, Math.max(0, minMs - (Date.now() - shownAt.current)))
    return () => clearTimeout(timer)
    // `value` travels with `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, minMs, shown.key])
  return shown.value
}

function AppLogos({ apps, denUrl }: { apps: UsedApp[]; denUrl: string | null }) {
  if (apps.length === 0) return null
  return (
    <View accessibilityLabel={`Also using ${joinNames(apps.map((app) => app.name))}`} style={styles.logos}>
      {apps.map((app) => <AppMark key={app.key} name={app.name} size={14} denUrl={denUrl} />)}
    </View>
  )
}

/**
 * Work on Workbot's computer, as one card: the little person at work, what the work is, what it is doing now (or what
 * it last did) and how long. Tapping a finished card shows everything it did, in its own words.
 */
function WorkCard(props: { title: string; detail: string; running: boolean; outcome: "done" | "failed" | "stopped" | null; startedAt: number | null; finishedAt: number | null; updates: string[]; action?: ReactNode }) {
  const now = useNow()
  const [open, setOpen] = useState(false)
  const end = props.startedAt ? (props.finishedAt ?? (props.running ? now : null)) : null
  const expandable = !props.running && props.updates.length > 1
  const body = (
    <View style={styles.workRow}>
      <View style={styles.worker}>
        <WorkerGlyph working={props.running} />
        {props.outcome === "done" ? (
          <View style={styles.workerDone}>
            <Check size={9} strokeWidth={3} color={color.surface} />
          </View>
        ) : null}
      </View>
      <View style={styles.workText}>
        <Text numberOfLines={1} style={styles.workTitle}>{props.title}</Text>
        <Pulse active={props.running}>
          <Text numberOfLines={1} style={[styles.workDetail, props.outcome === "failed" ? styles.failed : null]}>
            {props.detail}
            {props.startedAt && end && end - props.startedAt >= 1_000 ? ` · ${duration(end - props.startedAt)}` : ""}
          </Text>
        </Pulse>
      </View>
      {props.action}
    </View>
  )
  return (
    <View style={styles.workCard}>
      {expandable ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}>
          {body}
        </Pressable>
      ) : (
        <View accessibilityLiveRegion="polite">{body}</View>
      )}
      {open ? (
        <View style={styles.updates}>
          {props.updates.map((update, index) => <Text key={`${index}:${update}`} style={styles.update}>{update}</Text>)}
        </View>
      ) : null}
    </View>
  )
}

/**
 * Work done between two things Workbot said: its computer as a card, or one quiet line for apps alone ("Using Gmail",
 * then "Used Gmail"). `live` while nothing has been said after it yet.
 */
function StepsSegment({ steps, live, denUrl }: { steps: WorkbotStep[]; live: boolean; denUrl: string | null }) {
  const used = usedApps(steps, null)
  const computer = steps.filter((step) => step.icon === "computer")
  const updates = computer.flatMap((step) => step.updates)
  const latest = updates.at(-1) ?? null
  const update = useHeld(latest, latest ?? "", UPDATE_HOLD_MS)
  if (used.length === 0) return null
  const others = used.filter((app) => !app.computer)
  if (computer.length > 0) {
    return (
      <View style={styles.segment}>
        <WorkCard
          title={live ? "Using my computer" : "Used my computer"}
          detail={(live ? update : latest) ?? (live ? "Getting started" : "Done")}
          running={live}
          outcome={live ? null : "done"}
          startedAt={computer.find((step) => step.startedAt)?.startedAt ?? null}
          finishedAt={live ? null : ([...computer].reverse().find((step) => step.finishedAt)?.finishedAt ?? null)}
          updates={live ? [] : updates}
          action={<AppLogos apps={others} denUrl={denUrl} />}
        />
      </View>
    )
  }
  return (
    <Pulse active={live}>
      <View accessibilityLiveRegion={live ? "polite" : "none"} style={styles.usedLine}>
        <View style={styles.logos}>{others.map((app) => <AppMark key={app.key} name={app.name} size={14} denUrl={denUrl} />)}</View>
        <Text numberOfLines={1} style={[styles.usedText, live ? styles.usedLive : null]}>{`${live ? "Using" : "Used"} ${joinNames(others.map((app) => app.name))}`}</Text>
      </View>
    </Pulse>
  )
}

function TaskCard({ task, canRetry, onRetry }: { task: WorkbotTask; canRetry: boolean; onRetry: () => void }) {
  const stop = useStopWorkbotTask()
  const running = isOpenTask(task)
  const outcome = running ? null : task.status === "done" ? "done" : task.status === "failed" ? "failed" : "stopped"
  const stopping = stop.isPending && stop.variables === task.id
  return (
    <WorkCard
      title={task.title}
      detail={taskDetail(task)}
      running={running}
      outcome={outcome}
      startedAt={task.status === "queued" ? null : task.startedAt}
      finishedAt={task.finishedAt}
      updates={task.updates}
      action={
        running ? (
          <QuietButton label={stopping ? "Stopping" : "Stop"} tone="muted" disabled={stopping} onPress={() => stop.mutate(task.id)} />
        ) : task.status === "failed" ? (
          <QuietButton label="Try again" disabled={!canRetry} onPress={onRetry} />
        ) : null
      }
    />
  )
}

export type TurnViewProps = {
  turn: WorkbotTurn
  live: LiveText | null
  /** The newest turn, with nothing of the person's waiting after it: suggestions and "Try again" show only here. */
  latest: boolean
  canChange: boolean
  editError: string | null
  denUrl: string | null
  localUris: Record<string, string | null>
  onEdit: (turn: WorkbotTurn, text: string) => void
  onRetry: () => void
  onSuggestion: (text: string) => void
  onOpenFile: (file: WorkbotAttachment) => void
}

export function TurnView(props: TurnViewProps) {
  const { turn } = props
  const { working, liveText, startingCard, lastIsLive } = replyProgress(turn, props.live)
  // An answer watched while it was written keeps revealing at the same pace once it's stored.
  const watched = useRef(working)
  if (working) watched.current = true
  const parts = turn.parts
  const last = parts.at(-1)
  const lastText = parts.reduce((found, part, index) => (part.kind === "text" ? index : found), -1)
  const tailIsStored = !working && watched.current && lastText !== -1 && lastText === parts.length - 1
  const storedTail = tailIsStored && last?.kind === "text" ? last.text : null
  const tail: string | null = working ? liveText || null : storedTail
  return (
    <View style={styles.turn}>
      <SentAttachments attachments={turn.attachments} localUris={props.localUris} onOpen={props.onOpenFile} />
      {turn.text && !turn.greeting ? (
        <OwnMessage turn={turn} canChange={props.canChange && turn.status !== "queued"} onEdit={props.onEdit} error={props.editError} />
      ) : (
        <UserBubble text={turn.text} reaction={turn.reaction} />
      )}
      {parts.length > 0 || liveText || startingCard || turn.status === "queued" ? <View style={styles.gap} /> : null}
      {parts.map((part, index) => {
        if (part.kind === "text") {
          if (tailIsStored && index === lastText) return null
          return (
            <AssistantBubble key={index}>
              <WorkbotMarkdown text={part.text} />
            </AssistantBubble>
          )
        }
        // Its hello looks things up out of sight; once it's done, one quiet line says what it read.
        if (turn.greeting && working) return null
        return <StepsSegment key={index} steps={part.steps} live={working && index === parts.length - 1 && lastIsLive} denUrl={props.denUrl} />
      })}
      {tail ? (
        <AssistantBubble>
          <StreamingText text={tail} />
        </AssistantBubble>
      ) : null}
      {startingCard ? <StepsSegment steps={[{ label: "Using my computer", icon: "computer", status: "running", app: null, startedAt: null, finishedAt: null, updates: [] }]} live denUrl={props.denUrl} /> : null}
      {turn.status === "queued" ? <QuietLine label="Up next" /> : null}
      {turn.status === "done" && lastText !== -1 ? <CopyAnswer text={parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n")} /> : null}
      {turn.outputs.length ? (
        <View style={styles.outputs}>
          {turn.outputs.map((file) => <FileCard key={file.id} file={file} onPress={() => props.onOpenFile(file)} />)}
        </View>
      ) : null}
      {turn.tasks.length ? (
        <View style={styles.tasks}>
          {turn.tasks.map((task) => <TaskCard key={task.id} task={task} canRetry={props.canChange} onRetry={() => props.onSuggestion(retryTaskMessage(task))} />)}
        </View>
      ) : null}
      {turn.suggestions.length && props.latest ? (
        <View style={styles.suggestions}>
          {turn.suggestions.map((text) => (
            <Pressable key={text} accessibilityRole="button" onPress={() => props.onSuggestion(text)} style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}>
              <Text style={styles.chipText}>{text}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {turn.status === "failed" ? (
        <ErrorLine action={props.latest && (turn.greeting || turn.retryable) ? { label: "Try again", onPress: props.onRetry } : null}>{turn.greeting ? HELLO_FAILED : turn.error}</ErrorLine>
      ) : null}
      {turn.status === "stopped" ? <Text style={styles.stopped}>Stopped</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  turn: { gap: 4 },
  gap: { height: 14 },
  end: { flexDirection: "row", justifyContent: "flex-end" },
  userColumn: { alignItems: "flex-end" },
  userWrap: { maxWidth: "85%" },
  userBubble: { borderRadius: 20, backgroundColor: color.userBubble, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, lineHeight: 22, color: color.text, overflow: "hidden" },
  dim: { opacity: 0.6 },
  reactionPin: { position: "absolute", left: -12, top: -14 },
  reaction: { height: 28, minWidth: 28, paddingHorizontal: 4, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: color.surface, boxShadow: shadow.card },
  reactionText: { fontSize: 15 },
  ownAction: { marginTop: 2 },
  ownColumn: { alignItems: "flex-end", gap: 4 },
  smallIcon: { width: 32, height: 32 },
  editWrap: { alignSelf: "flex-end", width: "85%", gap: 8 },
  editField: { maxHeight: 240, borderRadius: 20, backgroundColor: color.surface, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, fontSize: 15, lineHeight: 22, color: color.text, boxShadow: shadow.composer },
  editActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 6 },
  sendSmall: { height: 32, paddingHorizontal: 14, borderRadius: 999, backgroundColor: color.ink, justifyContent: "center" },
  sendSmallText: { color: color.onInk, fontSize: 13, fontWeight: "500" },
  disabled: { opacity: 0.4 },
  copyRow: { flexDirection: "row", height: 32, alignItems: "center", paddingLeft: 2 },
  assistantRow: { flexDirection: "row", paddingVertical: 3 },
  assistantBubble: { maxWidth: "100%", flexShrink: 1, borderRadius: 20, borderBottomLeftRadius: 6, backgroundColor: color.surface, paddingHorizontal: 16, paddingVertical: 10, boxShadow: shadow.card },
  segment: { paddingVertical: 4, paddingLeft: 4 },
  workCard: { maxWidth: 480, borderRadius: 14, backgroundColor: color.surface, boxShadow: shadow.card },
  workRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingLeft: 10, paddingRight: 8 },
  worker: { width: 36, height: 36, borderRadius: 10, backgroundColor: color.chip, alignItems: "center", justifyContent: "center" },
  workerDone: { position: "absolute", right: -4, bottom: -4, width: 16, height: 16, borderRadius: 8, backgroundColor: color.ink, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: color.surface },
  workText: { flex: 1, minWidth: 0 },
  workTitle: { fontSize: 13.5, fontWeight: "500", lineHeight: 20, color: color.text },
  workDetail: { fontSize: 12, lineHeight: 16, color: color.muted, fontVariant: ["tabular-nums"] },
  failed: { color: color.danger },
  updates: { gap: 6, paddingBottom: 12, paddingLeft: 58, paddingRight: 16 },
  update: { fontSize: 12.5, lineHeight: 18, color: color.muted },
  logos: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 4 },
  usedLine: { flexDirection: "row", alignItems: "center", gap: 8, height: 28, paddingLeft: 4 },
  usedText: { fontSize: 12.5, lineHeight: 16, color: color.faint, flexShrink: 1 },
  usedLive: { color: color.muted, fontSize: 13 },
  outputs: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 4, paddingTop: 12 },
  tasks: { gap: 8, paddingLeft: 4, paddingTop: 12 },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 4, paddingTop: 12 },
  chip: { height: 34, paddingHorizontal: 14, borderRadius: 999, backgroundColor: color.surface, justifyContent: "center", boxShadow: shadow.ring },
  chipPressed: { backgroundColor: color.chip },
  chipText: { fontSize: 13, color: color.text },
  stopped: { paddingLeft: 4, paddingTop: 6, fontSize: 13, color: color.muted },
})
