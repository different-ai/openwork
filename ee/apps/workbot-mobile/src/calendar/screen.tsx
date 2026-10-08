import {
  addDays,
  buildAutomationCalendarItems,
  calendarRange,
  compareDates,
  dateKey,
  formatDate,
  formatRangeLabel,
  formatTime,
  localDateOf,
  nextOpenSlot,
  shiftAnchor,
  startOfDay,
  zonedParts,
  type AutomationCalendarItem,
  type CalendarConnectionError,
  type CalendarEvent,
  type CalendarProviderId,
  type CalendarSlot,
  type LocalDate,
} from "@openwork/calendar"
import { useMeetingsQuery, useRunsInRangeQuery } from "@openwork/calendar/react"
import type { WorkbotMe } from "@openwork-ee/workbot-client"
import { calendarKey, useCalendarSources, useWorkbotAutomations } from "@openwork-ee/workbot-client/calendar"
import { Check, ChevronLeft, ChevronRight, Cloud, Lock, Monitor, Plus, X } from "lucide-react-native"
import { useEffect, useMemo, useState } from "react"
import { Linking, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { WorkbotHeader } from "../chat/header"
import { QuietButton } from "../ui/controls"
import { color } from "../theme"
import { AutomationSheet, CreateSheet, MeetingSheet } from "./sheets"

/**
 * Workbot's Calendar on a phone: the person's Automations next to their meetings, a day or a week at a time, with the
 * same details, actions and edits as on the web. Times are in the phone's time zone.
 */

const PROVIDERS: readonly CalendarProviderId[] = ["google", "microsoft"]
const zoneOf = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

type Entry =
  | { key: string; start: number; kind: "automation"; item: AutomationCalendarItem }
  | { key: string; start: number; kind: "meeting"; event: CalendarEvent }
  | { key: string; start: number; kind: "all-day"; event: CalendarEvent }

function entriesForDay(day: LocalDate, zone: string, automations: readonly AutomationCalendarItem[], meetings: readonly CalendarEvent[]): Entry[] {
  const dayStart = startOfDay(day, zone)
  const dayEnd = startOfDay(addDays(day, 1), zone)
  const entries: Entry[] = []
  for (const event of meetings) {
    if (event.timing.kind === "all_day") {
      if (compareDates(event.timing.startDate, day) <= 0 && compareDates(event.timing.endDate, day) > 0) entries.push({ key: `${event.key}:${dateKey(day)}`, start: dayStart - 1, kind: "all-day", event })
      continue
    }
    if (event.timing.end <= dayStart || event.timing.start >= dayEnd) continue
    entries.push({ key: event.key, start: Math.max(event.timing.start, dayStart), kind: "meeting", event })
  }
  for (const item of automations) if (item.at >= dayStart && item.at < dayEnd) entries.push({ key: item.key, start: item.at, kind: "automation", item })
  return entries.sort((left, right) => left.start - right.start)
}

function blockedLabel(error: CalendarConnectionError) {
  const name = error.provider === "google" ? "Google Calendar" : "Outlook Calendar"
  if (error.kind === "auth_expired") return `Reconnect ${name}`
  if (error.kind === "not_connected") return `Connect ${name}`
  if (error.kind === "permission_missing") return `${name} needs calendar access`
  if (error.kind === "policy_blocked") return `${name} is blocked by your organization`
  return null
}

const STATUS: Record<AutomationCalendarItem["status"], string> = {
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  running: "Running",
  upcoming: "Scheduled",
  blocked: "Needs attention",
}

function StatusMark({ item }: { item: AutomationCalendarItem }) {
  if (item.status === "succeeded") return <Check size={13} strokeWidth={2.25} color="#30A46C" />
  if (item.status === "failed") return <X size={13} strokeWidth={2.25} color={color.danger} />
  if (item.status === "blocked") return <Lock size={12} strokeWidth={2} color={color.muted} />
  return item.executionTarget === "cloud" ? <Cloud size={13} strokeWidth={1.75} color={color.muted} /> : <Monitor size={13} strokeWidth={1.75} color={color.muted} />
}

function Chip({ checked, label, onPress }: { checked: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onPress} style={styles.chip}>
      <View style={[styles.check, checked ? styles.checkOn : null]}>{checked ? <Check size={10} strokeWidth={3} color="#fff" /> : null}</View>
      <Text style={[styles.chipText, checked ? null : styles.chipOff]}>{label}</Text>
    </Pressable>
  )
}

