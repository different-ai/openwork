import { useEffect, useLayoutEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { t } from "@/i18n"
import { cn } from "@/lib/utils"
import { childOrigin, prepareChildReturn, registerChildDraftPersistence } from "@/lib/child-navigation"
import { remoteSessionRouteId } from "@/lib/remote-session-route"
import { openRemoteThreadPanel } from "@/components/chat/remote-thread-run-line"
import { remoteHelperDraft, remoteHelperOrigin, saveRemoteHelperDraft, type RemoteHelperOrigin } from "./remote-helper-navigation"
import { RemoteFollowUpComposer } from "./remote-follow-up-composer"
import { RemoteThreadTranscriptBody } from "./remote-thread-panel"
import { answerRemoteThread, stopRemoteThread } from "./remote-thread-actions"
import { RemoteThreadAnswerCard } from "./remote-thread-answer-card"
import { useFollowRemoteThread, useRemoteThread, useRemoteThreadHelperViewEnabled, type RemoteThreadEntry } from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"
import { useRemoteThreadConversation } from "./use-remote-thread-conversation"

/**
 * `remoteSessionHelperView`: a task on another computer opened in the main
 * pane, the way a local helper opens (#6590). Enter steers it, the round
 * button stops it while it runs, and Esc or the breadcrumb return to the chat
 * that started it at the same pane, scroll position and row, with the draft
 * here kept for next time. The route is `remote:<threadKey>`; nothing about
 * it touches the local engine.
 */

/** Where a task's route returns to, shared by the header and the pane. */
export type RemoteHelperNavigation = {
  /** `child-navigation.ts` scope of the chat pane it was opened from. */
  scope: string
  /** Opens the chat that started the task. */
  openParent: (sessionId: string) => void
}

function useRemoteHelper(threadKey: string) {
  const [origin] = useState<RemoteHelperOrigin | null>(() => remoteHelperOrigin(threadKey))
  // Like an open panel, the open task keeps itself followed.
  useFollowRemoteThread(origin?.start ?? null, origin?.owner ?? { workspaceId: "", sessionId: "" }, null)
  const entry = useRemoteThread(threadKey)
  return { origin, entry }
}

function useReturnToParent(threadKey: string, origin: RemoteHelperOrigin | null, navigation: RemoteHelperNavigation) {
  return () => {
    const routeId = remoteSessionRouteId(threadKey)
    const parent = childOrigin(navigation.scope, routeId)?.parentId ?? origin?.owner.sessionId
    prepareChildReturn(navigation.scope, routeId)
    if (parent) navigation.openParent(parent)
  }
}

/** The page header for a task: `Parent chat / Task title`, where it runs, Open beside and Stop as text. */
export function RemoteSessionHeader({ threadKey, navigation }: { threadKey: string; navigation: RemoteHelperNavigation }) {
  const { origin, entry } = useRemoteHelper(threadKey)
  const returnToParent = useReturnToParent(threadKey, origin, navigation)
  const [stopping, setStopping] = useState(false)
  if (!origin) return null
  const view = remoteThreadView(origin.start, entry, Date.now())
  const parentTitle = origin.parentTitle?.trim() || t("session.remote_task_parent_fallback")
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px]" data-remote-session-header={threadKey}>
      <nav className="flex min-w-0 items-center gap-1" aria-label={view.title}>
        {/* Plain text, no button padding: the breadcrumb starts on the header's own left edge. */}
        <button
          type="button"
          className="max-w-48 shrink-0 cursor-pointer truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none titlebar-no-drag"
          aria-label={t("session.remote_task_back_to", { title: parentTitle })}
          data-remote-session-parent={origin.owner.sessionId}
          onClick={returnToParent}
        >
          {parentTitle}
        </button>
        <span aria-hidden="true" className="text-muted-foreground/60">/</span>
        <h1 className="min-w-0 truncate font-medium text-foreground" data-session-header-title>{view.title}</h1>
      </nav>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline" data-remote-thread-computer="">{view.computer}</span>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 titlebar-no-drag"
        data-remote-session-open-beside=""
        onClick={() => {
          // The side panel belongs to the chat that started the task.
          returnToParent()
          openRemoteThreadPanel(origin.owner.sessionId, origin.owner.workspaceId, origin.start, view.title)
        }}
      >
        {t("session.remote_task_open_beside")}
      </Button>
      {view.active && view.started && entry ? (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 titlebar-no-drag"
          disabled={stopping}
          aria-label={t(stopping ? "session.remote_task_stopping" : "session.remote_task_stop", { title: view.title })}
          onClick={() => {
            setStopping(true)
            void stopRemoteThread(entry).finally(() => setStopping(false))
          }}
        >
          {t(stopping ? "session.remote_task_stopping_short" : "session.remote_task_stop_short")}
        </Button>
      ) : null}
    </div>
  )
}

