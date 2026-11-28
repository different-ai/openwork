/** @jsxImportSource react */
import { useId, useRef, useState } from "react"
import { Folder, Lock, Plus, X } from "lucide-react"
import type { ComputerSharingSettings } from "@openwork/types/computer-sharing"
import type { ComputerSourceRef } from "@openwork/types/den/computers"
import type { RemoteDevice } from "@openwork/types/den/remote-devices"
import { pickDirectory } from "@/app/lib/desktop"
import { OpenworkServerError } from "@/app/lib/openwork-server"
import { formatRelativeTime } from "@/app/utils"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { currentLocale, t } from "@/i18n"
import { isThisComputer } from "./this-device-store"
import { useComputerSharing } from "./use-computer-sharing"

type SharingSource = ComputerSharingSettings["sources"][number]
type SharingFolder = ComputerSharingSettings["folders"][number]
const sourceKey = (source: ComputerSourceRef) => source.kind === "computer" ? `computer:${source.id}` : source.kind
const workbot: SharingSource = { kind: "workbot" }
const rowClass = "flex min-h-12 items-center justify-between gap-3 py-1.5"
const lockIcon = <Lock aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />

export function ComputerSharingSection({ scope, devices, organizationId, thisDeviceId }: {
  scope: readonly unknown[]; devices: RemoteDevice[] | undefined; organizationId: string | null; thisDeviceId: string | null;
}) {
  const { query, desktop, settings, update, busy, error, resetError } = useComputerSharing(scope)
  const statusId = useId()
  const section = useRef<HTMLElement>(null)
  const [picking, setPicking] = useState(false)
  const [folderError, setFolderError] = useState("")
  const state = query.data
  const locked = state?.organizationAllows === false
  const available = state?.availability.state === "available"
  const editable = available && !locked && !busy
  const on = settings?.enabled === true && !locked
  const candidates = devices?.filter(device => device.kind === "desktop" && device.access === "mine" && device.disconnectedAt === null
    && !isThisComputer(device, organizationId, thisDeviceId))
  const revoked = new Set(state?.revokedSources.map(({ source }) => sourceKey(source)))
  const allowed = new Set(settings?.sources.map(sourceKey))
  const allowedCount = [...allowed].filter(key => !revoked.has(key) && (!candidates || key === "workbot"
    || candidates.some(device => `computer:${device.id}` === key))).length
  const folders = settings?.folders ?? []
  const note = locked ? t("settings.devices.sharing_locked")
    : state?.sync !== "synced" || state.organizationAllows === null ? t("settings.devices.sharing_waiting")
    : !on ? t("settings.devices.sharing_off")
    : folders.length === 0 || allowedCount === 0 ? t("settings.devices.sharing_empty")
    : t("settings.devices.sharing_summary", {
      folders: t("settings.devices.sharing_folder_count", { count: folders.length }),
      sources: t("settings.devices.sharing_source_count", { count: allowedCount }),
    })
  const change = (next: Parameters<typeof update>[0]) => {
    setFolderError("")
    update(next)
  }
  const chooseSource = (source: SharingSource, checked: boolean) => change(current => {
    const key = sourceKey(source)
    const next = current.sources.filter(entry => sourceKey(entry) !== key)
    return { ...current, sources: checked ? [...next, source] : next }
  })
  async function addFolder() {
    if (!editable || picking) return
    setFolderError("")
    resetError()
    setPicking(true)
    try {
      const selection = await pickDirectory({ title: t("settings.devices.sharing_add_folder") })
      const path = Array.isArray(selection) ? selection[0] : selection
      if (!section.current || typeof path !== "string" || !path) return
      update(current => {
        if (!current.enabled || current.folders.some(folder => folder.path === path)) return null
        return { ...current, folders: [...current.folders, { path, access: "read" }] }
      })
    } catch {
      setFolderError(t("settings.devices.sharing_picker_failed"))
    } finally {
      setPicking(false)
    }
  }
  const changeFolder = (path: string, access: SharingFolder["access"] | null) => change(current => ({
    ...current, folders: current.folders.flatMap(folder => folder.path !== path ? [folder] : access ? [{ path, access }] : []),
  }))
  const errorText = folderError || (error instanceof OpenworkServerError && error.status === 400 ? error.message : "")
    || (error ? t("settings.devices.sharing_save_failed") : "")
  const inlineError = errorText ? <p role="alert" className="text-sm text-destructive">{errorText}</p> : null
  return <section ref={section} className="flex flex-col gap-4">
    <h3 className="text-base font-medium text-foreground">{t("settings.devices.sharing_title")}</h3>
    {!desktop ? <LockedNote>{t("settings.devices.sharing_desktop_only")}</LockedNote> : null}
    {desktop && query.isPending ? <Skeleton aria-label={t("settings.devices.sharing_checking")} className="h-12 w-full" /> : null}
    {desktop && (query.isError || state === null) ? <div className={`${rowClass} text-sm text-muted-foreground`}>
      <span role="status">{state ? t("settings.devices.sharing_read_stale", { time: formatRelativeTime(query.dataUpdatedAt) }) : t("settings.devices.sharing_read_failed")}</span>
      <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("settings.devices.try_again")}</Button>
    </div> : null}
    {state?.availability.state === "unavailable" ? <LockedNote>{state.availability.message}</LockedNote> : null}
    {available ? <div>
      <div className={`${rowClass} border-b border-border`}>
        <div className="min-w-0">
          <span className="text-sm font-medium">{t("settings.devices.sharing_toggle")}</span>
          <p id={statusId} role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">{locked ? lockIcon : null}{note}</p>
        </div>
        <Switch aria-label={t("settings.devices.sharing_toggle")} aria-describedby={statusId} checked={on} disabled={!editable} onCheckedChange={enabled => change(current => ({ ...current, enabled }))} />
      </div>
      {on ? <div className="flex flex-col gap-4 pt-4">
        <div className="grid gap-2">
          <h4 className="text-sm font-medium">{t("settings.devices.sharing_folders")}</h4>
          {folders.length ? <ul className="divide-y divide-border border-y border-border">
            {folders.map(folder => <FolderRow key={folder.path} folder={folder} editable={editable} onChange={access => changeFolder(folder.path, access)} />)}
          </ul> : <p className="text-sm text-muted-foreground">{t("settings.devices.sharing_no_folders")}</p>}
          {inlineError}
          <Button className="w-fit" size="sm" variant="outline" disabled={!editable || picking} onClick={() => void addFolder()}><Plus aria-hidden className="size-4" strokeWidth={1.5} />{t("settings.devices.sharing_add_folder")}</Button>
        </div>
        <div className="grid gap-2">
          <h4 className="text-sm font-medium">{t("settings.devices.sharing_sources")}</h4>
          {candidates?.length === 0 ? <p className="text-sm text-muted-foreground">{t("settings.devices.sharing_no_computers")}</p> : null}
          <ul className="divide-y divide-border border-y border-border">
            {candidates?.map(device => {
              const source: SharingSource = { kind: "computer", id: device.id }
              return <SourceRow key={device.id} label={device.label} status={desktopStatus(device)} allowed={allowed.has(sourceKey(source))} revoked={revoked.has(sourceKey(source))} editable={editable} onChange={checked => chooseSource(source, checked)} />
            })}
            <SourceRow label={t("settings.devices.sharing_workbot")} allowed={allowed.has("workbot")} revoked={revoked.has("workbot")} editable={editable} onChange={checked => chooseSource(workbot, checked)} />
            {candidates && settings?.sources.map(source => source.kind === "computer" && !candidates.some(device => device.id === source.id) ? <li key={sourceKey(source)} className={rowClass}>
              <span className="text-sm text-muted-foreground">{t("settings.devices.sharing_removed_computer")}</span>
              <Button size="sm" variant="ghost" disabled={!editable} onClick={() => chooseSource(source, false)}>{t("settings.devices.sharing_remove")}</Button>
            </li> : null)}
          </ul>
        </div>
      </div> : inlineError}
    </div> : null}
  </section>
}

