import { useEffect, useState } from "react"
import { ArrowLeft, Columns2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { t } from "@/i18n"
import { childOrigin, prepareChildReturn } from "@/lib/child-navigation"
import { remoteSessionRouteId } from "@/lib/remote-session-route"
import { openRemoteThreadPanel } from "@/components/chat/remote-thread-run-line"
import { useDenAuth } from "@/react-app/kernel/den-auth-context"
import { remoteHelperOrigin, type RemoteHelperOrigin } from "./remote-helper-navigation"
import { useRemoteHelperScope } from "./use-remote-helper-scope"
import { RemoteFollowUpComposer } from "./remote-follow-up-composer"
import { RemoteThreadTranscriptBody } from "./remote-thread-panel"
import { stopRemoteThread } from "./remote-thread-actions"
import { useDesktopFeature } from "@/react-app/domains/session/status/use-desktop-feature"
import { RemoteThreadAnswerSlot } from "./remote-thread-answer-card"
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
  openBeside?: (parentSessionId: string, threadKey: string, title: string) => void
  resolveParentTitle?: (sessionId: string) => string | null
}

function fallbackOriginFromEntry(entry: RemoteThreadEntry | null, saved: RemoteHelperOrigin | null = null): RemoteHelperOrigin | null {
  if (!entry) return saved
  const owner = Object.values(entry.owners)[0] ?? saved?.owner ?? { workspaceId: "", sessionId: "" }
  return {
    start: entry.start,
    owner,
    parentTitle: saved?.parentTitle ?? null,
  }
}

function useRemoteHelper(threadKey: string) {
  const denAuth = useDenAuth()
  const liveSyncEnabled = useDesktopFeature("remoteSessionLiveSync")
  const liveHydrated = useRemoteThreadLiveHydrated()
  const scope = useRemoteHelperScope()
  const entry = useRemoteThread(threadKey)
  const savedOrigin = scope ? remoteHelperOrigin(threadKey, scope) : null
  const origin = scope
    ? (liveSyncEnabled ? fallbackOriginFromEntry(entry, savedOrigin) : (savedOrigin ?? fallbackOriginFromEntry(entry)))
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
  const routeId = remoteSessionRouteId(threadKey)
  const rememberedParent = childOrigin(navigation.scope, routeId)
  const parentSessionId = rememberedParent?.parentId ?? origin.owner.sessionId
  const parentTitle = origin.parentTitle?.trim()
    || rememberedParent?.title?.trim()
    || (parentSessionId ? navigation.resolveParentTitle?.(parentSessionId)?.trim() : null)
    || t("session.remote_task_parent_fallback")
  const hasParent = Boolean(parentSessionId)
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px]" data-remote-session-header={threadKey}>
      {hasParent ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 cursor-pointer gap-1 rounded-lg px-1.5 text-[12px] text-gray-10 transition-colors hover:bg-muted hover:text-foreground titlebar-no-drag"
                aria-label={t("session.remote_task_back_to", { title: parentTitle })}
                data-remote-session-parent={parentSessionId}
                onClick={returnToParent}
              >
                <ArrowLeft size={14} />
                <span className="max-w-44 truncate max-lg:hidden">{parentTitle}</span>
              </Button>
            }
          />
          <TooltipContent>{t("session.remote_task_back_to", { title: parentTitle })}</TooltipContent>
        </Tooltip>
      ) : null}
      <nav className="flex min-w-0 items-center gap-1 text-[13px] titlebar-no-drag" aria-label={view.title}>
        <span className="max-w-44 shrink-0 truncate px-1 text-dls-secondary" data-remote-thread-computer="">
          {view.computer}
        </span>
        <span aria-hidden="true" className="text-dls-secondary/50">/</span>
        <h1 className="min-w-0 truncate px-1 text-[13px] font-medium text-dls-text" data-session-header-title>
          {view.title}
        </h1>
      </nav>
      {hasParent ? (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground titlebar-no-drag"
          data-remote-session-open-beside=""
          onClick={() => {
            if (navigation.openBeside) {
              navigation.openBeside(parentSessionId, origin.start.key, view.title)
              returnToParent()
              return
            }
            returnToParent()
            openRemoteThreadPanel(parentSessionId, origin.owner.workspaceId, origin.start, view.title)
          }}
        >
          <Columns2 className="size-3.5" aria-hidden="true" />
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
  const threadKey = entry.start.key
  const conversation = useRemoteThreadConversation(entry)
  const { view } = conversation
  const returnToParent = useReturnToParent(threadKey, origin, navigation)

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
      <RemoteThreadTranscriptBody entry={entry} conversation={conversation} />
      <RemoteThreadAnswerSlot entry={entry} conversation={conversation} />

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
