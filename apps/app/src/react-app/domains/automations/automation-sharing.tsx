/** @jsxImportSource react */
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Lock, Users } from "lucide-react"
import type { AutomationAccess, AutomationShareAccess, AutomationSharing } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { describeAutomationError, type AutomationsDenContext } from "./use-automations"

/**
 * Team sharing on the Automations page (`automationTeamSharing`).
 *
 * An Automation runs with its owner's accounts, so the owner decides which of
 * their teams see it, and teammates are told plainly what they can do with it
 * and who can change that.
 */

type ShareChoice = AutomationShareAccess | "none"

const SHARE_CHOICES: ReadonlyArray<{ value: ShareChoice; label: string }> = [
  { value: "none", label: "Not shared" },
  { value: "view", label: "Can view" },
  { value: "manage", label: "Can manage" },
]

function teamNames(access: Pick<AutomationAccess, "teams">) {
  const names = access.teams.map((team) => team.teamName)
  if (names.length <= 2) return names.join(" and ")
  return `${names.length} teams`
}

/** "Sales" or "3 teams"; null when it is shared with nobody. */
export function sharedWithLabel(access: AutomationAccess | undefined): string | null {
  return access && access.teams.length > 0 ? teamNames(access) : null
}

export function ownerName(access: AutomationAccess | undefined): string {
  return access?.owner.name?.trim() || "its owner"
}

/** The line under a shared Automation's title: whose it is and which of the caller's teams has it. */
export function SharedByLine(props: { access: AutomationAccess; className?: string }) {
  return (
    <span className={props.className ?? "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"} data-automation-shared-by>
      <Users className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{ownerName(props.access)} · {teamNames(props.access)}</span>
    </span>
  )
}

/**
 * What a teammate can do, and who can change it (DESIGN.md P4, C5): neutral
 * ink and a lock, never an error.
 */
export function SharedAccessNotice(props: { access: AutomationAccess; onTakeOver?: () => void; busy?: boolean }) {
  const owner = ownerName(props.access)
  const manage = props.access.role === "manage"
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm"
      data-automation-shared-access={props.access.role}
    >
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Lock className="size-4 shrink-0" aria-hidden="true" />
        <span>
          {manage
            ? `Runs with ${owner}'s accounts. You can pause, resume and run it; only ${owner} can edit it.`
            : `View only. ${owner} can give ${teamNames(props.access)} manage access.`}
        </span>
      </span>
      {manage && props.onTakeOver ? (
        <Button type="button" size="sm" variant="outline" disabled={props.busy} onClick={props.onTakeOver} data-automation-take-over>
          Take over
        </Button>
      ) : null}
    </div>
  )
}

export function automationSharingQueryKey(context: AutomationsDenContext, automationId: string) {
  return [...context.queryRoot, "sharing", automationId] as const
}

/**
 * The owner's Share control: one row per team they are on, each with its
 * access. A change saves at once and is undone by changing it back.
 */
export function AutomationShareButton(props: { context: AutomationsDenContext; automationId: string; access: AutomationAccess | undefined }) {
  const { client, organizationId } = props.context
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [savingTeamId, setSavingTeamId] = useState<string | null>(null)
  const queryKey = automationSharingQueryKey(props.context, props.automationId)
  const sharingQuery = useQuery({
    queryKey,
    queryFn: () => client!.getAutomationSharing(organizationId!, props.automationId),
    enabled: props.context.ready && open,
  })
  const shared = sharedWithLabel(props.access)

  const change = async (teamId: string, teamName: string, choice: ShareChoice) => {
    if (!client || !organizationId) return
    setSavingTeamId(teamId)
    try {
      const next: AutomationSharing = choice === "none"
        ? await client.stopSharingAutomationWithTeam(organizationId, props.automationId, teamId)
        : await client.shareAutomationWithTeam(organizationId, props.automationId, teamId, choice)
      queryClient.setQueryData(queryKey, next)
      await queryClient.invalidateQueries({ queryKey: props.context.queryRoot })
      toast.success(choice === "none" ? `Stopped sharing with ${teamName}` : `Shared with ${teamName}`)
    } catch (error) {
      toast.error(describeAutomationError(error))
    } finally {
      setSavingTeamId(null)
    }
  }

  const sharing = sharingQuery.data
  const accessByTeam = new Map(sharing?.teams.map((team) => [team.teamId, team.access]))
  // A team the owner has since left is still listed, so they can stop sharing with it.
  const rows = sharing
    ? [
        ...sharing.shareableTeams,
        ...sharing.teams
          .filter((team) => !sharing.shareableTeams.some((shareable) => shareable.teamId === team.teamId))
          .map((team) => ({ teamId: team.teamId, teamName: team.teamName, left: true })),
      ]
    : []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" data-automation-share />}>
        <Users />{shared ? `Shared with ${shared}` : "Share"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" aria-label="Share with a team" data-automation-share-panel>
        <PopoverDescription>
          A team sees its instructions, runs and results; with manage it can also pause, run and take it over. It keeps running with your accounts.
        </PopoverDescription>
        {sharingQuery.isLoading ? (
          <div className="space-y-2" role="status" aria-label="Loading teams">
            <Skeleton className="h-9 rounded-xl" />
            <Skeleton className="h-9 rounded-xl" />
          </div>
        ) : sharingQuery.error ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">{describeAutomationError(sharingQuery.error)}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void sharingQuery.refetch()}>Retry</Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground" data-automation-share-no-teams>
            You are not on a team yet. An admin adds people to teams in Members.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((team) => {
              const current: ShareChoice = accessByTeam.get(team.teamId) ?? "none"
              return (
                <li key={team.teamId} className="flex min-h-11 items-center justify-between gap-3 py-1.5" data-automation-share-team={team.teamName}>
                  <span className="min-w-0 truncate">{team.teamName}</span>
                  <Select
                    value={current}
                    items={SHARE_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
                    disabled={savingTeamId !== null}
                    onValueChange={(value) => {
                      const choice = SHARE_CHOICES.find((entry) => entry.value === value)?.value
                      if (choice && choice !== current) void change(team.teamId, team.teamName, choice)
                    }}
                  >
                    <SelectTrigger size="sm" className="w-36" aria-label={`${team.teamName} access`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {SHARE_CHOICES
                          // You can only stop sharing with a team you have left.
                          .filter((choice) => !("left" in team) || choice.value === "none" || choice.value === current)
                          .map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
