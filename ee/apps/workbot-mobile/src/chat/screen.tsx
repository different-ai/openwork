import {
  awaitingReply,
  firstNameOf,
  HELLO_FAILED,
  MAX_TURNS,
  needsWelcome,
  newMessageId,
  PAGE_TURNS,
  showsTimestamp,
  TYPING_SETTLE_MS,
  type WorkbotAttachment,
  type WorkbotMe,
  type WorkbotTurn,
} from "@openwork-ee/workbot-client"
import {
  useEditWorkbotMessage,
  useRemoveWorkbotChat,
  useRetryWorkbotMessage,
  useSendWorkbotMessage,
  useStartWorkbot,
  useStopWorkbot,
  useWorkbotChats,
  useWorkbotLive,
  useWorkbotThread,
  workbotFilesKey,
} from "@openwork-ee/workbot-client/hooks"
import { LegendList, type LegendListRef } from "@legendapp/list/react-native"
import { useQueryClient } from "@tanstack/react-query"
import { router } from "expo-router"
import { Lock } from "lucide-react-native"
import { useEffect, useMemo, useRef, useState } from "react"
import { Alert, AppState, StyleSheet, Text, View } from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { randomBytes } from "../auth/pkce"
import { prefs } from "../prefs"
import { SentAttachments } from "../files/ui"
import { useUploads, type Upload } from "../files/uploads"
import { ErrorLine, QuietButton, QuietLine } from "../ui/controls"
import { TypingBubble, useSettled } from "../ui/motion"
import { color, COLUMN } from "../theme"
import { Composer } from "./composer"
import { WorkbotHeader } from "./header"
import { FirstOpen, Intro, SideChatStart, Timestamp } from "./intro"
import { TurnView, UserBubble } from "./turn"
import { Welcome } from "./welcome"

type Pending = {
  id: string
  text: string
  sentAt: number
  /** Files still uploading, shown from the tray until the turn exists. */
  uploads: Upload[]
  failed: string | null
}

type Row = { key: string; at: number; stamp: boolean; turn: WorkbotTurn | null; pending: Pending | null }

const WELCOMED_KEY = "welcomed"
const welcomedAt = () => prefs.get(WELCOMED_KEY)

/** Whether the app is on screen: the live stream runs only then. */
function useForeground() {
  const [active, setActive] = useState(AppState.currentState === "active")
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"))
    return () => subscription.remove()
  }, [])
  return active
}

export function openFile(file: WorkbotAttachment, chat: string | null) {
  router.push({
    pathname: "/preview",
    params: { id: file.id, name: file.name, mediaType: file.mediaType, size: String(file.size), version: String(file.updatedAt ?? 0), ...(chat ? { chat } : {}) },
  })
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>
}

