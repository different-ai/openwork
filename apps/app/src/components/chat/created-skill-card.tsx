"use client"

import * as React from "react"
import { BookOpenCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  createdSkillAccessLabel,
  createdSkillLibraryDetailId,
  type CreatedSkillCard as CreatedSkillCardModel,
  type CreatedSkillsModel,
} from "@/lib/created-skill"

export type CreatedSkillsContextValue = CreatedSkillsModel & {
  /** Open the skill in Library. Absent where there is no Library (read-only views). */
  onOpenSkill?: (detailId: string) => void
  /** Read the skill's current access without changing it. */
  onCheckSharing?: (pluginId: string) => Promise<void>
}

const EMPTY: CreatedSkillsContextValue = { cards: [], shareLabels: new Map(), savedNames: new Map() }

export const CreatedSkillsContext = React.createContext<CreatedSkillsContextValue>(EMPTY)

export function useCreatedSkills() {
  return React.useContext(CreatedSkillsContext)
}

/** The 36px neutral tile every state shares, so the card never shifts as it fills in. */
function KindTile() {
  return (
    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-slate-4 text-muted-foreground">
      <BookOpenCheck className="size-4.5" strokeWidth={1.5} />
    </span>
  )
}

const OPEN_CLASS = "h-7 rounded-lg bg-background px-3 text-xs before:rounded-[inherit]"

/**
 * The skill a turn produced, kept in view as the result even when the turn's
 * steps fold. Name and access come from validated results only; Open is an
 * explicit action that opens the existing Library detail, never on its own.
 */
export function CreatedSkillCard({ card }: { card: CreatedSkillCardModel }) {
  const { onOpenSkill, onCheckSharing } = useCreatedSkills()
  const [checking, setChecking] = React.useState(false)

  if (card.kind === "loading") {
    return (
      <div data-created-skill="loading" aria-busy="true" className="flex min-h-17 w-full max-w-110 items-center gap-3 rounded-xl bg-sidebar p-3">
        <KindTile />
        <div className="flex min-w-0 flex-1 flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-3 w-28 rounded-sm bg-slate-4" />
          <Skeleton className="h-2 w-44 rounded-sm bg-slate-4" />
        </div>
        <span className="sr-only">Loading the saved skill</span>
        <Button type="button" variant="outline" size="sm" className={OPEN_CLASS} disabled>Open</Button>
      </div>
    )
  }

  const label = createdSkillAccessLabel(card)
  const unverified = card.pending?.state === "unverified"
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        data-created-skill={card.skillId}
        className="flex min-h-17 w-full max-w-110 items-center gap-3 rounded-xl bg-sidebar p-3"
      >
        <KindTile />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{card.name}</p>
          <p data-created-skill-access="" className="truncate pt-0.5 text-xs text-muted-foreground">{label}</p>
        </div>
        {onOpenSkill ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={OPEN_CLASS}
            aria-label={`Open ${card.name} in Library`}
            onClick={() => onOpenSkill(createdSkillLibraryDetailId(card))}
          >
            Open
          </Button>
        ) : null}
      </div>
      {unverified && onCheckSharing ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-6 px-0 text-xs text-foreground underline underline-offset-3"
          disabled={checking}
          aria-busy={checking || undefined}
          onClick={() => {
            setChecking(true)
            void onCheckSharing(card.pluginId).finally(() => setChecking(false))
          }}
        >
          {checking ? "Checking…" : "Check status"}
        </Button>
      ) : null}
    </div>
  )
}