export function RemoteSessionSurface({ threadKey, navigation }: { threadKey: string; navigation: RemoteHelperNavigation }) {
  const enabled = useRemoteThreadHelperViewEnabled()
  const { origin, entry } = useRemoteHelper(threadKey)
  if (!enabled || !origin) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-sm text-muted-foreground" data-remote-session-missing={threadKey}>
        {t(enabled ? "session.remote_task_missing" : "session.remote_task_helper_disabled")}
      </div>
    )
  }
  if (!entry) return null
  return <RemoteSessionConversation key={threadKey} entry={entry} origin={origin} navigation={navigation} />
}

function RemoteSessionConversation({ entry, origin, navigation }: { entry: RemoteThreadEntry; origin: RemoteHelperOrigin; navigation: RemoteHelperNavigation }) {
  const threadKey = entry.start.key
  const conversation = useRemoteThreadConversation(entry, { initialDraft: remoteHelperDraft(threadKey), foldTask: true })
  const { view } = conversation
  const returnToParent = useReturnToParent(threadKey, origin, navigation)
  const brief = entry.start.prompt?.trim() ?? ""
  const [briefOpen, setBriefOpen] = useState(false)

  // Leaving by any path (Esc, breadcrumb, sidebar) keeps the draft for next time.
  const { draftRef } = conversation
  useLayoutEffect(() => registerChildDraftPersistence(navigation.scope, remoteSessionRouteId(threadKey), () => saveRemoteHelperDraft(threadKey, draftRef.current)),
    [navigation.scope, threadKey, draftRef])
  useEffect(() => () => saveRemoteHelperDraft(threadKey, draftRef.current), [threadKey, draftRef])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key !== "Escape" && !(event.metaKey && event.key === "[")) return
      // An open menu or dialog takes Esc first, as in a local helper.
      if ([...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"], [data-composer-menu-open="true"]')]
        .some(element => element.getClientRects().length > 0 && !element.hasAttribute("data-closed")
          && element.getAttribute("data-state") !== "closed")) return
      event.preventDefault()
      event.stopPropagation()
      returnToParent()
    }
    document.addEventListener("keydown", handler, true)
    return () => document.removeEventListener("keydown", handler, true)
  })

  return (
    <div className="flex h-full min-h-0 flex-col" data-remote-session-surface={threadKey} data-remote-thread-state={view.state}>
      <RemoteThreadTranscriptBody entry={entry} conversation={conversation}>
        {brief ? (
          <Collapsible open={briefOpen} onOpenChange={setBriefOpen} className="mx-auto w-full max-w-3xl px-2 text-sm text-muted-foreground md:px-10" data-remote-session-brief="">
            {/* Text first, chevron after it (one left edge with the replies below). */}
            <CollapsibleTrigger className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 text-start hover:text-foreground">
              <span className="min-w-0 truncate">{t("session.remote_task_brief", { brief })}</span>
              <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none", briefOpen && "rotate-90")} />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 whitespace-pre-wrap text-foreground">{brief}</CollapsibleContent>
          </Collapsible>
        ) : null}
      </RemoteThreadTranscriptBody>

      {/* The task's question or permission, answered from here. */}
      {view.waitingFor && conversation.page?.pending?.kind === view.waitingFor ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-3" data-remote-session-question-slot="">
          <RemoteThreadAnswerCard pending={conversation.page.pending} computer={view.computer} onAnswer={(answer) => answerRemoteThread(entry, answer)} />
        </div>
      ) : view.waitingFor ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-5 py-2 text-xs text-amber-11" data-remote-thread-waiting={view.waitingFor}>
          {t("session.remote_task_answer_there", { computer: view.computer })}
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-3xl">
        <RemoteFollowUpComposer
          draft={conversation.draft}
          onDraftChange={conversation.setDraft}
          onSend={() => void conversation.sendFollowUp()}
          onStop={() => void conversation.stop()}
          computer={view.computer}
          running={view.active && view.started}
          disabled={!view.started}
          sending={conversation.sending}
          stopping={conversation.stopping}
          error={conversation.actionError}
          autoFocus
        />
      </div>
    </div>
  )
}