/** One chat: the person's main chat, or one of their side chats. */
export function ChatScreen({ me, chat }: { me: WorkbotMe; chat: string | null }) {
  const side = chat !== null
  const insets = useSafeAreaInsets()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Pending[]>([])
  const [turnWindow, setTurnWindow] = useState(PAGE_TURNS)
  // The welcome shows once, while there's no conversation yet; leaving it, Workbot starts the conversation itself.
  const [welcome, setWelcome] = useState<"pending" | "showing" | "done">(side ? "done" : "pending")
  const [greetingAwaited, setGreetingAwaited] = useState(false)
  const foreground = useForeground()
  const start = useStartWorkbot()
  const stream = useWorkbotLive(foreground)
  const thread = useWorkbotThread({ turns: turnWindow, awaiting: greetingAwaited || pending.some((entry) => !entry.failed), live: stream.connected })
  const send = useSendWorkbotMessage()
  const retry = useRetryWorkbotMessage()
  const stop = useStopWorkbot()
  const editMessage = useEditWorkbotMessage()
  const chats = useWorkbotChats(side && me.sideChats)
  const removeChat = useRemoveWorkbotChat()
  // Messages replaced by an edit leave the screen at once; the conversation catches up on its next read.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [editErrors, setEditErrors] = useState<Readonly<Record<string, string>>>({})
  const uploads = useUploads()
  const list = useRef<LegendListRef>(null)
  const data = thread.data?.available ? thread.data : null
  const firstName = firstNameOf(me.name)

  useEffect(() => {
    if (greetingAwaited && (start.isError || start.data?.started === false || (data?.turns.length ?? 0) > 0)) setGreetingAwaited(false)
  }, [data, greetingAwaited, start.isError, start.data])
  useEffect(() => {
    if (welcome === "pending" && data) setWelcome(needsWelcome(data.turns, welcomedAt()) && pending.length === 0 ? "showing" : "done")
  }, [data, welcome, pending.length])
  // Once they're past the welcome, remember it for this conversation's hello, so reopening doesn't show it again.
  useEffect(() => {
    const hello = data?.turns[0]
    if (welcome === "done" && hello?.greeting && hello.sentAt) {
      prefs.set(WELCOMED_KEY, String(hello.sentAt))
    }
  }, [data, welcome])
  // Once the conversation no longer has a hidden message, it needn't be hidden any more.
  useEffect(() => {
    if (!data || hidden.size === 0) return
    const present = new Set(data.turns.map((turn) => turn.id))
    if ([...hidden].some((id) => !present.has(id))) setHidden((current) => new Set([...current].filter((id) => present.has(id))))
  }, [data, hidden])
  // A sent message stays on screen as written until the conversation shows it.
  useEffect(() => {
    if (!data) return
    const known = new Set(data.turns.map((turn) => turn.id))
    setPending((current) => (current.some((entry) => known.has(entry.id)) ? current.filter((entry) => !known.has(entry.id)) : current))
  }, [data])
  // Sending always brings the conversation back to the newest message.
  const pendingCount = pending.length
  useEffect(() => {
    if (pendingCount > 0) void list.current?.scrollToEnd({ animated: true })
  }, [pendingCount])

  const submit = (text: string, again?: Pending) => {
    const trimmed = text.trim()
    const id = again?.id ?? newMessageId(randomBytes)
    const fromTray = again ? { taken: again.uploads, settled: Promise.resolve(again.uploads.flatMap((upload) => (upload.saved ? [upload.saved] : []))) } : uploads.take()
    if (!trimmed && fromTray.taken.length === 0) return
    setPending((current) => [...current.filter((entry) => entry.id !== id), { id, text: trimmed, sentAt: Date.now(), uploads: fromTray.taken, failed: null }])
    const fail = (message: string) => setPending((current) => current.map((entry) => (entry.id === id ? { ...entry, failed: message } : entry)))
    // The message waits for its files, then goes out with their ids.
    void fromTray.settled.then((saved) => {
      if (fromTray.taken.length > 0 && saved.length < fromTray.taken.length) {
        fail("A file didn't upload.")
        return
      }
      send.mutate({ id, text: trimmed, attachments: saved.map((file) => file.id) }, {
        onError: (error) => fail(error.message),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: workbotFilesKey }),
      })
    })
  }

  /** Sends an edited message in place of the old one: it and everything after it make way for the new answer. */
  const editTurn = (turn: WorkbotTurn, text: string) => {
    const trimmed = text.trim()
    if (!trimmed && turn.attachments.length === 0) return
    const turns = data?.turns ?? []
    const from = turns.findIndex((entry) => entry.id === turn.id)
    const replaced = from === -1 ? [turn.id] : turns.slice(from).map((entry) => entry.id)
    const id = newMessageId(randomBytes)
    setEditErrors((current) => {
      if (!(turn.id in current)) return current
      const next = { ...current }
      delete next[turn.id]
      return next
    })
    setHidden((current) => new Set([...current, ...replaced]))
    setPending((current) => [...current, { id, text: trimmed, sentAt: Date.now(), uploads: [], failed: null }])
    editMessage.mutate(
      { id: turn.id, newId: id, text: trimmed, attachments: turn.attachments.map((file) => file.id) },
      {
        onError: (error) => {
          setHidden((current) => new Set([...current].filter((entry) => !replaced.includes(entry))))
          setPending((current) => current.filter((entry) => entry.id !== id))
          setEditErrors((current) => ({ ...current, [turn.id]: error.message }))
        },
      },
    )
  }

  const sideTitle = side ? chats.data?.side.find((entry) => entry.id === chat)?.title : undefined
  const confirmRemove = () => {
    if (!chat) return
    Alert.alert(`Remove “${sideTitle?.trim() || "New side chat"}”?`, "Its messages and files go with it. This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeChat.mutate(chat, {
          onSuccess: () => (router.canGoBack() ? router.back() : router.replace("/")),
          onError: (error) => Alert.alert("Couldn't remove it", error.message),
        }),
      },
    ])
  }

  const header = (
    <WorkbotHeader
      name={data?.name ?? "Workbot"}
      organizationName={data?.organizationName ?? me.organizationName}
      userName={me.name}
      side={chat ? { id: chat, title: sideTitle } : null}
      sideChats={me.sideChats}
      calendar={me.calendar && !side}
      tab="home"
      filesEnabled={data?.filesEnabled ?? false}
      onRemove={chat && (data?.turns.length ?? 0) > 0 ? confirmRemove : undefined}
    />
  )

  if (thread.isPending) {
    return (
      <View style={styles.page}>
        {header}
        <View accessibilityLabel="Loading your conversation" style={styles.skeleton}>
          <View style={[styles.skeletonBlock, styles.skeletonMine]} />
          <View style={[styles.skeletonBlock, styles.skeletonLine]} />
          <View style={[styles.skeletonBlock, styles.skeletonAnswer]} />
        </View>
      </View>
    )
  }
  if (thread.isError && !thread.data) {
    return (
      <View style={styles.page}>
        {header}
        <Centered>
          <Text style={styles.centeredText}>Couldn't load your conversation.</Text>
          <QuietButton label="Try again" onPress={() => void thread.refetch()} />
        </Centered>
      </View>
    )
  }
  if (!data) {
    const notEnabled = thread.data?.available === false && thread.data.reason === "workbot_not_enabled"
    return (
      <View style={styles.page}>
        {header}
        <Centered>
          <Lock size={16} strokeWidth={1.5} color={color.muted} />
          <Text style={[styles.centeredText, styles.gapTop]}>{notEnabled ? "Workbot isn't on for your organization yet." : "Workbot is unavailable right now."}</Text>
          <Text style={styles.centeredMuted}>{notEnabled ? "An admin can turn it on." : "Try again in a few minutes."}</Text>
        </Centered>
      </View>
    )
  }

  const busy = data.status === "busy" || pending.some((entry) => !entry.failed)
  const empty = data.turns.length === 0 && pending.length === 0
  if (welcome === "showing" || (welcome === "pending" && pending.length === 0 && needsWelcome(data.turns, welcomedAt()))) {
    return (
      <View style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Welcome
          name={data.name}
          firstName={firstName}
          denUrl={me.denUrl}
          // Start only after the person finishes or skips connecting their apps.
          onBegin={() => {
            if (start.isIdle) {
              setGreetingAwaited(true)
              start.mutate()
            }
          }}
          onDone={() => setWelcome("done")}
        />
      </View>
    )
  }

  // Right after the welcome: the conversation, with Workbot typing its hello. If that can't start, the drawn greeting.
  const starting = empty && (start.isPending || (greetingAwaited && start.data?.started === true))
  const composer = (
    <Composer
      name={data.name}
      busy={busy}
      stopping={stop.isPending}
      filesEnabled={data.filesEnabled}
      uploads={uploads.uploads}
      onFiles={uploads.add}
      onRemoveUpload={uploads.remove}
      onRetryUpload={uploads.retry}
      onSend={(text) => submit(text)}
      onStop={() => stop.mutate()}
    />
  )

  return (
    <View style={styles.page}>
      {header}
      <KeyboardAvoidingView behavior="padding" style={styles.body} keyboardVerticalOffset={0}>
        {empty && side ? (
          <SideChatStart name={data.name} organizationName={data.organizationName}>{composer}</SideChatStart>
        ) : empty && !starting ? (
          <FirstOpen
            name={data.name}
            organizationName={data.organizationName}
            firstName={firstName}
            apps={[]}
            denUrl={me.denUrl}
            at={Date.now()}
            onSuggestion={(text) => submit(text)}
            error={start.isError ? <ErrorLine action={{ label: "Try again", onPress: () => { setGreetingAwaited(true); start.mutate() } }}>{HELLO_FAILED}</ErrorLine> : null}
          >
            {composer}
          </FirstOpen>
        ) : (
          <>
            <Conversation
              listRef={list}
              me={me}
              chat={chat}
              side={side}
              data={data}
              turns={hidden.size ? data.turns.filter((turn) => !hidden.has(turn.id)) : data.turns}
              pending={pending}
              live={stream.live}
              starting={starting}
              canChange={!busy}
              editErrors={editErrors}
              loadingEarlier={thread.isFetching && turnWindow > data.turns.length}
              onLoadEarlier={() => setTurnWindow((current) => Math.min(MAX_TURNS, current + PAGE_TURNS))}
              onEdit={editTurn}
              onRetry={(entry) => submit(entry.text, entry)}
              onRetryTurn={(turn) => {
                if (turn.greeting) {
                  setGreetingAwaited(true)
                  start.mutate()
                  return
                }
                // The same message is answered again in place, so the conversation keeps one copy of it.
                retry.mutate(turn.id, { onError: (error) => setEditErrors((current) => ({ ...current, [turn.id]: error.message })) })
              }}
              onSuggestion={(text) => submit(text)}
            />
            <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <View style={styles.column}>{composer}</View>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </View>
  )
}

function PendingView({ entry, onRetry, onOpenFile }: { entry: Pending; onRetry: () => void; onOpenFile: (file: WorkbotAttachment) => void }) {
  const urls: Record<string, string | null> = {}
  const attachments = entry.uploads.map((upload) => {
    const id = upload.saved?.id ?? `local-${upload.key}`
    urls[id] = upload.previewUri
    return { id, name: upload.file.name, mediaType: upload.file.mimeType || "application/octet-stream", size: upload.file.size }
  })
  const uploading = entry.uploads.some((upload) => upload.status === "uploading")
  return (
    <View style={styles.pending}>
      <SentAttachments attachments={attachments} localUris={urls} onOpen={onOpenFile} />
      <UserBubble text={entry.text} muted={Boolean(entry.failed)} />
      {entry.failed ? <ErrorLine align="end" action={{ label: "Send again", onPress: onRetry }}>{entry.failed}</ErrorLine> : uploading ? <QuietLine label="Uploading your files" /> : null}
    </View>
  )
}

function Conversation(props: {
  listRef: React.RefObject<LegendListRef | null>
  me: WorkbotMe
  chat: string | null
  side: boolean
  data: { name: string; organizationName: string; hasEarlier: boolean; turns: WorkbotTurn[] }
  turns: WorkbotTurn[]
  pending: Pending[]
  live: ReturnType<typeof useWorkbotLive>["live"]
  starting: boolean
  canChange: boolean
  editErrors: Readonly<Record<string, string>>
  loadingEarlier: boolean
  onLoadEarlier: () => void
  onEdit: (turn: WorkbotTurn, text: string) => void
  onRetry: (entry: Pending) => void
  onRetryTurn: (turn: WorkbotTurn) => void
  onSuggestion: (text: string) => void
}) {
  const known = new Set(props.turns.map((turn) => turn.id))
  const hello = props.data.turns[0]
  // A hello that failed before writing anything leaves the drawn greeting in its place.
  const helloFailed = hello?.greeting === true && hello.status === "failed" && !hello.parts.some((part) => part.kind === "text")
  const spoken = props.side || props.starting || (hello?.greeting === true && !helloFailed)
  const introAt = hello?.sentAt ?? props.pending[0]?.sentAt ?? Date.now()
  const showIntro = !props.data.hasEarlier
  const rows = useMemo(() => {
    const entries = [
      ...props.turns.map((turn) => ({ key: turn.id, at: turn.sentAt ?? 0, turn, pending: null })),
      ...props.pending.filter((entry) => !known.has(entry.id)).map((entry) => ({ key: entry.id, at: entry.sentAt, turn: null, pending: entry })),
    ]
    // The greeting has its own time; the first message only gets one after a quiet hour or a new day.
    let previousAt: number | null = showIntro && !spoken ? introAt : null
    return entries.map((entry): Row => {
      const stamp = showsTimestamp(previousAt, entry.at)
      previousAt = entry.at || previousAt
      return { ...entry, stamp }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.turns, props.pending, showIntro, spoken, introAt])
  const lastTurnId = props.turns.at(-1)?.id
  const localUris = useMemo(() => {
    const urls: Record<string, string | null> = {}
    for (const entry of props.pending) for (const upload of entry.uploads) if (upload.saved) urls[upload.saved.id] = upload.previewUri
    return urls
  }, [props.pending])
  const typing = useSettled(
    props.starting
      || props.pending.some((entry) => !known.has(entry.id) && !entry.failed && !entry.uploads.some((upload) => upload.status === "uploading"))
      || props.turns.some((turn) => awaitingReply(turn, props.live[turn.id] ?? null)),
    TYPING_SETTLE_MS,
  )
  const open = (file: WorkbotAttachment) => openFile(file, props.chat)

  return (
    <LegendList
      ref={props.listRef}
      data={rows}
      keyExtractor={(row) => row.key}
      estimatedItemSize={140}
      maintainScrollAtEnd
      alignItemsAtEnd
      initialScrollAtEnd
      recycleItems={false}
      extraData={props.live}
      contentContainerStyle={styles.listContent}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.column}>
          {props.data.hasEarlier ? (
            <View style={styles.earlier}>
              <QuietButton label={props.loadingEarlier ? "Loading earlier messages" : "Show earlier messages"} tone="muted" disabled={props.loadingEarlier} onPress={props.onLoadEarlier} />
            </View>
          ) : null}
          {showIntro ? (
            <View style={helloFailed ? null : styles.introGap}>
              <Intro name={props.data.name} organizationName={props.data.organizationName} firstName={firstNameOf(props.me.name)} at={introAt} spoken={spoken} apps={[]} />
            </View>
          ) : null}
        </View>
      }
      renderItem={({ item, index }) => (
        <View style={[styles.column, index > 0 ? (item.stamp ? styles.rowStamped : styles.row) : null]}>
          {item.stamp ? <Timestamp at={item.at} /> : null}
          {item.turn ? (
            <TurnView
              turn={item.turn}
              live={props.live[item.turn.id] ?? null}
              latest={item.turn.id === lastTurnId && props.pending.every((entry) => known.has(entry.id))}
              canChange={props.canChange}
              editError={props.editErrors[item.turn.id] ?? null}
              denUrl={props.me.denUrl}
              localUris={localUris}
              onEdit={props.onEdit}
              onRetry={() => item.turn && props.onRetryTurn(item.turn)}
              onSuggestion={props.onSuggestion}
              onOpenFile={open}
            />
          ) : item.pending ? (
            <PendingView entry={item.pending} onRetry={() => item.pending && props.onRetry(item.pending)} onOpenFile={open} />
          ) : null}
        </View>
      )}
      ListFooterComponent={typing ? <View style={styles.column}><TypingBubble /></View> : <View style={styles.footer} />}
    />
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  body: { flex: 1 },
  column: { width: "100%", maxWidth: COLUMN, alignSelf: "center" },
  listContent: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 },
  row: { paddingTop: 32 },
  rowStamped: { paddingTop: 36 },
  introGap: { paddingBottom: 32 },
  earlier: { alignItems: "center", paddingBottom: 24 },
  footer: { height: 8 },
  pending: { gap: 4 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 12, backgroundColor: color.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 6 },
  centeredText: { fontSize: 14, color: color.text, textAlign: "center" },
  centeredMuted: { fontSize: 13, color: color.muted, textAlign: "center" },
  gapTop: { marginTop: 6 },
  skeleton: { flex: 1, justifyContent: "flex-end", paddingHorizontal: 16, paddingBottom: 96, gap: 12 },
  skeletonBlock: { borderRadius: 20, backgroundColor: color.bubble },
  skeletonMine: { alignSelf: "flex-end", width: 190, height: 38 },
  skeletonLine: { width: 160, height: 22, backgroundColor: color.chip },
  skeletonAnswer: { width: "70%", height: 96, backgroundColor: color.surface },
})
