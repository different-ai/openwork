/** @jsxImportSource react */
import { useState } from "react"
import { LockKeyhole, Plus, Share2 } from "lucide-react"
import type { AutomationSharing } from "@openwork/types/automations"
import type { DenLibraryOrgDirectory } from "@/app/lib/den-library"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/sonner"
import {
  automationAudienceDraft,
  automationShareLabel,
  automationSharingInput,
  automationSharingSuccess,
  describeAutomationSharingError,
} from "./automation-sharing"
import { useAutomationSharingContextQuery, useAutomationSharingQuery, type AutomationsDenContext } from "./use-automations"

export function AutomationShareButton(props: {
  context: AutomationsDenContext
  automation: { id: string; name: string; ownerMemberId: string }
  refresh: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const audienceContext = useAutomationSharingContextQuery(props.context, true)
  const owner = audienceContext.data?.directory.currentMemberId === props.automation.ownerMemberId
  const sharingQuery = useAutomationSharingQuery(props.context, props.automation.id, owner)
  if (!owner) return null
  const { client, organizationId } = props.context
  const data = audienceContext.data
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-automation-share>
        <Share2 />{automationShareLabel(sharingQuery.data)}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>Share {props.automation.name}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">They can add their own copy. It runs with their connections and models, not yours. They never see your runs.</p>
          {sharingQuery.isError || audienceContext.isError ? (
            <div className="space-y-3">
              <p role="alert" className="text-sm">Sharing could not be loaded. Check your connection and try again.</p>
              <Button variant="outline" onClick={() => void Promise.all([sharingQuery.refetch(), audienceContext.refetch()])}>Try again</Button>
            </div>
          ) : !sharingQuery.data || !data ? (
            <div role="status" aria-label="Checking sharing" className="space-y-3">
              <Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-9 w-40" />
            </div>
          ) : open ? (
            <AutomationSharingForm
              key={`${organizationId}:${props.automation.id}`}
              initial={sharingQuery.data}
              directory={data.directory}
              canShareOrgWide={data.canShareOrgWide}
              busy={busy}
              onCancel={() => setOpen(false)}
              onSave={async (input) => {
                if (!client || !organizationId) return
                setBusy(true)
                try {
                  const saved = await client.updateAutomationSharing(organizationId, props.automation.id, input)
                  await props.refresh()
                  toast.success(automationSharingSuccess(saved, data.directory))
                  setOpen(false)
                } finally {
                  setBusy(false)
                }
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function AutomationSharingForm(props: {
  initial: AutomationSharing
  directory: DenLibraryOrgDirectory
  canShareOrgWide: boolean
  busy: boolean
  onCancel: () => void
  onSave: (input: ReturnType<typeof automationSharingInput>) => Promise<void>
}) {
  const [draft, setDraft] = useState(() => automationAudienceDraft(props.initial, props.directory))
  const [error, setError] = useState<string | null>(null)
  const input = automationSharingInput(draft)
  const unchanged = JSON.stringify(input) === JSON.stringify(automationSharingInput(automationAudienceDraft(props.initial, props.directory)))
  const peopleLeft = props.directory.members.filter((member) => member.id !== props.directory.currentMemberId && !draft.people.some((person) => person.id === member.id))
  const teamsLeft = props.directory.teams.filter((team) => !draft.teams.some((entry) => entry.id === team.id))
  const save = async () => {
    setError(null)
    try { await props.onSave(input) }
    catch (cause) { setError(describeAutomationSharingError(cause)) }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 border-b border-border py-3">
        <div className="min-w-0 space-y-1">
          <label htmlFor="automation-sharing-everyone" className="text-sm font-medium">Everyone in the organization</label>
          {!props.canShareOrgWide ? (
            <p id="automation-sharing-permission" className="flex items-start gap-2 text-xs text-muted-foreground">
              <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
              An organization owner or admin can give you permission to share with everyone.
            </p>
          ) : null}
        </div>
        <Switch
          id="automation-sharing-everyone"
          aria-describedby={!props.canShareOrgWide ? "automation-sharing-permission" : undefined}
          checked={draft.orgWide}
          disabled={props.busy || !props.canShareOrgWide}
          onCheckedChange={(orgWide) => setDraft((current) => ({ ...current, orgWide }))}
        />
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-border">
        {draft.teams.map((team) => (
          <div key={team.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate text-sm">{team.name}<span className="ml-2 text-xs text-muted-foreground">Team</span></span>
            <Button variant="ghost" size="sm" disabled={props.busy} aria-label={`Remove ${team.name}`} onClick={() => setDraft((current) => ({ ...current, teams: current.teams.filter((entry) => entry.id !== team.id) }))}>Remove</Button>
          </div>
        ))}
        {draft.people.map((person) => (
          <div key={person.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate text-sm">{person.name}</span>
            <Button variant="ghost" size="sm" disabled={props.busy} aria-label={`Remove ${person.name}`} onClick={() => setDraft((current) => ({ ...current, people: current.people.filter((entry) => entry.id !== person.id) }))}>Remove</Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <AddAudienceMenu label="Add people" empty="Everyone has been added" disabled={props.busy} options={peopleLeft} onPick={(person) => setDraft((current) => ({ ...current, people: [...current.people, person] }))} />
        <AddAudienceMenu label="Add teams" empty="No more teams to add" disabled={props.busy} options={teamsLeft} onPick={(team) => setDraft((current) => ({ ...current, teams: [...current.teams, team] }))} />
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
        <Button disabled={props.busy || unchanged} onClick={() => void save()}>{error ? "Try again" : "Save changes"}</Button>
      </div>
    </div>
  )
}

function AddAudienceMenu(props: {
  label: string
  empty: string
  disabled: boolean
  options: Array<{ id: string; name: string }>
  onPick: (option: { id: string; name: string }) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={props.disabled} />}><Plus />{props.label}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {props.options.length ? props.options.map((option) => (
            <DropdownMenuItem key={option.id} onClick={() => props.onPick({ id: option.id, name: option.name })}>{option.name}</DropdownMenuItem>
          )) : <DropdownMenuItem disabled>{props.empty}</DropdownMenuItem>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
