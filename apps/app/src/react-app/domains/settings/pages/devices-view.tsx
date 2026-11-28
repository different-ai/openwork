/** @jsxImportSource react */
import { useState, type ComponentType } from "react";
import { computerState, projectComputer } from "@openwork/computers";
import { COMPUTER_STATE_LABELS, computerFolderSchema, type ComputerAccessSetting, type ComputerOwnerChoice } from "@openwork/types/den/computers";
import {
  REMOTE_DEVICE_AVAILABILITY_LABELS,
  REMOTE_DEVICE_DISCONNECTED_LABEL,
  remoteDeviceRegisterRequestSchema,
  remoteDeviceTypeLabel,
  shortAppVersion,
  type RemoteDevice,
  type RemoteDevicePlatform,
  type RemoteDeviceRegisterableProvider,
} from "@openwork/types/den/remote-devices";
import { DenApiError, readDenSettings } from "@/app/lib/den";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { ChevronRight, Cloud, Info, Laptop, Lock, MoreHorizontal } from "lucide-react";
import { useCloudWorkspaceStatus } from "@/react-app/shell/cloud-workspace-overlay";
import { useAutomationsDenContext, type AutomationsDenContext } from "../../automations/use-automations";
import { useThisComputerDisconnected } from "../../devices/computer-connection-store";
import { SessionAccessSection } from "../../devices/session-access-section";
import { isThisComputer, useThisDeviceId } from "../../devices/this-device-store";
import { remoteDevicesContextQueryKey, useComputersQuery, useRemoteDevicesQuery, useRemoteDeviceDetailQuery, useRemoteDeviceMutations, useSetComputerAccess } from "../../devices/use-remote-devices";
import { LayoutStack, LayoutSection, LayoutSectionHeader, LayoutSectionTitle } from "../settings-layout";

const providers = [
  { value: "freestyle", label: "Freestyle VM" }, { value: "daytona", label: "Daytona VM" },
  { value: "mac_host", label: "Mac sandbox" }, { value: "other", label: "Other virtual computer" },
];
const platforms = [{ value: "linux", label: "Linux" }, { value: "darwin", label: "macOS" }, { value: "win32", label: "Windows" }];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Couldn't save this device. Try again.";
const dateLabel = (value: string) => new Date(value).toLocaleString();
const isOwnRegisteredVm = (device: RemoteDevice) => device.kind === "vm" && device.source === "manual" && device.access === "mine";
type DeviceAction = { kind: "register" } | { kind: "rename" | "disconnect" | "remove"; device: RemoteDevice };

type DevicesSharingSlot = ComponentType<{
  scope: readonly unknown[]; devices: RemoteDevice[] | undefined; organizationId: string | null; thisDeviceId: string | null;
}>;

export function DevicesView({ computersEnabled, SharingSection }: { computersEnabled: boolean; SharingSection: DevicesSharingSlot }) {
  const context = useAutomationsDenContext();
  const { signOut } = useCloudWorkspaceStatus();
  return <DevicesContent key={`${remoteDevicesContextQueryKey(context).join(":")}:${context.ready}`} context={context} computersEnabled={computersEnabled} SharingSection={SharingSection} organizationName={readDenSettings().activeOrgName?.trim() || null} onSignOut={signOut} />;
}

