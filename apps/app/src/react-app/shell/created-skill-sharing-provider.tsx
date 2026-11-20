import { useMemo, useState, type ComponentType, type ReactNode } from "react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import type { UIMessage } from "ai"
import { BookOpenCheck } from "lucide-react"

import { markFeatureUsed } from "@/app/lib/den"
import { CreatedSkillSharingContext, type ReadyCreatedSkill } from "@/components/chat/created-skill-card"
import type { CreatedSkillSharingProviderProps } from "../kernel/created-skill-sharing"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { collectCreatedSkills } from "@/lib/created-skill"
import { useAppsClient, useAppsIdentity } from "../domains/apps/use-apps"
import { useOrgFeature } from "../domains/cloud/use-org-feature"
import { isOwnedLibraryPlugin } from "../domains/settings/library-sharing"
import { LibrarySharePage } from "../domains/settings/pages/library-share-page"
import { useLibraryCloud } from "../domains/settings/use-library-cloud"

type SharingSkill = { card: ReadyCreatedSkill; onSaved: () => Promise<void>; scopeKey: string }

export function CreatedSkillSharingProvider({ messages, active, children }: CreatedSkillSharingProviderProps) {
  const feature = useOrgFeature("chatSkillCardShare", { active })
  const identity = useAppsIdentity()
  return (
    <CreatedSkillSharing
      messages={messages}
      enabled={active && feature && identity.identityVerified}
      context={{ ...identity, canManage: false }}
      dialog={SkillSharingWithRole}
    >
      {children}
    </CreatedSkillSharing>
  )
}

function skillPermissionsQuery(context: ReturnType<typeof useAppsClient>, pluginIds: string[]) {
  return queryOptions({
    queryKey: ["created-skill-share-permissions", ...context.scope, pluginIds],
    queryFn: () => {
      if (!context.client || !context.orgId) throw new Error("Sign in to share this skill.")
      return context.client.listMeLibraryItems(context.orgId)
    },
    staleTime: 30_000,
  })
}

function SkillPermissionsController({ options }: { options: ReturnType<typeof skillPermissionsQuery> }) {
  useQuery(options)
  return null
}

type SkillSharingDialogProps = {
  context: ReturnType<typeof useAppsClient>
  sharing: SharingSkill
  onClose: () => void
}

function SkillSharingWithRole(props: SkillSharingDialogProps) {
  const context = useAppsClient()
  if (!context.identityVerified || JSON.stringify(context.scope) !== props.sharing.scopeKey) return null
  return <SkillSharingDialog {...props} context={context} />
}

export function CreatedSkillSharing({ messages, enabled, context, children, dialog: SharingDialog = SkillSharingDialog }: {
  messages: UIMessage[]
  enabled: boolean
  context: ReturnType<typeof useAppsClient>
  children: ReactNode
  dialog?: ComponentType<SkillSharingDialogProps>
}) {
  const pluginIds = useMemo(() => collectCreatedSkills(messages, { live: false }).cards.flatMap((card) =>
    card.kind === "ready" ? [card.pluginId] : []), [messages])
  const options = skillPermissionsQuery(context, pluginIds)
  const permissions = useQuery({ ...options, enabled: false })
  const ownedPluginIds = new Set((enabled && !permissions.isError ? permissions.data ?? [] : [])
    .filter((item) => item.type === "plugin" && isOwnedLibraryPlugin(item)).map((item) => item.id))
  const scopeKey = JSON.stringify(context.scope)
  const [sharing, setSharing] = useState<SharingSkill | null>(null)
  const resetKey = JSON.stringify([scopeKey, enabled])
  const [previousResetKey, setPreviousResetKey] = useState(resetKey)
  if (previousResetKey !== resetKey) {
    setPreviousResetKey(resetKey)
    setSharing(null)
  }
  return (
    <CreatedSkillSharingContext.Provider value={{
      enabled,
      ownedPluginIds,
      onShareSkill: (card, onSaved) => {
        if (!enabled || !ownedPluginIds.has(card.pluginId)) return
        markFeatureUsed("chatSkillCardShare")
        setSharing({ card, onSaved, scopeKey })
      },
    }}>
      {children}
      {enabled && pluginIds.length > 0 && context.client && context.orgId ? <SkillPermissionsController options={options} /> : null}
      {enabled && sharing?.scopeKey === scopeKey && pluginIds.includes(sharing.card.pluginId) && context.client && context.orgId ? (
        <SharingDialog key={scopeKey} context={context} sharing={sharing} onClose={() => setSharing(null)} />
      ) : null}
    </CreatedSkillSharingContext.Provider>
  )
}

function SkillSharingDialog({ context, sharing, onClose }: SkillSharingDialogProps) {
  if (!context.client || !context.orgId) throw new Error("Sign in to share this skill.")
  const library = useLibraryCloud({ client: context.client, organizationId: context.orgId, baseUrl: JSON.stringify(context.scope), enabled: true })
  const { card } = sharing
  const permitted = library.ownedPluginIds.has(card.pluginId) && library.pluginById.has(card.pluginId)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="sr-only"><DialogTitle>Share {card.name}</DialogTitle></DialogHeader>
        {library.sharingError ? (
          <div className="flex items-center gap-2">
            <p role="alert" className="text-sm">Sharing could not be loaded.</p>
            <Button variant="outline" onClick={() => void library.refresh()}>Try again</Button>
          </div>
        ) : !library.ready || !library.directory ? (
          <div role="status" aria-label="Checking sharing"><Skeleton className="h-8 w-1/2" /><Skeleton className="mt-4 h-40 w-full" /></div>
        ) : !permitted ? (
          <p role="status" className="text-sm">Only this skill's owner can share it. Ask them for access.</p>
        ) : !library.grantsReadyFor(card.pluginId) ? <Skeleton className="h-40 w-full" /> : (
          <LibrarySharePage
            name={card.name}
            description={null}
            taxonomy="skill"
            icon={<BookOpenCheck className="size-4" />}
            directory={library.directory}
            initialAudience={library.audienceFor(card.pluginId)}
            canShareOrgWide={context.canManage}
            onCancel={onClose}
            onSave={async (targets) => {
              await library.setAudience(card.pluginId, targets)
              await sharing.onSaved()
              onClose()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