function FolderRow({ folder, editable, onChange }: { folder: SharingFolder; editable: boolean; onChange: (access: SharingFolder["access"] | null) => void }) {
  const name = folder.path.split("/").filter(Boolean).pop() || folder.path
  const options: { value: SharingFolder["access"]; label: string }[] = [
    { value: "read", label: t("settings.devices.sharing_read_only") }, { value: "edit", label: t("settings.devices.sharing_can_edit") },
  ]
  return <li className={rowClass}>
    <div className="flex min-w-0 items-start gap-2">
      <Folder aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-right font-mono text-xs text-muted-foreground" dir="rtl" title={folder.path}><bdi dir="ltr">{folder.path}</bdi></div>
      </div>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      <Select items={options} value={folder.access} disabled={!editable} onValueChange={value => { if (value !== null) onChange(value) }}>
        <SelectTrigger size="sm" aria-label={t("settings.devices.sharing_folder_access", { name })}><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="icon-sm" variant="ghost" className="text-muted-foreground" disabled={!editable} aria-label={t("settings.devices.sharing_stop_folder", { name })} onClick={() => onChange(null)}><X aria-hidden className="size-4" strokeWidth={1.5} /></Button>
    </div>
  </li>
}

function LockedNote({ children }: { children: string }) {
  return <p className="flex min-h-10 items-center gap-2 text-sm text-muted-foreground">{lockIcon}{children}</p>
}

function SourceRow({ label, status, editable, allowed, revoked, onChange }: {
  label: string; status?: string; editable: boolean; allowed: boolean; revoked: boolean; onChange: (checked: boolean) => void;
}) {
  const id = useId()
  const locked = allowed && revoked
  return <li className={rowClass}>
    <div className="min-w-0">
      <div className="truncate text-sm font-medium" title={label}>{label}</div>
      {locked || status ? <div id={id} className="text-xs text-muted-foreground">
        {locked ? <><span className="flex items-center gap-1.5">{lockIcon}{t("settings.devices.sharing_revoked")}</span>{t("settings.devices.sharing_restore")}</> : status}
      </div> : null}
    </div>
    <Switch aria-label={label} aria-describedby={locked || status ? id : undefined} checked={allowed && !locked} disabled={!editable || locked} onCheckedChange={onChange} />
  </li>
}

function desktopStatus(device: RemoteDevice) {
  if (device.availability === "online") return t("settings.devices.sharing_online")
  const seen = Date.parse(device.lastSeenAt ?? "")
  if (!Number.isFinite(seen)) return t("settings.devices.sharing_offline")
  const days = Math.floor((Date.now() - seen) / 86_400_000)
  const time = days > 0 ? new Intl.RelativeTimeFormat(currentLocale()).format(-days, "day") : formatRelativeTime(seen)
  return t("settings.devices.sharing_last_seen", { time })
}