export function DevicesContent({ context, computersEnabled, SharingSection, organizationName = null, onSignOut }: { context: AutomationsDenContext; computersEnabled: boolean; SharingSection: DevicesSharingSlot; organizationName?: string | null; onSignOut?: () => void }) {
  const query = useRemoteDevicesQuery(context);
  const thisDeviceId = useThisDeviceId(context.organizationId);
  const disconnected = useThisComputerDisconnected();
  const [action, setAction] = useState<DeviceAction | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const begin = (next: DeviceAction) => { setOutcome(null); setAction(next); };
  const computerSharingSection = computersEnabled ? <SharingSection scope={remoteDevicesContextQueryKey(context)} devices={query.data} organizationId={context.organizationId} thisDeviceId={thisDeviceId} /> : null;
  const sessionAccessSection = <SessionAccessSection />;
  if (!context.ready) return <LayoutStack><p role="status" className="text-sm text-muted-foreground">Sign in and select an organization in Cloud account to see your devices.</p>{computerSharingSection}{sessionAccessSection}</LayoutStack>;
  const devices = query.data ?? [];
  return <LayoutStack>
    {disconnected ? <Alert role="status" data-testid="computer-disconnected" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1"><AlertTitle>This computer was disconnected from {organizationName ?? "your organization"}.</AlertTitle><AlertDescription>Sign out and sign in again to reconnect it.</AlertDescription></div>
      {onSignOut ? <Button size="sm" variant="outline" onClick={onSignOut}>Sign out</Button> : null}
    </Alert> : null}
    <div className="flex justify-end"><Button size="sm" onClick={() => begin({ kind: "register" })}>Add a computer</Button></div>
    {outcome ? <p role="status" data-testid="device-outcome" className="text-sm">{outcome}</p> : null}
    {query.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><span>Couldn't refresh devices. {errorMessage(query.error)}</span><Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button></div> : null}
    {query.isPending ? <div aria-label="Checking devices" className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded bg-muted motion-reduce:animate-none" />)}</div> : null}
    {!query.isPending && !query.isError && devices.length === 0 ? <p className="text-sm text-muted-foreground">Sign in to OpenWork Desktop to add your computer, or register a cloud VM. Registering a VM doesn't grant access or start it.</p> : null}
    {(["desktop", "vm"] as const).map(kind => <LayoutSection key={kind}>
      <LayoutSectionHeader><LayoutSectionTitle>{kind === "desktop" ? "Your computers" : "Cloud computers"}</LayoutSectionTitle></LayoutSectionHeader>
      {devices.filter(device => device.kind === kind).map(device => <DeviceRow key={device.id} device={device} context={context} thisDevice={isThisComputer(device, context.organizationId, thisDeviceId)} computersEnabled={computersEnabled} onAction={begin} />)}
      {!query.isPending && devices.length > 0 && !devices.some(device => device.kind === kind) ? <p className="text-sm text-muted-foreground">{kind === "desktop" ? "No desktops reported yet." : "No cloud VMs registered yet."}</p> : null}
    </LayoutSection>)}
    {computerSharingSection}
    {sessionAccessSection}
    {action ? <DeviceDialog key={action.kind === "register" ? "register" : `${action.kind}:${action.device.id}`} action={action} context={context} computersEnabled={computersEnabled} onClose={result => { setAction(null); if (result) setOutcome(result); }} /> : null}
  </LayoutStack>;
}

function DeviceRow({ device, context, thisDevice, computersEnabled, onAction }: { device: RemoteDevice; context: AutomationsDenContext; thisDevice: boolean; computersEnabled: boolean; onAction: (action: DeviceAction) => void }) {
  const [open, setOpen] = useState(false);
  const detail = useRemoteDeviceDetailQuery(context, device.id, open);
  const disconnected = device.disconnectedAt !== null;
  const canDisconnect = device.canDisconnect && !thisDevice;
  const version = shortAppVersion(device.appVersion);
  const cloudState = computersEnabled && device.kind === "vm"
    ? computerState(projectComputer({ ...device, ownerMemberId: null }))
    : null;
  const availabilityLabel = cloudState ? COMPUTER_STATE_LABELS[cloudState] : REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability];
  const tone = cloudState
    ? cloudState === "has_a_problem" ? "text-amber-11" : "text-muted-foreground"
    : device.availability === "online" ? "text-green-11" : device.availability === "needs_setup" ? "text-amber-11" : "text-muted-foreground";
  return <div className="border-b border-border py-3" data-testid="device-row">
    <div className="flex items-center gap-3">
      {device.kind === "desktop" ? <Laptop aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} /> : <Cloud aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{device.label}{thisDevice ? <span className="ml-2 font-normal text-muted-foreground">This computer</span> : null}</div><div className="text-xs text-muted-foreground">{remoteDeviceTypeLabel(device)}{device.access === "shared" ? " — Shared with your organization" : ""}</div></div>
      <span role="status" className={`flex shrink-0 items-center gap-1.5 text-sm ${disconnected ? "text-muted-foreground" : tone}`}><span aria-hidden className="size-1.5 rounded-full bg-current" />{disconnected ? REMOTE_DEVICE_DISCONNECTED_LABEL : availabilityLabel}</span>
      <div className="w-8 shrink-0">{device.canRename || canDisconnect || device.canRemove ? <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Manage ${device.label}`} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end">{device.canRename ? <DropdownMenuItem onClick={() => onAction({ kind: "rename", device })}>{computersEnabled && isOwnRegisteredVm(device) ? t("common.edit") : "Rename"}</DropdownMenuItem> : null}{canDisconnect ? <DropdownMenuItem onClick={() => onAction({ kind: "disconnect", device })}>Disconnect</DropdownMenuItem> : null}{device.canRemove ? <DropdownMenuItem onClick={() => onAction({ kind: "remove", device })}>Remove</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}</div>
    </div>
    {disconnected ? <p className="mt-1 text-sm text-muted-foreground">Sign in on it again to reconnect.</p> : device.statusDetail ? <p className="mt-1 text-sm text-muted-foreground">{device.statusDetail}</p> : null}
    <div className="mt-1 text-xs text-muted-foreground">{device.lastSeenAt ? <>Last reported <time dateTime={device.lastSeenAt}>{dateLabel(device.lastSeenAt)}</time></> : "No report received"}{version ? ` — OpenWork ${version}` : ""}</div>
    <details className="group mt-2" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />Recent events</summary>
      {open ? <div className="mt-2 space-y-2 text-xs">{detail.isPending ? <div aria-label="Checking recent events" className="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" /> : null}{detail.isError ? <div role="alert">Couldn't read recent events. <Button size="sm" variant="ghost" onClick={() => void detail.refetch()}>Try again</Button></div> : null}{detail.data?.events.map(event => <div key={event.id} className="flex flex-wrap justify-between gap-x-4"><span>{event.message}</span><time className="text-muted-foreground" dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time></div>)}{detail.data?.events.length === 0 ? <p className="text-muted-foreground">No recent events.</p> : null}</div> : null}
    </details>
  </div>;
}

function DeviceDialog({ action, context, computersEnabled, onClose }: { action: DeviceAction; context: AutomationsDenContext; computersEnabled: boolean; onClose: (result?: string) => void }) {
  const mutations = useRemoteDeviceMutations(context);
  const editAccess = computersEnabled && action.kind === "rename" && isOwnRegisteredVm(action.device);
  const computers = useComputersQuery(context, editAccess);
  const setComputerAccess = useSetComputerAccess(context);
  const computer = editAccess && action.kind === "rename" ? computers.data?.find(row => row.id === action.device.id) : undefined;
  const access = computers.isError ? null : computer?.access;
  const locked = computer?.reach.outcome === "refuse" && computer.reach.layer === "organization";
  const [choiceDraft, setChoiceDraft] = useState<ComputerOwnerChoice | null>(null);
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const savedChoice = access?.choice === "allow" && access.scope === "whole_vm" ? "allow" : "off";
  const savedFolder = savedChoice === "allow" ? access?.folders[0] ?? "/workspace" : "/workspace";
  const choice = choiceDraft ?? savedChoice;
  const folder = folderDraft ?? savedFolder;
  const accessChanged = choice !== savedChoice || (choice === "allow" && folder !== savedFolder);
  const [label, setLabel] = useState(action.kind === "register" ? "" : action.device.label);
  const [provider, setProvider] = useState<RemoteDeviceRegisterableProvider>("freestyle");
  const [platform, setPlatform] = useState<RemoteDevicePlatform>("linux");
  const [externalId, setExternalId] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState("");
  const [accessError, setAccessError] = useState("");
  const busy = mutations.register.isPending || mutations.rename.isPending || mutations.disconnect.isPending || mutations.remove.isPending || setComputerAccess.isPending;
  const confirming = action.kind === "disconnect" || action.kind === "remove";
  const title = action.kind === "register" ? "Add computer" : action.kind === "rename" ? editAccess ? t("settings.devices.edit_computer") : "Rename computer" : action.kind === "disconnect" ? `Disconnect ${action.device.label}?` : `Remove ${action.device.label}?`;
  async function saveAccess() {
    if (action.kind !== "rename" || busy || !access || locked || !accessChanged) return;
    const setting: ComputerAccessSetting = choice === "allow"
      ? { choice: "allow", scope: "whole_vm", folders: [folder] }
      : { choice: "off" };
    if (setting.choice === "allow" && !computerFolderSchema.safeParse(folder).success) { setAccessError(t("settings.devices.folder_invalid")); return; }
    setAccessError("");
    try {
      await setComputerAccess.mutateAsync({ computerId: action.device.id, setting });
      setChoiceDraft(null);
      setFolderDraft(null);
    } catch (cause) {
      setAccessError(cause instanceof DenApiError && cause.status === 409 ? cause.message : t("settings.devices.access_save_failed"));
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      if (action.kind === "register") {
        const parsed = remoteDeviceRegisterRequestSchema.safeParse({ label, provider, platform, externalId, shared });
        if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the VM details."); return; }
        await mutations.register.mutateAsync(parsed.data);
      } else if (action.kind === "rename") {
        if (!label.trim() || label.trim().length > 80) { setError("Use a name between 1 and 80 characters."); return; }
        await mutations.rename.mutateAsync({ deviceId: action.device.id, label: label.trim() });
      } else if (action.kind === "disconnect") {
        const { signedOut } = await mutations.disconnect.mutateAsync(action.device.id);
        onClose(signedOut ? "Disconnected. OpenWork was signed out on that computer." : "Disconnected. It can't act as a computer until someone signs in on it again.");
        return;
      } else await mutations.remove.mutateAsync(action.device.id);
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{title}</DialogTitle>{action.kind === "disconnect" ? <DialogDescription>OpenWork on that computer is signed out and it stops taking tasks and sharing sessions. Sign in on it again to reconnect it.</DialogDescription> : action.kind === "remove" ? <DialogDescription>Remove it from this organization's list. This won't stop or delete the computer. {action.device.disconnectedAt ? "It appears again if someone signs in on it." : "A desktop can appear again when it next reports."}</DialogDescription> : null}</DialogHeader>
    <form onSubmit={event => void save(event)} className="grid gap-4">
      {!confirming ? <div className="grid gap-2"><Label htmlFor="device-label">Name</Label><Input id="device-label" value={label} onChange={event => setLabel(event.target.value)} required maxLength={80} disabled={busy} /></div> : null}
      {action.kind === "register" ? <>
        <div className="grid gap-2"><Label htmlFor="device-provider">Provider</Label><Select items={providers} value={provider} disabled={busy} onValueChange={value => { if (value) { setProvider(value); if (value === "mac_host") setPlatform("darwin"); else if (value !== "other") setPlatform("linux"); } }}><SelectTrigger id="device-provider" aria-label="Provider"><SelectValue /></SelectTrigger><SelectContent>{providers.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label htmlFor="device-external-id">ID from the provider</Label><Input id="device-external-id" value={externalId} onChange={event => setExternalId(event.target.value)} required maxLength={160} disabled={busy} autoComplete="off" /></div>
        <div className="grid gap-2"><Label htmlFor="device-platform">Platform</Label><Select items={platforms} value={platform} disabled={busy} onValueChange={value => { if (value) setPlatform(value); }}><SelectTrigger id="device-platform" aria-label="Platform"><SelectValue /></SelectTrigger><SelectContent>{platforms.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label className="flex items-center gap-2"><Checkbox checked={shared} disabled={busy} onCheckedChange={setShared} />Share with organization</Label><p className="text-xs text-muted-foreground">Sharing requires the Manage desktop policies permission. Registration doesn't grant access to the VM.</p></div>
      </> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onClose()}>Cancel</Button><Button type="submit" variant={confirming ? "destructive" : "default"} disabled={busy} aria-busy={busy}>{action.kind === "register" ? "Add computer" : action.kind === "rename" ? editAccess ? t("settings.devices.save_name") : "Save changes" : action.kind === "disconnect" ? "Disconnect" : "Remove device"}</Button></DialogFooter>
    </form>
      {editAccess && access ? <div className="grid gap-4 border-t border-border pt-4">
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <Label id="device-run-work-label" htmlFor="device-run-work">{t("settings.devices.run_work")}</Label>
              <Tooltip><TooltipTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label={t("settings.devices.access_details")} />}><Info aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.5} /></TooltipTrigger><TooltipContent className="max-w-xs">{t("settings.devices.access_risk")}</TooltipContent></Tooltip>
            </div>
            <Switch id="device-run-work" aria-labelledby="device-run-work-label" aria-describedby={locked ? "device-access-locked" : undefined} checked={!locked && choice === "allow"} disabled={busy || locked} onCheckedChange={checked => { setChoiceDraft(checked ? "allow" : "off"); setAccessError(""); }} />
          </div>
          {locked ? <p id="device-access-locked" className="flex items-start gap-2 text-sm text-muted-foreground"><Lock aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />{t("settings.devices.access_locked")}</p> : null}
        </div>
        <div className="grid gap-2"><Label htmlFor="device-folder">{t("settings.devices.folder")}</Label><Input id="device-folder" value={folder} onChange={event => setFolderDraft(event.target.value)} maxLength={1024} disabled={busy || locked || choice !== "allow"} autoComplete="off" /></div>
        {accessError ? <p role="alert" className="text-sm text-destructive">{accessError}</p> : null}
        <div className="flex justify-end"><Button type="button" disabled={busy || locked || !accessChanged} onClick={() => void saveAccess()}>{t("settings.devices.save_access")}</Button></div>
      </div> : editAccess ? computers.isPending
        ? <div aria-label={t("settings.devices.access_checking")} className="grid gap-4"><div className="h-5 animate-pulse rounded-md bg-muted motion-reduce:animate-none" /><div className="h-9 animate-pulse rounded-md bg-muted motion-reduce:animate-none" /></div>
        : <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><span>{t("settings.devices.access_read_failed")}</span><Button type="button" size="sm" variant="outline" onClick={() => void computers.refetch()}>{t("settings.devices.try_again")}</Button></div>
        : null}
  </DialogContent></Dialog>;
}
