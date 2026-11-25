/** @jsxImportSource react */
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, LoaderCircle, Lock, Monitor, MonitorCheck, MonitorCog, MonitorOff, MonitorX, type LucideIcon } from "lucide-react";
import type { ComputerPermission, ComputerStatus, DesktopCommandResult, PrivateValueSettings, PrivateValueSwitch } from "@openwork/types/desktop-ipc";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { readGatewayUsageScope, subscribeGatewayUsageScope } from "@/app/lib/gateway-usage-scope";

import { desktopBridge } from "@/app/lib/desktop";
import type { FileSendGrants, OpenworkServerClient } from "@/app/lib/openwork-server";
import { isElectronRuntime, isMacPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  LayoutSection,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { SettingsInset } from "../settings-section";

type Busy = "choose" | "reset" | ComputerPermission | null;
type SummaryState = ComputerStatus["readiness"] | "checking" | "off";

const PERMISSIONS: Array<{ id: ComputerPermission; title: string; purpose: string }> = [
  { id: "accessibility", title: "Accessibility", purpose: "Use app controls, the mouse and the keyboard in Mac apps." },
  { id: "screenRecording", title: "Screen Recording", purpose: "See app windows. macOS may call it Screen & System Audio Recording." },
];
const STUCK_AFTER_MS = 15_000;

const SUMMARY: Record<SummaryState, { icon: LucideIcon; label: string; tile: string }> = {
  ready: { icon: MonitorCheck, label: "Ready", tile: "bg-green-3 text-green-11" },
  "setup-required": { icon: MonitorCog, label: "Setup needed", tile: "bg-amber-3 text-amber-11" },
  unsupported: { icon: MonitorOff, label: "Not supported", tile: "bg-muted text-muted-foreground" },
  unavailable: { icon: MonitorX, label: "Unavailable", tile: "bg-muted text-muted-foreground" },
  checking: { icon: Monitor, label: "Checking", tile: "bg-muted text-muted-foreground" },
  off: { icon: Lock, label: "Not turned on", tile: "bg-muted text-muted-foreground" },
};

const SEEN = "The agent sees the app window it is using, and its content goes to your AI model provider.";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function ComputerUseView({ fileSends }: { fileSends?: FileSendGrantsClient | null }) {
  const enabled = isElectronRuntime();
  return <ComputerUseSettings enabled={enabled} fileSends={fileSends} />;
}

export function ComputerUseSettings({ enabled, fileSends }: { enabled: boolean; fileSends?: FileSendGrantsClient | null }) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [opened, setOpened] = useState<Partial<Record<ComputerPermission, number>>>({});
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const reading = useRef(false);
  const changing = useRef(false);

  async function refresh() {
    if (reading.current || changing.current) return;
    reading.current = true;
    const current = generation.current;
    try {
      const next = await desktopBridge.computerStatus();
      if (current !== generation.current) return;
      setStatus(next);
      setReadError("");
    } catch (cause) {
      if (current === generation.current) setReadError(message(cause));
    } finally {
      reading.current = false;
    }
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    if (!enabled) return;
    void readLatest();
    const update = () => { if (document.visibilityState === "visible") void readLatest(); };
    const timer = window.setInterval(update, 1_500);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      void desktopBridge.computerDismissSetup().catch(() => {});
    };
  }, [enabled]);

  const granted = status?.readiness === "ready";
  useEffect(() => {
    if (!Object.keys(opened).length || granted) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [opened, granted]);

  async function act(action: Exclude<Busy, null>, run: () => Promise<ComputerStatus | unknown>) {
    if (changing.current) return;
    changing.current = true;
    const current = ++generation.current;
    setBusy(action);
    setActionError("");
    try {
      const next = await run();
      if (action === "choose" && current === generation.current) setStatus(next as ComputerStatus);
    } catch (cause) {
      if (current === generation.current) setActionError(message(cause));
    } finally {
      changing.current = false;
      if (current === generation.current) {
        setBusy(null);
        void refresh();
      }
    }
  }

  const openPermission = (permission: ComputerPermission) => {
    setOpened((current) => ({ ...current, [permission]: Date.now() }));
    void act(permission, () => desktopBridge.computerSetup(permission));
  };

  if (!enabled) {
    return (
      <LayoutStack>
        <Summary state="off" detail="Computer use isn't turned on in this app." />
        <PrivateValues />
        <RememberedFileSharing />
        <RememberedFileSends client={fileSends} />
      </LayoutStack>
    );
  }

  const targets = status?.targets ?? [];
  const computer = targets.find((target) => target.id === status?.targetId)?.label ?? "This computer";
  const entry = status?.entry.name ?? "OpenWork";
  const verified = readError ? undefined : status?.permissions;
  const missing = PERMISSIONS.filter((permission) => verified?.[permission.id] !== true);
  const nextPermission = missing[0]?.id;
  const showPermissions = status?.placement === "local" && isMacPlatform() && !["unsupported", "unavailable"].includes(status.readiness);
  const helper = <span className="font-medium text-foreground" data-testid="settings-computer-entry">{entry}</span>;
  const state: SummaryState = readError ? "unavailable" : status?.readiness ?? "checking";
  const detail = readError ? `Couldn't check this computer. ${readError}`
    : !status ? undefined
      : status.readiness === "ready" ? `Every chat can use apps on ${status.placement === "local" ? "this computer" : computer}. While the agent works, the chat shows a live view with Take over and Stop.`
        : showPermissions && status.readiness === "setup-required" ? (missing.length === 1 ? `Turn on ${missing[0].title} below.` : "Turn on both macOS permissions below.")
          : status.detail;

  return (
    <LayoutStack>
      <Summary state={state} detail={detail} error={actionError}>
        {targets.length > 1 ? (
          <Select
            value={status?.targetId}
            items={targets.map((target) => ({ value: target.id, label: target.label }))}
            disabled={busy !== null}
            onValueChange={(value) => {
              if (value && value !== status?.targetId) void act("choose", () => desktopBridge.computerChoose(value));
            }}
          >
            <SelectTrigger className="w-44" aria-label="Computer" data-testid="settings-computer-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {targets.map((target) => <SelectItem key={target.id} value={target.id}>{target.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : status ? <span className="text-sm text-muted-foreground">{computer}</span> : null}
      </Summary>

      {showPermissions ? (
        <LayoutSection>
          <Group
            title="macOS permissions"
            count={verified ? `${PERMISSIONS.length - missing.length} of ${PERMISSIONS.length} on` : undefined}
            footnote={missing.length
              ? <>In System Settings, turn on {helper}, the helper OpenWork uses for computer use. If macOS offers Quit &amp; Reopen, either choice is fine: OpenWork stays open. {SEEN}</>
              : <>macOS lists both under {helper}, the helper OpenWork uses for computer use. {SEEN}</>}
          >
            {PERMISSIONS.map((permission) => {
              const on = verified?.[permission.id] === true;
              const openedAt = opened[permission.id];
              const waiting = !on && openedAt !== undefined;
              const stuck = waiting && now - openedAt > STUCK_AFTER_MS;
              return (
                <Row key={permission.id} data-testid={`settings-computer-permission-${permission.id}`} data-state={on ? "done" : waiting ? "waiting" : "todo"}>
                  <span className="flex h-5 shrink-0 items-center" aria-hidden>
                    {on ? <CircleCheck className="size-4 text-green-11" />
                      : waiting ? <LoaderCircle className="size-4 animate-spin text-amber-11 motion-reduce:animate-none" />
                        : <CircleDashed className="size-4 text-muted-foreground" />}
                  </span>
                  <RowText>
                    <LayoutSectionItemTitle>{permission.title}</LayoutSectionItemTitle>
                    <LayoutSectionItemDescription>{permission.purpose}</LayoutSectionItemDescription>
                    {stuck ? (status?.entry.ours
                      ? <div className="-ml-3 pt-1"><Button size="sm" variant="ghost" disabled={busy !== null} aria-busy={busy === "reset"} data-testid={`settings-computer-reset-${permission.id}`} onClick={() => void act("reset", () => desktopBridge.computerResetPermission(permission.id))}>Already on? Reset and ask again</Button></div>
                      : <LayoutSectionItemFootnote className="pt-1">Already on? Remove {entry} from the list with the minus button, then add it again.</LayoutSectionItemFootnote>) : null}
                  </RowText>
                  <div className="ml-auto flex shrink-0 items-center gap-3 self-center">
                    <span className={cn("text-sm", on ? "text-muted-foreground" : waiting ? "text-amber-11" : "sr-only")}>
                      {on ? "On" : waiting ? "Waiting for macOS" : "Off"}
                    </span>
                    {!on ? (
                      <Button size="sm" variant={nextPermission === permission.id ? "default" : "outline"} disabled={busy !== null || !verified} aria-busy={busy === permission.id} onClick={() => openPermission(permission.id)}>
                        Open {permission.title}
                      </Button>
                    ) : null}
                  </div>
                </Row>
              );
            })}
          </Group>
        </LayoutSection>
      ) : null}
      <PrivateValues />
      <RememberedFileSharing />
      <RememberedFileSends client={fileSends} />
    </LayoutStack>
  );
}

function Summary({ state, detail, error, children }: { state: SummaryState; detail?: string; error?: string; children?: ReactNode }) {
  const { icon: Icon, label, tile } = SUMMARY[state];
  return (
    <SettingsInset className="flex items-center gap-4 border-border">
      <div aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", tile)}>
        <Icon className="size-5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          role="status"
          data-testid={state === "off" ? undefined : "settings-computer-status"}
          data-state={state}
          className="text-sm font-medium text-foreground"
        >
          {state === "checking" ? <><span className="sr-only">{label}</span><Skeleton className="my-1 h-3 w-16 rounded-sm motion-reduce:animate-none" /></> : label}
        </div>
        {detail ? <p className="text-sm text-muted-foreground">{detail}</p>
          : state === "checking" ? <Skeleton className="my-1 h-3 w-72 max-w-full rounded-sm motion-reduce:animate-none" /> : null}
        {error ? <p role="alert" className="text-sm text-red-11">{error}</p> : null}
      </div>
      {children}
    </SettingsInset>
  );
}

function Group({ title, count, footnote, children }: { title: string; count?: string; footnote?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <LayoutSectionTitle>{title}</LayoutSectionTitle>
        {count ? <span className="text-sm tabular-nums text-muted-foreground">{count}</span> : null}
      </div>
      <ul className="flex flex-col divide-y divide-border border-y border-border">{children}</ul>
      {footnote ? <LayoutSectionItemFootnote>{footnote}</LayoutSectionItemFootnote> : null}
    </div>
  );
}

function Row({ className, ...props }: ComponentProps<"li">) {
  return <li className={cn("flex min-h-12 flex-wrap items-start gap-x-3 gap-y-2 py-3", className)} {...props} />;
}

function RowText({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">{children}</div>;
}

export type FileSendGrantsClient = Pick<OpenworkServerClient, "listFileSendGrants" | "removeFileSendGrant">;

const FILE_SEND_KINDS: Record<string, string> = {
  drive_upload_file: "Upload to Google Drive",
  drive_push_file: "Save files back to their drive",
  gmail_create_draft_with_attachments: "Attach files to Gmail drafts",
  outlook_create_draft_with_attachments: "Attach files to Outlook drafts",
};

export function RememberedFileSends({ client }: { client?: FileSendGrantsClient | null }) {
  const [state, setState] = useState<FileSendGrants | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const generation = useRef(0);

  async function refresh() {
    const current = ++generation.current;
    setError("");
    if (!client) { setState(null); return; }
    try {
      const next = await client.listFileSendGrants();
      if (current === generation.current) setState(next);
    } catch (cause) {
      if (current === generation.current) { setState(null); setError(`Couldn't check always-allowed file sends. Try again. ${message(cause)}`); }
    }
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    void readLatest();
    const focus = () => { if (document.visibilityState === "visible") void readLatest(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener(denSessionUpdatedEvent, focus);
    window.addEventListener(denSettingsChangedEvent, focus);
    return () => {
      generation.current++;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener(denSessionUpdatedEvent, focus);
      window.removeEventListener(denSettingsChangedEvent, focus);
    };
  }, [client]);

  async function remove(id: string) {
    if (removing || !client) return;
    const current = ++generation.current;
    setRemoving(id);
    setError("");
    try {
      const next = await client.removeFileSendGrant(id);
      if (current === generation.current) setState(next);
    } catch (cause) {
      if (current === generation.current) setError(`Couldn't remove permission. Try again. ${message(cause)}`);
    } finally {
      setRemoving(null);
    }
  }

  const grants = state?.enabled ? state.grants : [];
  if (!grants.length && !error) return null;
  return (
    <LayoutSection id="always-allowed-file-sends">
      <Group title="Always-allowed file sends" count={grants.length ? `${grants.length}` : undefined}>
        {grants.map((grant) => {
          const kind = FILE_SEND_KINDS[grant.kind] ?? grant.kind;
          return (
            <Row key={grant.id} className="items-center">
              <RowText>
                <LayoutSectionItemTitle className="flex-wrap gap-x-3">{kind}</LayoutSectionItemTitle>
                <LayoutSectionItemDescription className="break-all text-xs">
                  Files in <span dir="ltr" className="font-mono">{grant.directory}</span>, with {grant.account === "source" ? "the account each file came from" : <span dir="ltr" className="font-mono">{grant.account}</span>}
                </LayoutSectionItemDescription>
              </RowText>
              <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={removing !== null} aria-busy={removing === grant.id} aria-label={`Remove: ${kind} from ${grant.directory}`} onClick={() => void remove(grant.id)}>Remove</Button>
            </Row>
          );
        })}
        {error ? (
          <Row className="items-center">
            <div role="alert" className="min-w-0 flex-1 basis-64 text-sm text-red-11">{error}</div>
            <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void refresh()}>Try again</Button>
          </Row>
        ) : null}
      </Group>
    </LayoutSection>
  );
}

export function RememberedFileSharing() {
  const [state, setState] = useState<DesktopCommandResult<"computerListFileGrants"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const generation = useRef(0);

  async function refresh(clearIdentity = false) {
    const current = ++generation.current;
    setState((previous) => clearIdentity ? null : previous ? { enabled: previous.enabled, grants: [] } : null);
    setLoading(true);
    setError("");
    try {
      const next = await desktopBridge.computerListFileGrants();
      if (current === generation.current) setState(next);
    } catch (cause) {
      if (current === generation.current) setError(`Couldn't check remembered file sharing. Try again. ${message(cause)}`);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    if (!isElectronRuntime()) return;
    void readLatest(true);
    const focus = () => { if (document.visibilityState === "visible") void readLatest(); };
    const identity = () => { void readLatest(true); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener(denSessionUpdatedEvent, identity);
    window.addEventListener(denSettingsChangedEvent, identity);
    return () => {
      generation.current++;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener(denSessionUpdatedEvent, identity);
      window.removeEventListener(denSettingsChangedEvent, identity);
    };
  }, []);

  async function remove(id: string) {
    if (removing) return;
    const current = generation.current;
    setRemoving(id);
    setError("");
    try {
      const result = await desktopBridge.computerRemoveFileGrant(id);
      if (!result.ok) throw new Error("Permission wasn't removed.");
      if (current === generation.current) await refresh();
    } catch (cause) {
      if (current === generation.current) setError(`Couldn't remove permission. Try again. ${message(cause)}`);
    } finally {
      setRemoving(null);
    }
  }

  if (!state?.enabled && !error) return null;
  const grants = state?.grants ?? [];
  return (
    <LayoutSection id="remembered-file-sharing">
      <Group
        title="Remembered file sharing"
        count={!loading && grants.length ? `${grants.length} ${grants.length === 1 ? "folder" : "folders"}` : undefined}
      >
        {loading ? (
          <Row aria-label="Checking remembered file sharing" className="items-center">
            <RowText>
              <Skeleton className="my-1 h-3 w-48 rounded-sm motion-reduce:animate-none" />
              <Skeleton className="my-1 h-3 w-72 max-w-full rounded-sm motion-reduce:animate-none" />
            </RowText>
            <Skeleton className="ml-auto h-8 w-18 shrink-0 rounded-xl motion-reduce:animate-none" />
          </Row>
        ) : grants.map((grant) => (
          <Row key={grant.id} className="items-center">
            <RowText>
              <LayoutSectionItemTitle className="flex-wrap gap-x-3 break-all">
                <span dir="ltr" className="font-mono">{grant.origin}</span>
                {grant.blocked ? <span role="status" className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"><Lock aria-hidden className="size-3" />Blocked by your organization</span> : null}
              </LayoutSectionItemTitle>
              <LayoutSectionItemDescription className="break-all font-mono text-xs"><span dir="ltr">{grant.folder}</span></LayoutSectionItemDescription>
            </RowText>
            <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={removing !== null} aria-busy={removing === grant.id} aria-label={`Remove file sharing with ${grant.origin} from ${grant.folder}`} onClick={() => void remove(grant.id)}>Remove</Button>
          </Row>
        ))}
        {!loading && !error && state?.enabled && !grants.length ? (
          <Row className="items-center">
            <LayoutSectionItemDescription>No folders shared automatically. Choose a folder when approving a browser upload to remember it.</LayoutSectionItemDescription>
          </Row>
        ) : null}
        {error ? (
          <Row className="items-center">
            <div role="alert" className="min-w-0 flex-1 basis-64 text-sm text-red-11">{error}</div>
            <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void refresh()}>Try again</Button>
          </Row>
        ) : null}
      </Group>
    </LayoutSection>
  );
}

const PRIVATE_VALUES_REFRESH_MS = 15_000;

const PRIVATE_VALUE_SWITCHES: Array<{ name: PrivateValueSwitch; title: string; description: string }> = [
  { name: "commands", title: "Get values from commands", description: "OpenWork runs a command you approve, such as your password manager's, and puts what it prints where it is needed: a website field, a program or a request." },
  { name: "paste", title: "Paste values into the card", description: "The agent asks, you paste the value into OpenWork's own card, and it goes straight to where it is needed." },
  { name: "keep", title: "Keep a pasted value for the chat", description: "Offers to keep a value you paste until the chat ends or OpenWork quits, so you paste it once." },
];

const PRIVATE_VALUE_RESULTS: Record<string, string> = {
  filled: "Filled",
  declined: "You said no",
  blocked: "Blocked by your organization",
  off: "Turned off here",
};

const PRIVATE_VALUE_SOURCES: Record<PrivateValueSettings["recent"][number]["source"], string> = {
  command: "from a command",
  paste: "pasted",
  kept: "kept for the chat",
};

function OrganizationSet({ children = "Set by your organization" }: { children?: ReactNode }) {
  return <span role="status" className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"><Lock aria-hidden className="size-3" />{children}</span>;
}

export function PrivateValues() {
  const identity = useSyncExternalStore(subscribeGatewayUsageScope, () => readGatewayUsageScope().generation);
  const listed = useQuery({
    queryKey: ["private-values", identity],
    queryFn: () => desktopBridge.computerListPrivateValues(),
    enabled: isElectronRuntime(),
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: PRIVATE_VALUES_REFRESH_MS,
  });
  const [failed, setFailed] = useState("");
  const [changing, setChanging] = useState<string | null>(null);
  const state = listed.data;
  const error = failed || (listed.error ? `Couldn't check private values. Try again. ${message(listed.error)}` : "");

  async function refresh() {
    setFailed("");
    await listed.refetch();
  }

  async function change(id: string, problem: string, action: () => Promise<{ ok: boolean }>) {
    if (changing) return;
    setChanging(id);
    setFailed("");
    try {
      if (!(await action()).ok) throw new Error("Nothing changed.");
      await listed.refetch();
    } catch (cause) {
      setFailed(`${problem} Try again. ${message(cause)}`);
    } finally {
      setChanging(null);
    }
  }

  if (!state?.enabled) return null;
  const { organization, switches, always, kept, recent } = state;
  const blocked = organization.fills === "blocked";
  const locked: Record<PrivateValueSwitch, boolean> = {
    commands: blocked || organization.commands === "blocked",
    paste: blocked || organization.paste === "blocked",
    keep: blocked || organization.paste === "blocked",
  };
  const on: Record<PrivateValueSwitch, boolean> = {
    commands: switches.commands && !locked.commands,
    paste: switches.paste && !locked.paste,
    keep: switches.keep && switches.paste && !locked.keep,
  };
  const note = blocked ? "Your organization blocks filling private values on websites."
    : organization.fills === "limited" ? "Your organization limits the websites private values can be filled on."
    : organization.fills === "ask" ? "Your organization asks you before every fill, so Always isn't offered." : null;
  return (
    <LayoutSection id="private-values">
      <Group
        title="Private values"
        footnote={<>Passwords, codes and other values the agent puts into a website without seeing them. You approve every fill on a card in the chat.{note ? <> <span data-testid="settings-private-values-organization">{note}</span></> : null}</>}
      >
        {PRIVATE_VALUE_SWITCHES.map(({ name, title, description }) => (
          <Row key={name} className="items-center" data-testid={`settings-private-values-${name}`}>
            <RowText>
              <LayoutSectionItemTitle className="flex-wrap gap-x-3">
                {title}
                {locked[name] ? <OrganizationSet />
                  : name === "commands" && organization.commands === "limited" ? <OrganizationSet>Some commands are set by your organization</OrganizationSet> : null}
              </LayoutSectionItemTitle>
              <LayoutSectionItemDescription>{description}</LayoutSectionItemDescription>
            </RowText>
            <Switch
              className="ml-auto shrink-0"
              aria-label={title}
              checked={on[name]}
              disabled={locked[name] || changing !== null || (name === "keep" && !on.paste)}
              onCheckedChange={(checked) => void change(name, "Couldn't change the setting.", () => desktopBridge.computerSetPrivateValueSwitch(name, checked))}
            />
          </Row>
        ))}
        {error ? (
          <Row className="items-center">
            <div role="alert" className="min-w-0 flex-1 basis-64 text-sm text-red-11">{error}</div>
            <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void refresh()}>Try again</Button>
          </Row>
        ) : null}
      </Group>
      {always.length ? (
        <Group title="Always used without asking" count={`${always.length} ${always.length === 1 ? "choice" : "choices"}`} footnote="Each holds in the chat where you chose Always, until OpenWork quits.">
          {always.map((grant) => (
            <Row key={grant.id} className="items-center" data-testid="settings-private-values-always">
              <RowText>
                <LayoutSectionItemTitle className="flex-wrap gap-x-3 break-all">
                  <span dir="ltr" className="font-mono">{grant.site}</span>
                  {grant.blocked ? <OrganizationSet>Blocked by your organization</OrganizationSet> : null}
                </LayoutSectionItemTitle>
                <LayoutSectionItemDescription className="break-all text-xs">
                  {grant.command === undefined
                    ? <><span dir="ltr" className="font-mono">{grant.field}</span>, from the value you kept for this chat</>
                    : <>The {grant.field} field, from <span dir="ltr" className="font-mono">{grant.command}</span></>}
                </LayoutSectionItemDescription>
              </RowText>
              <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={changing !== null} aria-busy={changing === grant.id} data-testid="settings-private-values-always-remove" aria-label={`Ask again before using ${grant.command ?? "the value you kept"} for ${grant.site}`} onClick={() => void change(grant.id, "Couldn't remove it.", () => desktopBridge.computerRemovePrivateValue("always", grant.id))}>Remove</Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {kept.length ? (
        <Group title="Kept for a chat" count={`${kept.length} ${kept.length === 1 ? "value" : "values"}`} footnote="Kept in memory only, never on disk, until the chat ends or OpenWork quits.">
          {kept.map((entry) => (
            <Row key={entry.id} className="items-center" data-testid="settings-private-values-kept">
              <RowText>
                <LayoutSectionItemTitle className="break-all">{entry.label}</LayoutSectionItemTitle>
                <LayoutSectionItemDescription className="break-all text-xs">
                  {entry.program ? <>A key for <span dir="ltr" className="font-mono">{entry.program}</span></> : <span dir="ltr" className="font-mono">{entry.site}</span>}
                </LayoutSectionItemDescription>
              </RowText>
              <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={changing !== null} aria-busy={changing === entry.id} aria-label={`Forget ${entry.label}`} onClick={() => void change(entry.id, "Couldn't forget it.", () => desktopBridge.computerRemovePrivateValue("kept", entry.id))}>Forget</Button>
            </Row>
          ))}
        </Group>
      ) : null}
      {recent.length ? (
        <Group title="Recent fills" footnote="Since OpenWork started. No value is recorded.">
          {recent.map((entry, index) => (
            <Row key={`${entry.at}-${index}`} className="items-center" data-testid="settings-private-values-recent" data-result={entry.result}>
              <RowText>
                <LayoutSectionItemTitle className="break-all"><span dir="ltr" className="font-mono">{entry.site}</span></LayoutSectionItemTitle>
                <LayoutSectionItemDescription className="break-all text-xs">
                  The {entry.field} field, {PRIVATE_VALUE_SOURCES[entry.source]}{entry.program ? <> (<span dir="ltr" className="font-mono">{entry.program}</span>)</> : null}
                </LayoutSectionItemDescription>
              </RowText>
              <span className="ml-auto shrink-0 text-sm text-muted-foreground">
                {PRIVATE_VALUE_RESULTS[entry.result] ?? "Not filled"} · <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
              </span>
            </Row>
          ))}
        </Group>
      ) : null}
    </LayoutSection>
  );
}
