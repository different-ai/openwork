import {
  automationNameFrom,
  describeRunOutcome,
  describeSchedule,
  DEFAULT_SLOT_REPEAT,
  formatDate,
  formatInstant,
  formatTime,
  runPlacement,
  slotAt,
  slotLabel,
  slotScheduleOptions,
  addDays,
  type AutomationCalendarItem,
  type CalendarEvent,
  type CalendarSlot,
  type SlotRepeat,
} from "@openwork/calendar"
import type { AutomationList, AutomationModel, AutomationRun, AutomationSchedule } from "@openwork/types/automations"
import { CLOUD_DEFAULT_MODEL, useAutomationModels, useAutomationRuns, useCalendarAction, useCreateAutomation, useRunReceipt, type AutomationChanges } from "@openwork-ee/workbot-client/calendar"
import { Check, ChevronLeft, ChevronRight, Cloud, Lock, Minus, Monitor, X } from "lucide-react-native"
import { useState, type ReactNode } from "react"
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { IconButton, QuietButton } from "../ui/controls"
import { color } from "../theme"
import { modelLabel, ModelPicker } from "./model-picker"

export type ListItem = AutomationList["items"][number]

/** A sheet over the Calendar: a title, a close button, and its content. */
export function Sheet({ visible, title, onClose, children, footer }: { visible: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.head}>
          <Text accessibilityRole="header" numberOfLines={2} style={styles.headTitle}>{title}</Text>
          <IconButton label="Close" onPress={onClose}><X size={16} strokeWidth={2} color={color.muted} /></IconButton>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </Modal>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{typeof children === "string" ? <Text style={styles.rowText}>{children}</Text> : children}</View>
    </View>
  )
}

function Action({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, primary ? styles.actionPrimary : null, disabled ? styles.disabled : null, pressed ? styles.pressed : null]}>
      <Text style={[styles.actionText, primary ? styles.actionPrimaryText : null]}>{label}</Text>
    </Pressable>
  )
}

const shortDate = (instant: number, zone: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone }).format(new Date(instant))

function PastRun({ run, zone }: { run: AutomationRun; zone: string }) {
  const [open, setOpen] = useState(false)
  const receipt = useRunReceipt(open ? run.id : null)
  const detail = receipt.data?.run.resultSummary ?? receipt.data?.run.error?.message ?? null
  return (
    <View>
      <View style={styles.runRow}>
        {run.status === "succeeded" ? <Check size={13} color="#30A46C" /> : run.status === "failed" ? <X size={13} color={color.danger} /> : <Minus size={13} color={color.muted} />}
        <Text style={styles.runDate}>{shortDate(runPlacement(run), zone)}</Text>
        <Text numberOfLines={1} style={styles.runOutcome}>{describeRunOutcome(run)}</Text>
        <QuietButton label={open ? "Close" : "Open"} onPress={() => setOpen((value) => !value)} />
      </View>
      {open ? <Text style={styles.receipt}>{receipt.isLoading ? "Loading…" : detail ?? "No result was recorded for this run."}</Text> : null}
    </View>
  )
}

/** Where it runs, read-only: Workbot creates and keeps Automations in the cloud; desktop ones move from the app. */
function RunsOnCard({ target }: { target: "desktop" | "cloud" }) {
  return (
    <View style={styles.runsOn}>
      {target === "cloud" ? <Cloud size={15} strokeWidth={1.75} color={color.ink} /> : <Monitor size={15} strokeWidth={1.75} color={color.ink} />}
      <View style={styles.runsOnText}>
        <Text style={styles.runsOnTitle}>{target === "cloud" ? "Cloud: Only connected accounts" : "Desktop: Connected accounts and files on your computer"}</Text>
        <Text style={styles.runsOnBody}>{target === "cloud" ? "Runs in the cloud, even when your computer is off." : "Needs OpenWork open on one of your computers. Move it to the cloud from the OpenWork app."}</Text>
      </View>
    </View>
  )
}

const WEEKDAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]] as const

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.segmented}>
      {options.map((option) => (
        <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: value === option.id }} onPress={() => onChange(option.id)} style={[styles.segment, value === option.id ? styles.segmentOn : null]}>
          <Text style={[styles.segmentText, value === option.id ? styles.segmentTextOn : null]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

/** Hour and minute, half an hour at a time. */
function TimeStepper({ hour, minute, onChange }: { hour: number; minute: number; onChange: (hour: number, minute: number) => void }) {
  const total = hour * 60 + minute
  const set = (minutes: number) => {
    const next = (minutes + 24 * 60) % (24 * 60)
    onChange(Math.floor(next / 60), next % 60)
  }
  const label = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, hour, minute)))
  return (
    <View style={styles.stepper}>
      <IconButton label="Earlier" onPress={() => set(total - 30)}><ChevronLeft size={16} color={color.muted} /></IconButton>
      <Text style={styles.stepperText}>{label}</Text>
      <IconButton label="Later" onPress={() => set(total + 30)}><ChevronRight size={16} color={color.muted} /></IconButton>
    </View>
  )
}

function ScheduleFields({ draft, setDraft }: { draft: AutomationSchedule; setDraft: (schedule: AutomationSchedule) => void }) {
  const setKind = (kind: "daily" | "weekly") => {
    const hour = draft.kind === "once" ? 9 : draft.hour
    const minute = draft.kind === "once" ? 0 : draft.minute
    setDraft(kind === "daily" ? { kind, timezone: draft.timezone, hour, minute } : { kind, timezone: draft.timezone, hour, minute, daysOfWeek: draft.kind === "weekly" ? draft.daysOfWeek : [1, 2, 3, 4, 5] })
  }
  return (
    <View style={styles.fields}>
      {draft.kind === "once" ? <Text style={styles.note}>This runs once, {formatInstant(draft.at, draft.timezone)}. Change it to repeat:</Text> : null}
      <Segmented label="Repeats" value={draft.kind === "weekly" ? "weekly" : draft.kind === "daily" ? "daily" : ("" as "daily")} options={[{ id: "daily", label: "Every day" }, { id: "weekly", label: "Some days" }]} onChange={setKind} />
      {draft.kind === "weekly" ? (
        <View style={styles.days}>
          {WEEKDAYS.map(([label, value]) => {
            const on = draft.daysOfWeek.includes(value)
            return (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  const days = on ? draft.daysOfWeek.filter((day) => day !== value) : [...draft.daysOfWeek, value].sort((left, right) => left - right)
                  if (days.length > 0) setDraft({ ...draft, daysOfWeek: days })
                }}
                style={[styles.day, on ? styles.dayOn : null]}
              >
                <Text style={[styles.dayText, on ? styles.dayTextOn : null]}>{label}</Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}
      {draft.kind !== "once" ? (
        <TimeStepper hour={draft.hour} minute={draft.minute} onChange={(hour, minute) => setDraft({ ...draft, hour, minute })} />
      ) : null}
      <Text style={styles.note}>Time zone: {draft.timezone}</Text>
    </View>
  )
}

/** Edit an Automation: what it does, when it repeats, and its model. Only what changed is sent. */
function EditSheet({ item, canSchedule, visible, busy, onClose, onSave }: { item: ListItem; canSchedule: boolean; visible: boolean; busy: boolean; onClose: () => void; onSave: (changes: AutomationChanges) => void }) {
  const { revision } = item
  const target = revision.executionTarget ?? "desktop"
  const agent = revision.action?.kind !== "saved_script"
  const { models, isLoading } = useAutomationModels({ includeCloudDefault: target === "cloud" && canSchedule })
  const [schedule, setSchedule] = useState<AutomationSchedule>(revision.schedule)
  const [instructions, setInstructions] = useState(revision.instructions)
  const [model, setModel] = useState<AutomationModel>(revision.model)
  const changes: AutomationChanges = {
    ...(JSON.stringify(schedule) !== JSON.stringify(revision.schedule) ? { schedule } : {}),
    ...(agent && instructions.trim() !== revision.instructions ? { instructions: instructions.trim() } : {}),
    ...(agent && (model.providerId !== revision.model.providerId || model.modelId !== revision.model.modelId) ? { model } : {}),
  }
  const changed = Object.keys(changes).length > 0
  return (
    <Sheet
      visible={visible}
      title="Edit automation"
      onClose={onClose}
      footer={
        <View style={styles.actions}>
          <Action label="Cancel" onPress={onClose} />
          <Action label={busy ? "Saving…" : "Save changes"} primary disabled={busy || !changed || (agent && !instructions.trim())} onPress={() => (changed ? onSave(changes) : onClose())} />
        </View>
      }
    >
      {agent ? (
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Instructions</Text>
          <TextInput value={instructions} onChangeText={setInstructions} multiline maxLength={100_000} accessibilityLabel="Instructions" style={styles.textArea} />
        </View>
      ) : null}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Repeats</Text>
        <ScheduleFields draft={schedule} setDraft={setSchedule} />
      </View>
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Where it runs</Text>
        <RunsOnCard target={target} />
      </View>
      {agent ? (
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Model</Text>
          <ModelPicker value={model} options={models} loading={isLoading} onChange={setModel} />
        </View>
      ) : null}
    </Sheet>
  )
}

/** One Automation: when it runs next, how it repeats, where, its model and instructions, past runs, and its actions. */
export function AutomationSheet({ item, block, zone, canSchedule, onClose, onToast }: { item: ListItem | null; block: AutomationCalendarItem | null; zone: string; canSchedule: boolean; onClose: () => void; onToast: (text: string) => void }) {
  const runs = useAutomationRuns(item?.automation.id ?? null)
  const action = useCalendarAction()
  const [editing, setEditing] = useState(false)
  const { models } = useAutomationModels({ includeCloudDefault: (item?.revision.executionTarget ?? "desktop") === "cloud" })
  if (!item) return null
  const { automation, revision } = item
  const blocked = automation.state === "needs_attention"
  const when = block?.run ? formatInstant(runPlacement(block.run), zone) : block ? formatInstant(block.at, zone) : automation.nextDueAt ? formatInstant(automation.nextDueAt, zone) : null
  const run = (kind: "pause" | "resume" | "run", done: string) => action.mutate({ kind, automationId: automation.id }, { onSuccess: () => onToast(done), onError: (error) => onToast(error.message) })
  return (
    <Sheet
      visible
      title={automation.name}
      onClose={onClose}
      footer={
        <View style={styles.actions}>
          {automation.state === "inactive" ? <Action label="Resume" disabled={action.isPending} onPress={() => run("resume", "Resumed")} /> : <Action label="Pause" disabled={action.isPending || automation.state !== "active"} onPress={() => run("pause", "Paused")} />}
          <Action label="Edit" disabled={action.isPending} onPress={() => setEditing(true)} />
          <Action label="Run now" primary disabled={action.isPending || blocked} onPress={() => run("run", "Running now")} />
        </View>
      }
    >
      <Text style={styles.when}>{blocked ? "Not scheduled until fixed" : automation.state === "inactive" ? "Paused" : when ?? "No run scheduled"}</Text>
      {blocked && automation.needsAttentionReason ? (
        <View style={styles.blocked}>
          <View style={styles.blockedMark}><Lock size={13} color={color.muted} /></View>
          <Text style={styles.blockedText}>{automation.needsAttentionReason.message}</Text>
        </View>
      ) : null}
      <View style={styles.rows}>
        <Row label="Repeats">{describeSchedule(revision.schedule, "", "en-US")}</Row>
        <Row label="Runs on">{(revision.executionTarget ?? "desktop") === "cloud" ? "The cloud. Your laptop can be closed." : "Your desktop. Keep OpenWork open at that time."}</Row>
        {revision.action?.kind === "saved_script" ? null : (
          <>
            <Row label="Model">{modelLabel(revision.model, models)}</Row>
            <Row label="Instructions">{revision.instructions}</Row>
          </>
        )}
      </View>
      <Text style={styles.section}>Past runs</Text>
      {runs.data && runs.data.items.length === 0 ? <Text style={styles.note}>No runs yet.</Text> : null}
      {runs.data?.items.slice(0, 5).map((entry) => <PastRun key={entry.id} run={entry} zone={zone} />)}
      {editing ? (
        <EditSheet
          item={item}
          canSchedule={canSchedule}
          visible={editing}
          busy={action.isPending}
          onClose={() => setEditing(false)}
          onSave={(changes) => action.mutate({ kind: "edit", automationId: automation.id, changes }, {
            onSuccess: () => {
              setEditing(false)
              onToast("Automation updated")
            },
            onError: (error) => onToast(error.message),
          })}
        />
      ) : null}
    </Sheet>
  )
}

/** A meeting from the person's connected calendar: when, where, who, and the ways to open it. */
export function MeetingSheet({ event, zone, onClose }: { event: CalendarEvent | null; zone: string; onClose: () => void }) {
  if (!event) return null
  const source = event.provider === "google" ? "Google Calendar" : "Outlook Calendar"
  const when = event.timing.kind === "timed" ? `${formatInstant(event.timing.start, zone)} – ${formatTime(event.timing.end, zone)}` : `${formatDate(event.timing.startDate, "en-US")} · All day`
  return (
    <Sheet
      visible
      title={event.title}
      onClose={onClose}
      footer={event.meetingUrl || event.sourceUrl ? (
        <View style={styles.actions}>
          {event.meetingUrl ? <Action label="Join" onPress={() => void Linking.openURL(event.meetingUrl ?? "")} /> : null}
          {event.sourceUrl ? <Action label={`Open in ${source}`} primary onPress={() => void Linking.openURL(event.sourceUrl ?? "")} /> : null}
        </View>
      ) : undefined}
    >
      <Text style={styles.when}>{when}</Text>
      <View style={styles.rows}>
        <Row label="From">{source}</Row>
        {event.location ? <Row label="Where">{event.location}</Row> : null}
        {event.attendeeCount > 0 ? <Row label="Guests">{String(event.attendeeCount)}</Row> : null}
      </View>
    </Sheet>
  )
}

/** "New automation": what to do, when (from the slot), how it repeats, and the model. It always runs in the cloud. */
export function CreateSheet({ slot: initial, canSchedule, assistantName, onClose, onCreated }: { slot: CalendarSlot; canSchedule: boolean; assistantName: string; onClose: () => void; onCreated: (automationId: string) => void }) {
  const [slot, setSlot] = useState(initial)
  const [instructions, setInstructions] = useState("")
  const [repeat, setRepeat] = useState<SlotRepeat>(DEFAULT_SLOT_REPEAT)
  const { models, isLoading } = useAutomationModels({ includeCloudDefault: canSchedule })
  const [model, setModel] = useState<AutomationModel>(CLOUD_DEFAULT_MODEL)
  const create = useCreateAutomation()
  const options = slotScheduleOptions(slot)
  const schedule = options.find((option) => option.id === repeat)?.schedule ?? options[0]?.schedule
  const move = (days: number, minutes: number) => setSlot(slotAt(addDays(slot.date, days), slot.hour * 60 + slot.minute + minutes, slot.timeZone))
  if (!canSchedule) {
    return (
      <Sheet visible title="New automation" onClose={onClose}>
        <Text style={styles.note}>Your organization doesn't run Automations in the cloud yet, so {assistantName} can't create one here. An admin can turn it on.</Text>
      </Sheet>
    )
  }
  return (
    <Sheet
      visible
      title="New automation"
      onClose={onClose}
      footer={
        <View style={styles.actions}>
          <Action label="Cancel" onPress={onClose} />
          <Action
            label={create.isPending ? "Creating…" : "Create"}
            primary
            disabled={create.isPending || !instructions.trim() || !schedule}
            onPress={() => {
              if (!schedule) return
              create.mutate({ name: automationNameFrom(instructions), instructions: instructions.trim(), schedule, model }, { onSuccess: (detail) => onCreated(detail.automation.id) })
            }}
          />
        </View>
      }
    >
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>What should {assistantName} do?</Text>
        <TextInput value={instructions} onChangeText={setInstructions} multiline placeholder="Summarize my unread email and post the highlights in Slack." placeholderTextColor={color.faint} accessibilityLabel="What it should do" style={styles.textArea} />
      </View>
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Starts</Text>
        <View style={styles.slotRow}>
          <IconButton label="A day earlier" onPress={() => move(-1, 0)}><ChevronLeft size={16} color={color.muted} /></IconButton>
          <Text style={styles.slotText}>{slotLabel(slot)}</Text>
          <IconButton label="A day later" onPress={() => move(1, 0)}><ChevronRight size={16} color={color.muted} /></IconButton>
        </View>
        <TimeStepper hour={slot.hour} minute={slot.minute} onChange={(hour, minute) => setSlot(slotAt(slot.date, hour * 60 + minute, slot.timeZone))} />
      </View>
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Repeats</Text>
        <View style={styles.days}>
          {options.map((option) => (
            <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: repeat === option.id }} onPress={() => setRepeat(option.id)} style={[styles.day, repeat === option.id ? styles.dayOn : null]}>
              <Text style={[styles.dayText, repeat === option.id ? styles.dayTextOn : null]}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Model</Text>
        <ModelPicker value={model} options={models} loading={isLoading} onChange={setModel} />
      </View>
      <RunsOnCard target="cloud" />
      {create.isError ? <Text style={styles.error}>{create.error.message}</Text> : null}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.surface },
  head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 8 },
  headTitle: { flex: 1, fontSize: 18, fontWeight: "600", lineHeight: 23, letterSpacing: -0.3, color: color.text },
  content: { paddingHorizontal: 20, paddingBottom: 20, gap: 12 },
  footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  when: { fontSize: 13, color: color.muted },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  row: { flexDirection: "row", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  rowLabel: { width: 96, fontSize: 12, color: color.muted, paddingTop: 1 },
  rowValue: { flex: 1 },
  rowText: { fontSize: 13.5, lineHeight: 19, color: color.text },
  section: { marginTop: 8, fontSize: 12, fontWeight: "600", color: color.text },
  note: { fontSize: 13, lineHeight: 19, color: color.muted },
  runRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36 },
  runDate: { width: 64, fontSize: 13, color: color.text },
  runOutcome: { flex: 1, fontSize: 12, color: color.muted },
  receipt: { marginLeft: 23, marginBottom: 8, padding: 10, borderRadius: 8, backgroundColor: color.tray, fontSize: 12, lineHeight: 17, color: color.text },
  blocked: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 12, borderRadius: 10, backgroundColor: color.tray },
  blockedMark: { height: 18, justifyContent: "center" },
  blockedText: { flex: 1, fontSize: 13, lineHeight: 18, color: color.text },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1, height: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", boxShadow: "0 0 0 1px #0116271F" },
  actionPrimary: { backgroundColor: color.ink, boxShadow: "none" },
  actionText: { fontSize: 14, fontWeight: "500", color: color.text },
  actionPrimaryText: { color: color.onInk },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  fields: { gap: 10 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: "500", color: color.text },
  textArea: { minHeight: 96, padding: 12, borderRadius: 10, backgroundColor: color.surface, fontSize: 14, lineHeight: 20, color: color.text, textAlignVertical: "top", boxShadow: "inset 0 0 0 1px #0116271F" },
  segmented: { flexDirection: "row", padding: 2, borderRadius: 10, backgroundColor: color.chip },
  segment: { flex: 1, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  segmentOn: { backgroundColor: color.surface, boxShadow: "0 1px 2px #0116271A" },
  segmentText: { fontSize: 13, fontWeight: "500", color: color.muted },
  segmentTextOn: { fontWeight: "600", color: color.text },
  days: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  day: { height: 34, paddingHorizontal: 12, borderRadius: 8, justifyContent: "center", boxShadow: "0 0 0 1px #0116271F" },
  dayOn: { backgroundColor: color.ink, boxShadow: "none" },
  dayText: { fontSize: 13, fontWeight: "500", color: color.text },
  dayTextOn: { color: color.onInk },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 44, paddingHorizontal: 4, borderRadius: 10, boxShadow: "inset 0 0 0 1px #0116271F" },
  stepperText: { fontSize: 15, fontWeight: "500", color: color.text, fontVariant: ["tabular-nums"] },
  slotRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  slotText: { fontSize: 14, fontWeight: "500", color: color.text },
  runsOn: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: 10, boxShadow: "inset 0 0 0 1px #0116271A" },
  runsOnText: { flex: 1, gap: 2 },
  runsOnTitle: { fontSize: 13, fontWeight: "500", color: color.text },
  runsOnBody: { fontSize: 12, lineHeight: 16, color: color.muted },
  error: { fontSize: 13, color: color.danger },
})
