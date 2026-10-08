/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import {
  automationNameFrom,
  DEFAULT_SLOT_REPEAT,
  formatTime,
  slotLabel,
  slotScheduleOptions,
  timeZoneLabel,
  type CalendarSlot,
  type SlotRepeat,
} from "@openwork/calendar"
import type { AutomationDetail, AutomationExecutionTarget } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { automationCreationPlacement } from "@/react-app/domains/automations/automation-availability"
import {
  describeAutomationError,
  useAutomationActions,
  useAutomationModelChoices,
  type AutomationsDenContext,
} from "@/react-app/domains/automations/use-automations"

/**
 * "New automation" from an empty slot or the toolbar (Paper: "4c · Calendar — add an automation from an empty
 * slot"). The person says what to do and how it repeats from the slot. It runs where this surface creates
 * Automations (this computer on desktop, the cloud on the web) with the editor's default model; "More options"
 * opens the full editor with everything filled in.
 */

const CARD_WIDTH = 368
const CARD_HEIGHT = 380

export type CreateAnchor = { slot: CalendarSlot; x: number; y: number }

export function CreateAutomationCard(props: {
  anchor: CreateAnchor
  context: AutomationsDenContext
  workspaceId: string | null
  onClose: () => void
  onCreated: (detail: AutomationDetail) => void
}) {
  const navigate = useNavigate()
  const [instructions, setInstructions] = useState("")
  const [repeat, setRepeat] = useState<SlotRepeat>(DEFAULT_SLOT_REPEAT)
  const [error, setError] = useState<string | null>(null)
  const { busyAction, setBusyAction, refresh } = useAutomationActions(props.context)
  const models = useAutomationModelChoices(props.context)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const placement: AutomationExecutionTarget = automationCreationPlacement()
  const model = (placement === "cloud" ? models.cloud : models.desktop)[0] ?? null
  const options = slotScheduleOptions(props.anchor.slot)
  const chosen = options.find((option) => option.id === repeat) ?? options[0]
  const busy = busyAction === "create"

  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [props])

  const left = Math.max(12, Math.min(props.anchor.x, window.innerWidth - CARD_WIDTH - 12))
  const top = Math.max(12, Math.min(props.anchor.y, window.innerHeight - CARD_HEIGHT - 12))
  const ready = instructions.trim().length > 0 && Boolean(model) && !busy

  const submit = async () => {
    const { client, organizationId } = props.context
    if (!ready || !chosen || !model || !client || !organizationId) return
    setBusyAction("create")
    setError(null)
    try {
      const name = automationNameFrom(instructions)
      const definition = { kind: "agent" as const, instructions: instructions.trim(), model: { providerId: model.providerId, modelId: model.modelId, variant: null } }
      const detail = placement === "cloud"
        ? await client.createCloudAutomation(organizationId, { name, schedule: chosen.schedule, action: definition })
        : await client.createAutomation(organizationId, {
            name, instructions: definition.instructions, schedule: chosen.schedule, model: definition.model,
            // Pinned to the workspace it was created from, as the Automations editor does.
            ...(isDesktopRuntime() && props.workspaceId ? { workspaceId: props.workspaceId } : {}),
          })
      await refresh()
      props.onCreated(detail)
    } catch (caught) {
      setError(describeAutomationError(caught))
    } finally {
      setBusyAction(null)
    }
  }

  const moreOptions = () => {
    const params = new URLSearchParams({ create: "1", name: automationNameFrom(instructions), instructions: instructions.trim() })
    if (chosen) params.set("schedule", JSON.stringify(chosen.schedule))
    navigate(`/automations?${params.toString()}`)
  }

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={props.onClose} />
      <form
        role="dialog"
        aria-label="New automation"
        data-calendar-create
        className="fixed z-50 flex flex-col gap-3.5 rounded-xl bg-popover p-4 text-popover-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-border"
        style={{ left, top, width: CARD_WIDTH }}
        onSubmit={(event) => { event.preventDefault(); void submit() }}
      >
        <div>
          <p className="text-xs text-muted-foreground">{slotLabel(props.anchor.slot)}</p>
          <h2 className="text-[15px] font-semibold tracking-[-0.2px]">New automation</h2>
        </div>
        <label className="flex flex-col gap-1.5 text-xs font-medium">
          What should it do?
          <Textarea
            ref={field}
            value={instructions}
            rows={3}
            maxLength={100_000}
            placeholder="Pull this week's press kit comments from Notion and draft a reply list"
            className="min-h-18 resize-none text-sm font-normal"
            onChange={(event) => setInstructions(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() } }}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Repeats</span>
          <ToggleGroup
            aria-label="Repeats"
            variant="outline"
            spacing={1}
            size="sm"
            className="w-full"
            value={[repeat]}
            onValueChange={(values) => {
              const next = options.find((option) => option.id === values[0])
              if (next) setRepeat(next.id)
            }}
          >
            {options.map((option) => (
              <ToggleGroupItem key={option.id} value={option.id} className="flex-1 basis-0 whitespace-nowrap px-1 text-xs data-[pressed]:bg-primary data-[pressed]:text-primary-foreground">{option.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {model
              ? `At ${formatTime(props.anchor.slot.at, props.anchor.slot.timeZone)} ${timeZoneLabel(props.anchor.slot.timeZone, props.anchor.slot.at)}. ${placement === "cloud" ? "Runs in the cloud." : "Runs on this computer; keep OpenWork open."}`
              : "Add a model in Settings › AI before creating an automation."}
          </p>
        </div>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="button" variant="link" size="xs" className="mr-auto px-0" onClick={moreOptions}>More options</Button>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!ready}>{busy ? "Creating…" : "Create automation"}</Button>
        </div>
      </form>
    </>
  )
}
