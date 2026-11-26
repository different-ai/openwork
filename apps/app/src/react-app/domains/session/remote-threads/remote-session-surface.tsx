import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { t } from "@/i18n"
import { cn } from "@/lib/utils"
import { childOrigin, prepareChildReturn } from "@/lib/child-navigation"
import { remoteSessionRouteId } from "@/lib/remote-session-route"
import { openRemoteThreadPanel } from "@/components/chat/remote-thread-run-line"
import { useDenAuth } from "@/react-app/kernel/den-auth-context"
import { remoteHelperOrigin, type RemoteHelperOrigin } from "./remote-helper-navigation"
import { useRemoteHelperScope } from "./use-remote-helper-scope"
import { RemoteFollowUpComposer } from "./remote-follow-up-composer"
import { RemoteThreadTranscriptBody } from "./remote-thread-panel"
import { answerRemoteThread, stopRemoteThread } from "./remote-thread-actions"
import { useDesktopFeature } from "@/react-app/domains/session/status/use-desktop-feature"
import { RemoteThreadAnswerCard } from "./remote-thread-answer-card"
import {
  fetchBoundRemoteSessions,
  useFollowRemoteThread,
  useRemoteThread,
  useRemoteThreadLiveHydrated,
  type RemoteThreadEntry,
} from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"
import { useRemoteThreadConversation } from "./use-remote-thread-conversation"

export type RemoteHelperNavigation = {
  scope: string
  openParent: (sessionId: string) => void
}

function fallbackOriginFromEntry(entry: RemoteThreadEntry | null): RemoteHelperOrigin | null {
  if (!entry) return null
  const owner = Object.values(entry.owners)[0] ?? { workspaceId: "", sessionId: "" }
  return { start: entry.start, owner, parentTitle: null }
}

function useRemoteHelper(threadKey: string) {
  const denAuth = useDenAuth()
  const liveSyncEnabled = useDesktopFeature("remoteSessionLiveSync")
  const liveHydrated = useRemoteThreadLiveHydrated()
  const scope = useRemoteHelperScope()
  const entry = useRemoteThread(threadKey)
  const origin = scope
    ? (liveSyncEnabled ? (fallbackOriginFromEntry(entry) ?? remoteHelperOrigin(threadKey, scope)) : (remoteHelperOrigin(threadKey, scope) ?? fallbackOriginFromEntry(entry)))
    : null
  const checking = denAuth.status === "checking" || (liveSyncEnabled && Boolean(scope) && !liveHydrated && !entry)
  if (liveSyncEnabled && scope && !liveHydrated && !entry) void fetchBoundRemoteSessions()
  useFollowRemoteThread(origin?.start ?? null, origin && origin.owner.sessionId ? origin.owner : null, null)
  return { origin, entry, checking, ready: Boolean(scope) }
}

function useReturnToParent(threadKey: string, origin: RemoteHelperOrigin | null, navigation: RemoteHelperNavigation) {
  return () => {
    const routeId = remoteSessionRouteId(threadKey)
    const parent = childOrigin(navigation.scope, routeId)?.parentId ?? origin?.owner.sessionId
    prepareChildReturn(navigation.scope, routeId)
    if (parent) navigation.openParent(parent)
  }
}

export function RemoteSessionHeader({ threadKey, navigation }: { threadKey: string; navigation: RemoteHelperNavigation }) {
  const { origin, entry } = useRemoteHelper(threadKey)
  const returnToParent = useReturnToParent(threadKey, origin, navigation)
  const [stopping, setStopping] = useState(false)
  if (!origin) return null
  const view = remoteThreadView(origin.start, entry, Date.now())
  const parentTitle = origin.parentTitle?.trim() || t("session.remote_task_parent_fallback")
  const hasParent = Boolean(origin.owner.sessionId)
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px]" data-remote-session-header={threadKey}>
      <nav className="flex min-w-0 items-center gap-1" aria-label={view.title}>
        {hasParent ? (
          <>
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
          </>
        ) : null}
        <h1 className="min-w-0 truncate font-medium text-foreground" data-session-header-title>{view.title}</h1>
      </nav>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline" data-remote-thread-computer="">{view.computer}</span>
      {hasParent ? (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 titlebar-no-drag"
          data-remote-session-open-beside=""
          onClick={() => {
            returnToParent()
            openRemoteThreadPanel(origin.owner.sessionId, origin.owner.workspaceId, origin.start, view.title)
          }}
        >
          {t("session.remote_task_open_beside")}
        </Button>
      ) : null}
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
  const { origin, entry, checking, ready } = useRemoteHelper(threadKey)
  if (checking && (!ready || !origin || !entry)) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-12" aria-hidden="true" data-remote-session-loading={threadKey}>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }
  if (!origin || !entry) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-sm text-muted-foreground" data-remote-session-missing={threadKey}>
        {t("session.remote_task_missing")}
      </div>
    )
  }
  return <RemoteSessionConversation key={threadKey} entry={entry} origin={origin} navigation={navigation} />
}

function RemoteSessionConversation({ entry, origin, navigation }: { entry: RemoteThreadEntry; origin: RemoteHelperOrigin; navigation: RemoteHelperNavigation }) {
  const questionMinimizeEnabled = useDesktopFeature("questionMinimize")
  const threadKey = entry.start.key
  const conversation = useRemoteThreadConversation(entry, { foldTask: true })
  const { view } = conversation
  const returnToParent = useReturnToParent(threadKey, origin, navigation)
  const brief = entry.start.prompt?.trim() ?? ""
  const [briefOpen, setBriefOpen] = useState(false)

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key !== "Escape" && !(event.metaKey && event.key === "[")) return
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
            <CollapsibleTrigger className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 text-start hover:text-foreground">
              <span className="min-w-0 truncate">{t("session.remote_task_brief", { brief })}</span>
              <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none", briefOpen && "rotate-90")} />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 whitespace-pre-wrap text-foreground">{brief}</CollapsibleContent>
          </Collapsible>
        ) : null}
      </RemoteThreadTranscriptBody>

      {view.waitingFor && conversation.page?.pending?.kind === view.waitingFor ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-3" data-remote-session-question-slot="">
          <RemoteThreadAnswerCard pending={conversation.page.pending} computer={view.computer} collapsible={questionMinimizeEnabled} onAnswer={(answer) => answerRemoteThread(entry, answer)} />
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
