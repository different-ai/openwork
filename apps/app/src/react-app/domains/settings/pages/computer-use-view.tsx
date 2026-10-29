/** @jsxImportSource react */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ComputerPermission, ComputerStatus } from "@openwork/types/desktop-ipc";

import { desktopBridge } from "@/app/lib/desktop";
import { isElectronRuntime, isMacPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useDesktopFeature } from "../../session/status/use-desktop-feature";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

type Busy = "choose" | "reset" | ComputerPermission | null;

const PERMISSIONS: Array<{ id: ComputerPermission; title: string; purpose: string }> = [
  { id: "accessibility", title: "Accessibility", purpose: "Use app controls, the mouse and the keyboard in Mac apps." },
  { id: "screenRecording", title: "Screen Recording", purpose: "See app windows. macOS may call it Screen & System Audio Recording." },
];
// After opening a pane, give macOS a moment before offering the stale-entry fix.
const STUCK_AFTER_MS = 15_000;

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function statusLabel(readiness: ComputerStatus["readiness"]) {
  switch (readiness) {
    case "ready":
      return "Ready";
    case "setup-required":
      return "Setup needed";
    case "unsupported":
      return "Not supported";
    default:
      return "Unavailable";
  }
}

/**
 * Computer use is set up once, here, for every chat. Each status comes from a
 * fresh helper probe; opening a System Settings pane never grants anything.
 */
export function ComputerUseView() {
  const enabled = useDesktopFeature("computerUse") && isElectronRuntime();
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
        <LayoutSection>
          <LayoutSectionHeader>
            <LayoutSectionTitle>Not turned on</LayoutSectionTitle>
            <LayoutSectionDescription>Computer use isn't turned on in this app.</LayoutSectionDescription>
          </LayoutSectionHeader>
        </LayoutSection>
      </LayoutStack>
    );
  }

  const targets = status?.targets ?? [];
  const computer = targets.find((target) => target.id === status?.targetId)?.label ?? "This computer";
  const entry = status?.entry.name ?? "OpenWork";
  const verified = readError ? undefined : status?.permissions;
  const nextPermission = PERMISSIONS.find((permission) => verified?.[permission.id] !== true)?.id;
  // System permissions exist only for this Mac; Windows and VMs need none.
  const showPermissions = status?.placement === "local" && isMacPlatform() && !["unsupported", "unavailable"].includes(status.readiness);
  const state = readError ? "unavailable" : status?.readiness;

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Setup</LayoutSectionTitle>
          <LayoutSectionDescription>
            The agent uses apps on your computer when a task needs one. Set it up once here and every chat can use it. While it works, the chat shows a live view with Take over and Stop.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader className="min-h-10 items-center">
            <LayoutSectionItemTitle>Computer</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>Where the agent works.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions className="self-center">
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
              ) : <span className="text-sm text-foreground">{computer}</span>}
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Status</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {readError ? `Couldn't check this computer. ${readError}`
                // The helper's own detail points at a setup screen; this page is that screen.
                : showPermissions && status.readiness === "setup-required" ? "Turn on both macOS permissions below."
                  : status?.detail ?? "Checking…"}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <span
                role="status"
                data-testid="settings-computer-status"
                data-state={state ?? "checking"}
                className={cn("text-sm", state === "ready" ? "text-green-11" : state === "setup-required" ? "text-amber-11" : "text-muted-foreground")}
              >
                {state ? statusLabel(state) : "Checking"}
              </span>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          {actionError ? <LayoutSectionItemFootnote className="text-red-11"><span role="alert">{actionError}</span></LayoutSectionItemFootnote> : null}
        </LayoutSectionItem>
      </LayoutSection>

      {showPermissions ? (
        <LayoutSection>
          <LayoutSectionHeader>
            <LayoutSectionTitle>macOS permissions</LayoutSectionTitle>
            <LayoutSectionDescription>
              In System Settings, turn on <span className="font-medium text-foreground" data-testid="settings-computer-entry">{entry}</span> for both permissions. This page updates on its own.
            </LayoutSectionDescription>
          </LayoutSectionHeader>

          {PERMISSIONS.map((permission) => {
            const on = verified?.[permission.id] === true;
            const openedAt = opened[permission.id];
            const waiting = !on && openedAt !== undefined;
            const stuck = waiting && now - openedAt > STUCK_AFTER_MS;
            return (
              <LayoutSectionItem key={permission.id}>
                <LayoutSectionItemHeader>
                  <LayoutSectionItemTitle>{permission.title}</LayoutSectionItemTitle>
                  <LayoutSectionItemDescription>{permission.purpose}</LayoutSectionItemDescription>
                  <LayoutSectionItemHeaderActions>
                    <span
                      data-testid={`settings-computer-permission-${permission.id}`}
                      data-state={on ? "done" : waiting ? "waiting" : "todo"}
                      className={cn("text-sm", on ? "text-green-11" : waiting ? "text-amber-11" : "text-muted-foreground")}
                    >
                      {on ? "On" : waiting ? "Waiting for macOS" : "Off"}
                    </span>
                    {!on ? (
                      <Button size="sm" variant={nextPermission === permission.id ? "default" : "outline"} disabled={busy !== null || !verified} aria-busy={busy === permission.id} onClick={() => openPermission(permission.id)}>
                        Open {permission.title}
                      </Button>
                    ) : null}
                  </LayoutSectionItemHeaderActions>
                </LayoutSectionItemHeader>
                {stuck ? (status?.entry.ours
                  ? <div><Button size="sm" variant="ghost" disabled={busy !== null} aria-busy={busy === "reset"} data-testid={`settings-computer-reset-${permission.id}`} onClick={() => void act("reset", () => desktopBridge.computerResetPermission(permission.id))}>Already on? Reset and ask again</Button></div>
                  : <LayoutSectionItemFootnote>Already on? Remove {entry} from the list with the minus button, then add it again.</LayoutSectionItemFootnote>) : null}
              </LayoutSectionItem>
            );
          })}

          <LayoutSectionItem>
            <LayoutSectionItemFootnote>
              macOS lists them under {entry}, the helper OpenWork uses for computer use. The agent still sees the app window it is using, and its content goes to your AI model provider. If macOS offers Quit &amp; Reopen, either choice is fine: OpenWork stays open and this page checks again on its own.
            </LayoutSectionItemFootnote>
          </LayoutSectionItem>
        </LayoutSection>
      ) : null}
    </LayoutStack>
  );
}
