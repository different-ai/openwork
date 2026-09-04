/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react"
import { AUTOMATION_FREE_MODEL, type AutomationExecutionTarget, type AutomationSchedule, type CreateAutomation } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ChevronDown } from "lucide-react"

import { ModelPickerModal } from "@/react-app/domains/session/modals/model-picker-modal"
import type { AutomationModelOption, AutomationProviderCatalog } from "./automation-model-options"
import { automationPickerOptions, describeAutomationModel } from "./automation-model-options"

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function tomorrowAtNine() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}

function toLocalDateTime(value: number) {
  const date = new Date(value)
  const component = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${component(date.getMonth() + 1)}-${component(date.getDate())}T${component(date.getHours())}:${component(date.getMinutes())}`
}

function defaultInput(modelOptions: readonly AutomationModelOption[]): CreateAutomation {
  const first = modelOptions[0] ?? AUTOMATION_FREE_MODEL
  return {
    name: "",
    instructions: "",
    schedule: { kind: "daily", timezone: localTimezone(), hour: 9, minute: 0 },
    model: { providerId: first.providerId, modelId: first.modelId, variant: null },
  }
}

function modelKey(model: { providerId: string; modelId: string }) {
  return `${encodeURIComponent(model.providerId)}:${encodeURIComponent(model.modelId)}`
}

function timeForSchedule(schedule: AutomationSchedule) {
  if (schedule.kind === "once") return { hour: 9, minute: 0 }
  return { hour: schedule.hour, minute: schedule.minute }
}

/** A Workflow version the Automation is pinned to instead of free-form instructions and a model. */
export type AutomationEditorPinnedWorkflow = {
  title: string
  configObjectVersionId: string
}

export type AutomationEditorProps = {
  initial?: CreateAutomation | null
  initialKey?: string
  /** Fixed by the creating surface; changes the copy, never a control. */
  placement: AutomationExecutionTarget
  pinnedWorkflow?: AutomationEditorPinnedWorkflow
  modelOptions: readonly AutomationModelOption[]
  providerCatalog?: AutomationProviderCatalog
  busy: boolean
  openModelPickerOnMount?: boolean
  submitLabel: string
  onCancel: () => void
  onSave: (input: CreateAutomation) => Promise<void> | void
}

export function AutomationEditor(props: AutomationEditorProps) {
  const [input, setInput] = useState<CreateAutomation>(() => props.initial ?? defaultInput(props.modelOptions))
  const [pickerOpen, setPickerOpen] = useState(props.openModelPickerOnMount === true)
  const appliedInitialKey = useRef(props.initialKey)

  useEffect(() => {
    if (props.initial) {
      if (appliedInitialKey.current === props.initialKey) return
      appliedInitialKey.current = props.initialKey
      setInput(props.initial)
      return
    }
    setInput(defaultInput(props.modelOptions))
  }, [props.initial, props.initialKey, props.modelOptions])

  useEffect(() => {
    if (props.openModelPickerOnMount) setPickerOpen(true)
  }, [props.openModelPickerOnMount])

  const [modelQuery, setModelQuery] = useState("")
  const selectedModel = modelKey(input.model)
  const currentModelAvailable = props.modelOptions.some((option) => modelKey(option) === selectedModel)
  const modelLabel = describeAutomationModel(input.model, props.modelOptions)
  const pickerOptions = useMemo(
    () => automationPickerOptions({
      options: props.modelOptions,
      catalog: props.providerCatalog ?? {},
      selected: input.model,
    }),
    [input.model, props.modelOptions, props.providerCatalog],
  )
  const pinnedWorkflow = props.pinnedWorkflow
  const cloud = props.placement === "cloud"
  const canSave = useMemo(
    () => input.name.trim().length > 0
      && (pinnedWorkflow !== undefined || (input.instructions.trim().length > 0 && currentModelAvailable)),
    [currentModelAvailable, input.instructions, input.name, pinnedWorkflow],
  )
  const time = timeForSchedule(input.schedule)

  const changeScheduleKind = (kind: AutomationSchedule["kind"]) => {
    const timezone = input.schedule.timezone
    if (kind === "once") {
      setInput((current) => ({ ...current, schedule: { kind, timezone, at: tomorrowAtNine() } }))
      return
    }
    if (kind === "daily") {
      setInput((current) => ({ ...current, schedule: { kind, timezone, hour: time.hour, minute: time.minute } }))
      return
    }
    setInput((current) => ({
      ...current,
      schedule: { kind, timezone, daysOfWeek: [1, 2, 3, 4, 5], hour: time.hour, minute: time.minute },
    }))
  }

  const changeTime = (value: string) => {
    const [hour, minute] = value.split(":").map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return
    setInput((current) => current.schedule.kind === "once" ? current : {
      ...current,
      schedule: { ...current.schedule, hour, minute },
    })
  }

  const toggleWeekday = (day: number) => {
    setInput((current) => {
      if (current.schedule.kind !== "weekly") return current
      const selected = current.schedule.daysOfWeek.includes(day)
      const daysOfWeek = selected
        ? current.schedule.daysOfWeek.filter((value) => value !== day)
        : [...current.schedule.daysOfWeek, day].sort((left, right) => left - right)
      if (daysOfWeek.length === 0) return current
      return { ...current, schedule: { ...current.schedule, daysOfWeek } }
    })
  }

  return (
    <form
      className="space-y-5"
      data-automation-editor
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave && !props.busy) void props.onSave(input)
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="automation-name">Name</Label>
        <Input
          id="automation-name"
          value={input.name}
          maxLength={120}
          required
          placeholder="Daily project summary"
          onChange={(event) => {
            const name = event.currentTarget.value
            setInput((current) => ({ ...current, name }))
          }}
        />
      </div>

      {pinnedWorkflow ? (
        <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm" data-automation-pinned-workflow={pinnedWorkflow.configObjectVersionId}>
          <p className="font-medium">Pinned Workflow</p>
          <p className="mt-1 text-muted-foreground">{pinnedWorkflow.title}</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Version {pinnedWorkflow.configObjectVersionId}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="automation-instructions">Instructions</Label>
          <Textarea
            id="automation-instructions"
            className="min-h-36 resize-y"
            value={input.instructions}
            required
            placeholder="Describe the outcome, sources to check, and what a useful result should include."
            onChange={(event) => {
              const instructions = event.currentTarget.value
              setInput((current) => ({ ...current, instructions }))
            }}
          />
          <p className="text-xs text-muted-foreground">{cloud ? "Each run starts a fresh task in your OpenWork Cloud runtime." : "Each claimed run starts a fresh task in your desktop OpenCode runtime."}</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="automation-frequency">Schedule</Label>
          <select
            id="automation-frequency"
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
            value={input.schedule.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value
              if (kind === "once" || kind === "daily" || kind === "weekly") changeScheduleKind(kind)
            }}
          >
            <option value="once">Once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        {input.schedule.kind === "once" ? (
          <div className="space-y-2">
            <Label htmlFor="automation-once-at">Run at</Label>
            <Input
              id="automation-once-at"
              type="datetime-local"
              value={toLocalDateTime(input.schedule.at)}
              onChange={(event) => {
                const at = new Date(event.currentTarget.value).getTime()
                if (Number.isFinite(at)) setInput((current) => ({
                  ...current,
                  schedule: { kind: "once", timezone: current.schedule.timezone, at },
                }))
              }}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="automation-time">Time</Label>
            <Input
              id="automation-time"
              type="time"
              value={`${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`}
              onChange={(event) => changeTime(event.currentTarget.value)}
            />
          </div>
        )}
      </div>

      {input.schedule.kind === "weekly" ? (
        <div className="space-y-2">
          <Label>Days</Label>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <Button
                key={day.value}
                type="button"
                size="sm"
                variant={input.schedule.kind === "weekly" && input.schedule.daysOfWeek.includes(day.value) ? "secondary" : "outline"}
                onClick={() => toggleWeekday(day.value)}
              >
                {day.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="automation-timezone">Timezone</Label>
          <Input
            id="automation-timezone"
            value={input.schedule.timezone}
            onChange={(event) => {
              const timezone = event.currentTarget.value
              setInput((current) => ({ ...current, schedule: { ...current.schedule, timezone } }))
            }}
          />
        </div>
        {pinnedWorkflow ? null : <div className="space-y-2">
          <Label htmlFor="automation-model">Model</Label>
          <Button
            id="automation-model"
            type="button"
            variant="outline"
            className="h-9 w-full justify-between gap-2 font-normal"
            onClick={() => setPickerOpen(true)}
          >
            <span className="min-w-0 truncate">
              {currentModelAvailable ? modelLabel : "Current model is no longer available"}
            </span>
            <ChevronDown className="size-4 shrink-0 opacity-60" />
          </Button>
          <ModelPickerModal
            open={pickerOpen}
            options={pickerOptions}
            query={modelQuery}
            setQuery={setModelQuery}
            subtitle={cloud ? "Runs use this model and reasoning level in your OpenWork Cloud runtime." : "Runs use this model and reasoning level in your desktop runtime."}
            target="default"
            current={{ providerID: input.model.providerId, modelID: input.model.modelId }}
            onSelect={(model) => {
              setInput((current) => ({
                ...current,
                // A different model has its own reasoning levels, so the old
                // variant cannot carry over.
                model: { providerId: model.providerID, modelId: model.modelID, variant: null },
              }))
              setPickerOpen(false)
            }}
            onBehaviorChange={(model, variant) => setInput((current) => ({
              ...current,
              model: { providerId: model.providerID, modelId: model.modelID, variant },
            }))}
            onOpenSettings={() => setPickerOpen(false)}
            onClose={() => setPickerOpen(false)}
          />
        </div>}
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm text-muted-foreground" data-automation-placement={props.placement}>
        {cloud
          ? "Den keeps the schedule and run history. Each occurrence runs headlessly in OpenWork Cloud, even while your desktop is offline; a stopped Cloud container wakes automatically."
          : "Den keeps the schedule and run history. Your signed-in desktop claims each occurrence and executes it with the selected model in its local OpenCode runtime. If the desktop is unavailable before the claim deadline, the occurrence is recorded as missed."}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
        <Button type="submit" disabled={!canSave || props.busy}>{props.busy ? "Saving…" : props.submitLabel}</Button>
      </div>
    </form>
  )
}