export function WorkbotCalendarScreen({ me }: { me: WorkbotMe }) {
  const zone = zoneOf()
  const insets = useSafeAreaInsets()
  const sources = useCalendarSources()
  const [now, setNow] = useState(() => Date.now())
  const [view, setView] = useState<"day" | "week">("day")
  const [anchor, setAnchor] = useState<LocalDate>(() => localDateOf(Date.now(), zone))
  const [layers, setLayers] = useState({ automations: true, meetings: true })
  const [selected, setSelected] = useState<{ kind: "automation"; automationId: string; itemKey: string | null } | { kind: "meeting"; key: string } | null>(null)
  const [creating, setCreating] = useState<CalendarSlot | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3_000)
    return () => clearTimeout(timer)
  }, [toast])

  const range = useMemo(() => calendarRange(view, anchor, zone, 1), [anchor, view, zone])
  const list = useWorkbotAutomations()
  const runs = useRunsInRangeQuery({ keyPrefix: calendarKey, source: sources.runs, range, automations: list.data?.items, enabled: layers.automations })
  const google = useMeetingsQuery({ keyPrefix: calendarKey, provider: "google", transport: sources.transport, range, enabled: layers.meetings })
  const microsoft = useMeetingsQuery({ keyPrefix: calendarKey, provider: "microsoft", transport: sources.transport, range, enabled: layers.meetings })
  const meetingQueries = { google, microsoft }
  const items = useMemo(() => (layers.automations && list.data && runs.data ? buildAutomationCalendarItems({ automations: list.data.items, runs: runs.data.runs, range, now }) : []), [layers.automations, list.data, now, range, runs.data])
  const meetings = useMemo(() => (layers.meetings ? [...(google.data?.events ?? []), ...(microsoft.data?.events ?? [])] : []), [google.data, layers.meetings, microsoft.data])
  const sections = useMemo(() => range.days.map((day) => ({ day, key: dateKey(day), data: entriesForDay(day, zone, items, meetings) })), [range.days, zone, items, meetings])
  const connected = PROVIDERS.filter((provider) => meetingQueries[provider].data)
  const meetingSource = connected.length === 2 ? "Google Calendar and Outlook" : connected[0] === "microsoft" ? "Outlook Calendar" : "Google Calendar"
  const today = localDateOf(now, zone)
  const nowParts = zonedParts(now, zone)
  const label = view === "day" ? formatDate(anchor, "en-US", { weekday: "long", month: "short", day: "numeric" }) : formatRangeLabel(range, anchor, "en-US")
  const selectedItem = selected?.kind === "automation" ? list.data?.items.find((entry) => entry.automation.id === selected.automationId) ?? null : null
  const selectedBlock = selected?.kind === "automation" ? items.find((item) => item.key === selected.itemKey) ?? null : null
  const selectedMeeting = selected?.kind === "meeting" ? meetings.find((event) => event.key === selected.key) ?? null : null
  const refreshing = list.isFetching || runs.isFetching || google.isFetching || microsoft.isFetching

  return (
    <View style={styles.page}>
      <WorkbotHeader name="Workbot" organizationName={me.organizationName} userName={me.name} side={null} sideChats={false} calendar tab="calendar" filesEnabled={false} />
      <View style={styles.toolbar}>
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={styles.title}>{label}</Text>
          <View style={styles.arrows}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous" onPress={() => setAnchor((current) => shiftAnchor(view, current, -1))} style={styles.arrow}><ChevronLeft size={17} strokeWidth={1.75} color={color.muted} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Next" onPress={() => setAnchor((current) => shiftAnchor(view, current, 1))} style={styles.arrow}><ChevronRight size={17} strokeWidth={1.75} color={color.muted} /></Pressable>
          </View>
        </View>
        <View style={styles.controls}>
          <View accessibilityRole="radiogroup" accessibilityLabel="Calendar view" style={styles.views}>
            {(["day", "week"] as const).map((option) => (
              <Pressable key={option} accessibilityRole="radio" accessibilityState={{ checked: view === option }} onPress={() => setView(option)} style={[styles.view, view === option ? styles.viewOn : null]}>
                <Text style={[styles.viewText, view === option ? styles.viewTextOn : null]}>{option === "day" ? "Day" : "Week"}</Text>
              </Pressable>
            ))}
          </View>
          {compareDates(anchor, { year: nowParts.year, month: nowParts.month, day: nowParts.day }) !== 0 ? <QuietButton label="Today" onPress={() => setAnchor(today)} /> : null}
          <View style={styles.spacer} />
          {me.canSchedule ? (
            <Pressable accessibilityRole="button" onPress={() => setCreating(nextOpenSlot(Date.now(), zone))} style={styles.newButton}>
              <Plus size={13} strokeWidth={2} color={color.text} />
              <Text style={styles.newText}>New automation</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.layers}>
          <Chip checked={layers.automations} label="Your automations" onPress={() => setLayers((current) => ({ ...current, automations: !current.automations }))} />
          <Chip checked={layers.meetings} label={`Your meetings, from ${meetingSource}`} onPress={() => setLayers((current) => ({ ...current, meetings: !current.meetings }))} />
          {layers.meetings ? PROVIDERS.map((provider) => {
            const error = meetingQueries[provider].error
            const text = error ? blockedLabel(error) : null
            // A provider the organization never set up stays out of the way.
            if (!error || (error.kind === "not_connected" && connected.length > 0) || error.kind === "unsupported") return null
            return (
              <View key={provider} style={styles.provider}>
                <Lock size={11} strokeWidth={2} color={color.muted} />
                {text && me.denUrl ? (
                  <Text accessibilityRole="link" style={styles.providerLink} onPress={() => void Linking.openURL(`${me.denUrl}/dashboard/your-connections`)}>{text}</Text>
                ) : text ? (
                  <Text style={styles.providerText}>{text}</Text>
                ) : (
                  <Text accessibilityRole="button" style={styles.providerLink} onPress={() => void meetingQueries[provider].refetch()}>Couldn't load {provider === "google" ? "Google Calendar" : "Outlook"} · Try again</Text>
                )}
              </View>
            )
          }) : null}
        </View>
      </View>
      {list.isError ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>Couldn't load your automations.</Text>
          <QuietButton label="Try again" onPress={() => void list.refetch()} />
        </View>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(entry) => entry.key}
        stickySectionHeadersEnabled={view === "week"}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing && !list.isLoading} onRefresh={() => void Promise.all([list.refetch(), runs.refetch(), google.refetch(), microsoft.refetch()])} />}
        renderSectionHeader={({ section }) => (view === "week" ? (
          <Text style={[styles.dayHeader, compareDates(section.day, today) === 0 ? styles.dayToday : null]}>{formatDate(section.day, "en-US", { weekday: "long", month: "short", day: "numeric" })}</Text>
        ) : null)}
        renderSectionFooter={({ section }) => (section.data.length === 0 ? <Text style={styles.empty}>{list.isLoading ? "Loading…" : "Nothing scheduled."}</Text> : null)}
        renderItem={({ item: entry }) => {
          if (entry.kind === "automation") {
            const { item } = entry
            return (
              <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}, ${formatTime(item.at, zone)}, ${STATUS[item.status]}`} onPress={() => setSelected({ kind: "automation", automationId: item.automationId, itemKey: item.key })} style={({ pressed }) => [styles.entry, styles.automation, item.status === "blocked" ? styles.blockedEntry : null, pressed ? styles.pressed : null]}>
                <Text style={styles.time}>{formatTime(item.at, zone)}</Text>
                <View style={styles.entryBody}>
                  <Text numberOfLines={1} style={styles.entryTitle}>{item.name}</Text>
                  <View style={styles.statusRow}>
                    <StatusMark item={item} />
                    <Text style={styles.entryMeta}>{STATUS[item.status]}</Text>
                  </View>
                </View>
              </Pressable>
            )
          }
          const { event } = entry
          return (
            <Pressable accessibilityRole="button" onPress={() => setSelected({ kind: "meeting", key: event.key })} style={({ pressed }) => [styles.entry, styles.meeting, pressed ? styles.pressed : null]}>
              <Text style={styles.time}>{entry.kind === "all-day" ? "All day" : formatTime(entry.start, zone)}</Text>
              <View style={styles.entryBody}>
                <Text numberOfLines={1} style={styles.entryTitle}>{event.title}</Text>
                <Text numberOfLines={1} style={styles.entryMeta}>{event.timing.kind === "timed" ? `Until ${formatTime(event.timing.end, zone)}` : "All day"}{event.location ? ` · ${event.location}` : ""}</Text>
              </View>
            </Pressable>
          )
        }}
        ListFooterComponent={list.data && list.data.items.every((entry) => entry.automation.state === "archived") && layers.automations ? <Text style={styles.empty}>No automations yet. Ask in Home to set up something that repeats.</Text> : null}
      />
      <AutomationSheet item={selectedItem} block={selectedBlock} zone={zone} canSchedule={me.canSchedule} onClose={() => setSelected(null)} onToast={setToast} />
      <MeetingSheet event={selectedMeeting} zone={zone} onClose={() => setSelected(null)} />
      {creating ? (
        <CreateSheet
          slot={creating}
          canSchedule={me.canSchedule}
          assistantName="Workbot"
          onClose={() => setCreating(null)}
          onCreated={(automationId) => {
            setCreating(null)
            setSelected({ kind: "automation", automationId, itemKey: null })
            setToast("Automation created")
          }}
        />
      ) : null}
      {toast ? <View pointerEvents="none" style={[styles.toast, { bottom: insets.bottom + 24 }]}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  toolbar: { paddingHorizontal: 16, paddingTop: 8, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline, paddingBottom: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 20, fontWeight: "600", letterSpacing: -0.3, color: "#000" },
  arrows: { flexDirection: "row", gap: 2 },
  arrow: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  controls: { flexDirection: "row", alignItems: "center", gap: 8 },
  views: { flexDirection: "row", padding: 2, borderRadius: 8, backgroundColor: color.chip },
  view: { height: 30, paddingHorizontal: 12, borderRadius: 6, justifyContent: "center" },
  viewOn: { backgroundColor: color.surface, boxShadow: "0 1px 2px #0116271A" },
  viewText: { fontSize: 13, fontWeight: "500", color: color.muted },
  viewTextOn: { fontWeight: "600", color: "#000" },
  spacer: { flex: 1 },
  newButton: { height: 32, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, borderRadius: 8, boxShadow: "0 0 0 1px #0116271A" },
  newText: { fontSize: 12.5, fontWeight: "500", color: "#000" },
  layers: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, maxWidth: "100%" },
  check: { width: 14, height: 14, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: color.surface, boxShadow: "inset 0 0 0 1.25px #9BA1A6" },
  checkOn: { backgroundColor: color.ink, boxShadow: "none" },
  chipText: { flexShrink: 1, fontSize: 12, fontWeight: "500", color: "#000" },
  chipOff: { color: color.muted },
  provider: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" },
  providerText: { flexShrink: 1, fontSize: 12, color: color.muted },
  providerLink: { flexShrink: 1, fontSize: 12, fontWeight: "500", color: "#000", textDecorationLine: "underline" },
  notice: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  noticeText: { fontSize: 13, color: color.muted },
  list: { paddingHorizontal: 16, paddingTop: 8 },
  dayHeader: { paddingTop: 16, paddingBottom: 6, fontSize: 13, fontWeight: "600", color: color.text, backgroundColor: color.bg },
  dayToday: { color: color.computerLineLive },
  empty: { paddingVertical: 10, paddingLeft: 64, fontSize: 13, color: color.muted },
  entry: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 58, marginTop: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  automation: { backgroundColor: color.surface, boxShadow: "0 0 0 1px #0116270f, 0 1px 2px #0116270a" },
  blockedEntry: { backgroundColor: color.tray },
  meeting: { backgroundColor: "#EDF6FF" },
  pressed: { opacity: 0.8 },
  time: { width: 52, fontSize: 12, fontWeight: "500", color: color.muted, fontVariant: ["tabular-nums"] },
  entryBody: { flex: 1, minWidth: 0, gap: 3 },
  entryTitle: { fontSize: 14, fontWeight: "500", color: color.text },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  entryMeta: { fontSize: 12, color: color.muted },
  toast: { position: "absolute", alignSelf: "center", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999, backgroundColor: color.ink },
  toastText: { fontSize: 13, fontWeight: "500", color: "#E6EDF3" },
})
