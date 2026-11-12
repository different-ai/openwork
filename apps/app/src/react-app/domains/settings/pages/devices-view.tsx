/** @jsxImportSource react */
import { useState } from "react";
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
import { readDenSettings } from "@/app/lib/den";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronRight, Cloud, Laptop, MoreHorizontal } from "lucide-react";
import { useCloudWorkspaceStatus } from "@/react-app/shell/cloud-workspace-overlay";
import { useAutomationsDenContext, type AutomationsDenContext } from "../../automations/use-automations";
import { useDesktopFeature } from "../../session/status/use-desktop-feature";
import { useThisComputerDisconnected } from "../../devices/computer-connection-store";
import { SessionAccessSection } from "../../devices/session-access-section";
import { isThisComputer, useThisDeviceId } from "../../devices/this-device-store";
import { remoteDevicesContextQueryKey, useRemoteDevicesQuery, useRemoteDeviceDetailQuery, useRemoteDeviceMutations } from "../../devices/use-remote-devices";
import { LayoutStack, LayoutSection, LayoutSectionHeader, LayoutSectionTitle } from "../settings-layout";

const providers = [
  { value: "freestyle", label: "Freestyle VM" }, { value: "daytona", label: "Daytona VM" },
  { value: "mac_host", label: "Mac sandbox" }, { value: "other", label: "Other virtual computer" },
];
const platforms = [{ value: "linux", label: "Linux" }, { value: "darwin", label: "macOS" }, { value: "win32", label: "Windows" }];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Couldn't save this device. Try again.";
const dateLabel = (value: string) => new Date(value).toLocaleString();
type DeviceAction = { kind: "register" } | { kind: "rename" | "disconnect" | "remove"; device: RemoteDevice };

export function DevicesView() {
  const context = useAutomationsDenContext();
  const enabled = useDesktopFeature("remoteDevices");
  const sessionAccess = useDesktopFeature("remoteSessionAccess");
  const { signOut } = useCloudWorkspaceStatus();
  // Key the contents to the sign-in, including dialogs and mutation state.
  return <DevicesContent key={`${remoteDevicesContextQueryKey(context).join(":")}:${context.ready}`} context={context} enabled={enabled} sessionAccess={sessionAccess} organizationName={readDenSettings().activeOrgName?.trim() || null} onSignOut={signOut} />;
}

export function DevicesContent({ context, enabled, sessionAccess = false, organizationName = null, onSignOut }: { context: AutomationsDenContext; enabled: boolean; sessionAccess?: boolean; organizationName?: string | null; onSignOut?: () => void }) {
  const query = useRemoteDevicesQuery(context, enabled);
  const thisDeviceId = useThisDeviceId(context.organizationId);
  const disconnected = useThisComputerDisconnected();
  const [action, setAction] = useState<DeviceAction | null>(null);
  /** What the last disconnect did, until the next action. */
  const [outcome, setOutcome] = useState<string | null>(null);
  const begin = (next: DeviceAction) => { setOutcome(null); setAction(next); };
  if (!enabled) return <p role="status" className="text-sm text-muted-foreground">Not turned on for this organization.</p>;
  // Everyone with this page can turn their computer off; `sessionAccess` only adds opening sessions started here.
  const sessionAccessSection = <SessionAccessSection allSessions={sessionAccess} />;
  if (!context.ready) return <LayoutStack><p role="status" className="text-sm text-muted-foreground">Sign in and select an organization in Cloud account to see your devices.</p>{sessionAccessSection}</LayoutStack>;
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
      {devices.filter(device => device.kind === kind).map(device => <DeviceRow key={device.id} device={device} context={context} thisDevice={isThisComputer(device, context.organizationId, thisDeviceId)} onAction={begin} />)}
      {!query.isPending && devices.length > 0 && !devices.some(device => device.kind === kind) ? <p className="text-sm text-muted-foreground">{kind === "desktop" ? "No desktops reported yet." : "No cloud VMs registered yet."}</p> : null}
    </LayoutSection>)}
    {sessionAccessSection}
    {action ? <DeviceDialog key={action.kind === "register" ? "register" : `${action.kind}:${action.device.id}`} action={action} context={context} onClose={result => { setAction(null); if (result) setOutcome(result); }} /> : null}
  </LayoutStack>;
}

