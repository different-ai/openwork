/** @jsxImportSource react */
import { useEffect, useEffectEvent, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { CircleCheck, CircleDashed, LoaderCircle, Lock, Monitor, MonitorCheck, MonitorCog, MonitorOff, MonitorX, type LucideIcon } from "lucide-react";
import type { ComputerPermission, ComputerStatus, DesktopCommandResult } from "@openwork/types/desktop-ipc";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";

import { desktopBridge } from "@/app/lib/desktop";
import { isElectronRuntime, isMacPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDesktopFeature } from "../../session/status/use-desktop-feature";
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
/** What the summary reports: the helper's readiness, or that nothing was read. */
type SummaryState = ComputerStatus["readiness"] | "checking" | "off";

const PERMISSIONS: Array<{ id: ComputerPermission; title: string; purpose: string }> = [
  { id: "accessibility", title: "Accessibility", purpose: "Use app controls, the mouse and the keyboard in Mac apps." },
  { id: "screenRecording", title: "Screen Recording", purpose: "See app windows. macOS may call it Screen & System Audio Recording." },
];
// After opening a pane, give macOS a moment before offering the stale-entry fix.
const STUCK_AFTER_MS = 15_000;

// Color marks only what needs the person: ready is confirmed, setup is theirs to finish.
const SUMMARY: Record<SummaryState, { icon: LucideIcon; label: string; tile: string }> = {
  ready: { icon: MonitorCheck, label: "Ready", tile: "bg-green-3 text-green-11" },
  "setup-required": { icon: MonitorCog, label: "Setup needed", tile: "bg-amber-3 text-amber-11" },
  unsupported: { icon: MonitorOff, label: "Not supported", tile: "bg-muted text-muted-foreground" },
  unavailable: { icon: MonitorX, label: "Unavailable", tile: "bg-muted text-muted-foreground" },
  checking: { icon: Monitor, label: "Checking", tile: "bg-muted text-muted-foreground" },
  off: { icon: Lock, label: "Not turned on", tile: "bg-muted text-muted-foreground" },
};

// What turning the permissions on shares, said wherever they are listed.
const SEEN = "The agent sees the app window it is using, and its content goes to your AI model provider.";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Settings > Computer use, for the desktop app with the `computerUse` feature. */
export function ComputerUseView() {
  const enabled = useDesktopFeature("computerUse") && isElectronRuntime();
  return <ComputerUseSettings enabled={enabled} />;
}

/**
 * Computer use is set up once, here, for every chat. Each status comes from a
 * fresh helper probe; opening a System Settings pane never grants anything.
 */
export function ComputerUseSettings({ enabled }: { enabled: boolean }) {
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
    // macOS reports no event when a permission changes; check while this page is open.
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
        <RememberedFileSharing />
      </LayoutStack>
    );
  }

  const targets = status?.targets ?? [];
  const computer = targets.find((target) => target.id === status?.targetId)?.label ?? "This computer";
  const entry = status?.entry.name ?? "OpenWork";
  const verified = readError ? undefined : status?.permissions;
  const missing = PERMISSIONS.filter((permission) => verified?.[permission.id] !== true);
  const nextPermission = missing[0]?.id;
  // System permissions exist only for this Mac; Windows and VMs need none.
  const showPermissions = status?.placement === "local" && isMacPlatform() && !["unsupported", "unavailable"].includes(status.readiness);
  const helper = <span className="font-medium text-foreground" data-testid="settings-computer-entry">{entry}</span>;
  const state: SummaryState = readError ? "unavailable" : status?.readiness ?? "checking";
  const detail = readError ? `Couldn't check this computer. ${readError}`
    : !status ? undefined
      // The helper's own wording addresses one chat and points at a setup screen; this page is that screen, for every chat.
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
      <RememberedFileSharing />
    </LayoutStack>
  );
}

/** The page's focal element: the one state every chat depends on, and where it applies. */
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
          // Off is not a readiness: nothing was asked of the helper.
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

/** A titled list of rows between hairlines, with what it holds counted on the right. */
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
  // Narrow panes: the state and action drop below the text instead of squeezing it.
  return <li className={cn("flex min-h-12 flex-wrap items-start gap-x-3 gap-y-2 py-3", className)} {...props} />;
}

function RowText({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">{children}</div>;
}

/** Main owns identity, feature checks and grants. The renderer only lists and revokes. */
export function RememberedFileSharing() {
  const [state, setState] = useState<DesktopCommandResult<"computerListFileGrants"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const generation = useRef(0);

  async function refresh(clearIdentity = false) {
    const current = ++generation.current;
    // Never retain one account's folders as a fallback for another account or a failed read.
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
