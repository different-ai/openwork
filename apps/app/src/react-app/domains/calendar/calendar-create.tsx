/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
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
import { AUTOMATION_CLOUD_DEFAULT_MODEL, type AutomationDetail, type AutomationModel } from "@openwork/types/automations"
import { cloudDefaultModelOption } from "@openwork/types/automation-models"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { automationCreationPlacement } from "@/react-app/domains/automations/automation-availability"
import {
  automationCanUseChoices,
  automationCanUseNote,
  automationPlacementOf,
  initialCanUse,
  type AutomationCanUse,
} from "@/react-app/domains/automations/automation-editor"
import { AutomationModelButton, AutomationModelSummary } from "@/react-app/domains/automations/automation-model-button"
import { automationPickerOptions, type AutomationProviderCatalog } from "@/react-app/domains/automations/automation-model-options"
import type { useAutomationEditorSetup } from "@/react-app/domains/automations/use-automation-editor-setup"
import { describeAutomationError, useAutomationActions, type AutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { ModelPickerModal } from "@/react-app/domains/session/modals/model-picker-modal"

/**
 * "New automation" from an empty slot or the toolbar (Paper: "4c · Calendar — add an automation from an empty
 * slot"). The person says what to do, how it repeats from the slot, what it can use (which decides where it
 * runs, as in the Automations editor) and the model. "More options" opens the full editor with everything filled in.
 */

const CARD_WIDTH = 384
const CARD_HEIGHT = 520

/** Short names for the editor's "What it can use" choices, to fit the card. */
const CAN_USE_SHORT: Record<AutomationCanUse, string> = {
  computer: "This computer",
  "cloud-computer": "Cloud computer",
  accounts: "Accounts only",
}

export type CreateAnchor = { slot: CalendarSlot; x: number; y: number }

export function CreateAutomationCard(props: {
  anchor: CreateAnchor
  context: AutomationsDenContext
  setup: ReturnType<typeof useAutomationEditorSetup>
  providerCatalog?: AutomationProviderCatalog
  workspaceId: string | null
  onOpenProviderSettings?: () => void
  onClose: () => void
  onCreated: (detail: AutomationDetail) => void
}) {
  const navigate = useNavigate()
  const [instructions, setInstructions] = useState("")
  const [repeat, setRepeat] = useState<SlotRepeat>(DEFAULT_SLOT_REPEAT)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState("")
  const { busyAction, setBusyAction, refresh } = useAutomationActions(props.context)
  const field = useRef<HTMLTextAreaElement | null>(null)

  const choices = automationCanUseChoices(props.setup.placementChoices, props.setup.cloudOptions)
  const [chosenCanUse, setChosenCanUse] = useState<AutomationCanUse | null>(null)
  const canUse = chosenCanUse && choices.includes(chosenCanUse) ? chosenCanUse : initialCanUse(automationCreationPlacement(), undefined, choices)
  const placement = automationPlacementOf(canUse)
  const usesCloudDefault = canUse === "accounts"
  const modelOptions = props.setup.modelsFor(placement)
  const [pickedModel, setPickedModel] = useState<AutomationModel | null>(null)
  // Keep the picked model while this place offers it; otherwise the place's first model, as the editor does.
  const model: AutomationModel | null = usesCloudDefault
    ? { ...AUTOMATION_CLOUD_DEFAULT_MODEL, variant: null }
    : pickedModel && modelOptions.some((option) => option.providerId === pickedModel.providerId && option.modelId === pickedModel.modelId)
      ? pickedModel
      : modelOptions[0] ? { providerId: modelOptions[0].providerId, modelId: modelOptions[0].modelId, variant: null } : null
  const pickerOptions = useMemo(
    () => model ? automationPickerOptions({ options: modelOptions, catalog: props.providerCatalog ?? {}, selected: model }) : [],
    [model, modelOptions, props.providerCatalog],
  )

  const options = slotScheduleOptions(props.anchor.slot)
  const chosen = options.find((option) => option.id === repeat) ?? options[0]
  const busy = busyAction === "create"

  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => {
    // The model picker handles its own Escape; the card closes only when it is the top layer.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !pickerOpen) props.onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pickerOpen, props])

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
      const detail = placement === "cloud"
        ? await client.createCloudAutomation(organizationId, { name, schedule: chosen.schedule, action: { kind: "agent", instructions: instructions.trim(), model } })
        : await client.createAutomation(organizationId, {
            name, instructions: instructions.trim(), schedule: chosen.schedule, model,
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
        className="fixed z-50 flex max-h-[calc(100dvh-24px)] flex-col gap-3.5 overflow-y-auto rounded-xl bg-popover p-4 text-popover-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-border"
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
          <p className="text-xs text-muted-foreground">At {formatTime(props.anchor.slot.at, props.anchor.slot.timeZone)} {timeZoneLabel(props.anchor.slot.timeZone, props.anchor.slot.at)}.</p>
        </div>
        {choices.length > 1 ? (
          <div className="flex flex-col gap-1.5" data-calendar-create-runs-on={placement}>
            <span className="text-xs font-medium">What it can use</span>
            <ToggleGroup
              aria-label="What it can use"
              variant="outline"
              spacing={1}
              size="sm"
              className="w-full"
              value={[canUse]}
              onValueChange={(values) => {
                const next = choices.find((choice) => choice === values[0])
                if (next) setChosenCanUse(next)
              }}
            >
              {choices.map((choice) => (
                <ToggleGroupItem key={choice} value={choice} className="flex-1 basis-0 whitespace-nowrap px-1 text-xs data-[pressed]:bg-primary data-[pressed]:text-primary-foreground">{CAN_USE_SHORT[choice]}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">{automationCanUseNote(canUse)}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{automationCanUseNote(canUse)}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Model</span>
          {usesCloudDefault && model ? (
            <div className="flex h-8 items-center rounded-md border border-border px-2 text-sm"><AutomationModelSummary model={model} options={[cloudDefaultModelOption]} size="sm" /></div>
          ) : model ? (
            <AutomationModelButton model={model} options={modelOptions} size="sm" onClick={() => setPickerOpen(true)} />
          ) : (
            <p className="text-xs text-muted-foreground">Add a model in Settings › AI before creating an automation.</p>
          )}
        </div>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="button" variant="link" size="xs" className="mr-auto px-0" onClick={moreOptions}>More options</Button>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!ready}>{busy ? "Creating…" : "Create automation"}</Button>
        </div>
      </form>
      {model && !usesCloudDefault ? (
        <ModelPickerModal
          open={pickerOpen}
          options={pickerOptions}
          query={modelQuery}
          setQuery={setModelQuery}
          subtitle={placement === "cloud" ? "Your cloud computer uses this model and reasoning level." : "Your desktop computer uses this model and reasoning level."}
          target="default"
          current={{ providerID: model.providerId, modelID: model.modelId }}
          onSelect={(next) => {
            setPickedModel({ providerId: next.providerID, modelId: next.modelID, variant: null })
            setPickerOpen(false)
          }}
          onBehaviorChange={(next, variant) => setPickedModel({ providerId: next.providerID, modelId: next.modelID, variant })}
          onOpenSettings={() => { setPickerOpen(false); props.onOpenProviderSettings?.() }}
          onOpenProviderSettings={props.onOpenProviderSettings}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  )
}
