/** @jsxImportSource react */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Triangle } from "lucide-react";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteSessionAccessState } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { ComposerNoticeCard } from "../cloud/gateway-usage-panel";
import { lockedReason, sessionAccessQueryKey } from "./session-access-section";

/** What the owner can allow from the ask; turning the computer off is its own button. */
export type RemoteAccessAskLevel = Exclude<RemoteSessionAccessMode, "off">;
export type RemoteAccessAskOption = { mode: RemoteAccessAskLevel; label: string; description: string; locked: string | null };

/** Widest first: the button starts on the first one that can apply. */
const LEVELS: ReadonlyArray<Omit<RemoteAccessAskOption, "locked">> = [
  { mode: "all", label: "Allow all tasks", description: "Start tasks here and open, continue, stop and answer any session on this computer, including ones you started." },
  { mode: "created", label: "Allow starting tasks", description: "Start tasks here and follow, continue and answer only the ones they start." },
];

const SAVED: Record<RemoteSessionAccessMode, string> = {
  all: "All tasks allowed on this computer",
  created: "Starting tasks allowed on this computer",
  off: "This computer stays off for other devices",
};

/** An unanswered ask is read again this often: the organization's opt-in and limit arrive when the computer checks in. */
const ASK_REFRESH_MS = 60_000;

/**
 * What to ask the owner of a computer that takes nothing only because they never chose (the organization's opt-in):
 * the levels on offer, each locked with its reason where it cannot apply, and the one the button starts on. Null when
 * there is nothing to ask: no organization, no opt-in, a choice already made, or nothing the owner could allow.
 */
export function remoteAccessAsk(state: RemoteSessionAccessState | undefined): { options: RemoteAccessAskOption[]; initial: RemoteAccessAskOption } | null {
  if (!state || !state.connected || !state.optIn || state.mode !== null) return null;
  const options = LEVELS.map(level => ({ ...level, locked: lockedReason(level.mode, state) }));
  const initial = options.find(option => option.locked === null);
  return initial ? { options, initial } : null;
}

/**
 * Asks the owner, above the composer, what their other devices, Workbot and agents may do on this computer. Shown only
 * while the organization's opt-in leaves the computer off for want of a choice, which until now was made only in
 * Settings › Devices. Either answer is the owner's choice, so the ask does not come back. Desktop only.
 */
export function RemoteAccessAsk() {
  const bridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__?.remoteSessionAccess;
  if (!bridge?.get || !bridge.set) return null;
  return <RemoteAccessAskCard read={bridge.get} write={bridge.set} />;
}

export function RemoteAccessAskCard({ read, write }: {
  read: () => Promise<RemoteSessionAccessState>;
  write: (mode: RemoteSessionAccessMode) => Promise<RemoteSessionAccessState>;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: sessionAccessQueryKey,
    queryFn: () => read(),
    retry: false,
    refetchInterval: current => current.state.data?.mode ? false : ASK_REFRESH_MS,
  });
  const [picked, setPicked] = useState<RemoteAccessAskLevel | null>(null);
  const [saving, setSaving] = useState(false);
  const ask = remoteAccessAsk(query.data);
  if (!ask) return null;
  // A level that locked after it was picked (the organization lowered its limit) falls back to what can apply.
  const level = ask.options.find(option => option.mode === picked && option.locked === null) ?? ask.initial;

  async function choose(mode: RemoteSessionAccessMode) {
    setSaving(true);
    try {
      client.setQueryData(sessionAccessQueryKey, await write(mode));
      toast.success(`${SAVED[mode]}. Change it in Settings › Devices.`);
    } catch {
      toast.error("Couldn't save this choice. Try again.");
    }
    setSaving(false);
  }

  return (
    <div role="status">
      <ComposerNoticeCard
        testId="remote-access-ask"
        icon={<Laptop />}
        title="Let Workbot and your other devices work on this computer?"
        actions={<>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void choose("off")}>Keep it off</Button>
          {/* One button in two parts: the shadow sits on the pair, so neither part casts one onto the other. */}
          <div className="flex items-center rounded-xl shadow-xs/5">
            <Button size="sm" className="rounded-e-none border-e-0 pe-1.5 shadow-none before:rounded-e-none" disabled={saving} data-testid="remote-access-ask-allow" onClick={() => void choose(level.mode)}>{level.label}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" className="rounded-s-none border-s-0 pe-2.5 ps-1 shadow-none before:rounded-s-none" disabled={saving} aria-label="Choose what to allow" />}>
                <Triangle aria-hidden="true" fill="currentColor" strokeWidth={0} className="size-1.5 rotate-180 opacity-55" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuRadioGroup value={level.mode} onValueChange={next => { if (next === "all" || next === "created") setPicked(next); }}>
                  {ask.options.map(option => (
                    <DropdownMenuRadioItem key={option.mode} value={option.mode} disabled={option.locked !== null} closeOnClick className="items-start">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{option.label}</span>
                        <span className="text-xs font-normal text-muted-foreground">{option.locked ?? option.description}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>}
      />
    </div>
  );
}