function DeviceRow({ device, context, thisDevice, onAction }: { device: RemoteDevice; context: AutomationsDenContext; thisDevice: boolean; onAction: (action: DeviceAction) => void }) {
  const [open, setOpen] = useState(false);
  const detail = useRemoteDeviceDetailQuery(context, device.id, open);
  const disconnected = device.disconnectedAt !== null;
  // This computer is disconnected by signing out of it, not from its own list.
  const canDisconnect = device.canDisconnect && !thisDevice;
  const version = shortAppVersion(device.appVersion);
  return <div className="border-b border-border py-3" data-testid="device-row">
    <div className="flex items-center gap-3">
      {device.kind === "desktop" ? <Laptop aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} /> : <Cloud aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{device.label}{thisDevice ? <span className="ml-2 font-normal text-muted-foreground">This computer</span> : null}</div><div className="text-xs text-muted-foreground">{remoteDeviceTypeLabel(device)}{device.access === "shared" ? " — Shared with your organization" : ""}</div></div>
      <span role="status" className={`flex shrink-0 items-center gap-1.5 text-sm ${disconnected ? "text-muted-foreground" : device.availability === "online" ? "text-green-11" : device.availability === "needs_setup" ? "text-amber-11" : "text-muted-foreground"}`}><span aria-hidden className="size-1.5 rounded-full bg-current" />{disconnected ? REMOTE_DEVICE_DISCONNECTED_LABEL : REMOTE_DEVICE_AVAILABILITY_LABELS[device.availability]}</span>
      <div className="w-8 shrink-0">{device.canRename || canDisconnect || device.canRemove ? <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Manage ${device.label}`} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end">{device.canRename ? <DropdownMenuItem onClick={() => onAction({ kind: "rename", device })}>Rename</DropdownMenuItem> : null}{canDisconnect ? <DropdownMenuItem onClick={() => onAction({ kind: "disconnect", device })}>Disconnect</DropdownMenuItem> : null}{device.canRemove ? <DropdownMenuItem onClick={() => onAction({ kind: "remove", device })}>Remove</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}</div>
    </div>
    {disconnected ? <p className="mt-1 text-sm text-muted-foreground">Sign in on it again to reconnect.</p> : device.statusDetail ? <p className="mt-1 text-sm text-muted-foreground">{device.statusDetail}</p> : null}
    <div className="mt-1 text-xs text-muted-foreground">{device.lastSeenAt ? <>Last reported <time dateTime={device.lastSeenAt}>{dateLabel(device.lastSeenAt)}</time></> : "No report received"}{version ? ` — OpenWork ${version}` : ""}</div>
    <details className="group mt-2" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />Recent events</summary>
      {open ? <div className="mt-2 space-y-2 text-xs">{detail.isPending ? <div aria-label="Checking recent events" className="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" /> : null}{detail.isError ? <div role="alert">Couldn't read recent events. <Button size="sm" variant="ghost" onClick={() => void detail.refetch()}>Try again</Button></div> : null}{detail.data?.events.map(event => <div key={event.id} className="flex flex-wrap justify-between gap-x-4"><span>{event.message}</span><time className="text-muted-foreground" dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time></div>)}{detail.data?.events.length === 0 ? <p className="text-muted-foreground">No recent events.</p> : null}</div> : null}
    </details>
  </div>;
}

function DeviceDialog({ action, context, onClose }: { action: DeviceAction; context: AutomationsDenContext; onClose: (result?: string) => void }) {
  const mutations = useRemoteDeviceMutations(context);
  const [label, setLabel] = useState(action.kind === "register" ? "" : action.device.label);
  const [provider, setProvider] = useState<RemoteDeviceRegisterableProvider>("freestyle");
  const [platform, setPlatform] = useState<RemoteDevicePlatform>("linux");
  const [externalId, setExternalId] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState("");
  const busy = mutations.register.isPending || mutations.rename.isPending || mutations.disconnect.isPending || mutations.remove.isPending;
  const confirming = action.kind === "disconnect" || action.kind === "remove";
  const title = action.kind === "register" ? "Add computer" : action.kind === "rename" ? "Rename computer" : action.kind === "disconnect" ? `Disconnect ${action.device.label}?` : `Remove ${action.device.label}?`;
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
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onClose()}>Cancel</Button><Button type="submit" variant={confirming ? "destructive" : "default"} disabled={busy} aria-busy={busy}>{action.kind === "register" ? "Add computer" : action.kind === "rename" ? "Save changes" : action.kind === "disconnect" ? "Disconnect" : "Remove device"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
