import { useEffect, useState } from "react";
import { workbot, type BotSummary, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { Button, ErrorNote } from "@/ui/kit";
import { MemoryPanel } from "@/ui/memory";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import { ThreadsPanel } from "@/ui/threads";

const TABS = [
  { id: "work", label: "Work" },
  { id: "responsibilities", label: "Responsibilities" },
  { id: "memory", label: "Memory" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function WorkerHome({
  runtime,
  session,
  bots,
  bot,
  onBotChanged,
  onBotRemoved,
  onRefreshRuntime,
  onConnect,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  bots: BotSummary[];
  bot: BotSummary;
  onBotChanged: (bot: BotSummary) => void;
  onBotRemoved: (slug: string) => void;
  onRefreshRuntime: () => Promise<void>;
  onConnect: () => void;
}) {
  const [tab, setTab] = useState<TabId>("work");
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  // Guard the destructive confirm against a stray double-click on "Retire…":
  // the confirm button stays inert for a moment after it appears.
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [retireBusy, setRetireBusy] = useState(false);
  const [retireError, setRetireError] = useState("");

  useEffect(() => {
    if (!confirmingRetire) {
      setConfirmArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setConfirmArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [confirmingRetire]);

  async function retire() {
    setRetireBusy(true);
    setRetireError("");
    try {
      await workbot.bots.remove(bot.slug);
      onBotRemoved(bot.slug);
    } catch (cause) {
      setRetireError(cause instanceof Error ? cause.message : String(cause));
      setRetireBusy(false);
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="border-b border-line bg-panel px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-snow">{bot.name}</h1>
            <p className="truncate text-sm text-mist">{bot.role || bot.mission || "Persistent worker"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p className="text-xs text-mist">{runtime.engineManaged ? "engine ready" : "engine offline"}</p>
            {confirmingRetire ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-rose">Delete this worker and all its files?</span>
                <Button variant="ghost" disabled={retireBusy} onClick={() => setConfirmingRetire(false)}>
                  Keep worker
                </Button>
                <Button variant="danger" disabled={retireBusy || !confirmArmed} onClick={() => void retire()}>
                  {retireBusy ? "Deleting…" : "Delete forever"}
                </Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingRetire(true)}>
                Retire…
              </Button>
            )}
          </div>
        </div>
        <nav className="mt-3 flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                tab === item.id ? "bg-panel-2 text-snow" : "text-mist hover:text-snow"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        {retireError ? <ErrorNote>{retireError}</ErrorNote> : null}
        {!runtime.engineManaged && runtime.engineError ? (
          <p className="mb-4 rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-sm text-amber">
            The worker engine is offline: {runtime.engineError}. Install the OpenCode engine or set
            OPENWORK_OPENCODE_BIN, then reopen Work Bot.
          </p>
        ) : null}
        {tab === "work" ? (
          <ThreadsPanel runtime={runtime} bot={bot} onBotChanged={onBotChanged} onRefreshRuntime={onRefreshRuntime} />
        ) : null}
        {tab === "responsibilities" ? (
          session ? (
            <ResponsibilitiesPanel session={session} bots={bots} bot={bot} onBotChanged={onBotChanged} />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-mist">
                Connect your OpenWork account to give {bot.name} scheduled responsibilities. They run
                on OpenWork Cloud and keep working while this app is closed.
              </p>
              <Button variant="primary" onClick={onConnect}>
                Connect OpenWork account
              </Button>
            </div>
          )
        ) : null}
        {tab === "memory" ? <MemoryPanel bot={bot} /> : null}
      </main>
    </div>
  );
}
