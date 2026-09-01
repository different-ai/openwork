import { useState } from "react";
import type { BotSummary, RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
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
  bot,
  onBotChanged,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  bot: BotSummary;
  onBotChanged: (bot: BotSummary) => void;
}) {
  const [tab, setTab] = useState<TabId>("work");

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="border-b border-line bg-panel px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-snow">{bot.name}</h1>
            <p className="truncate text-sm text-mist">{bot.role || bot.mission || "Persistent worker"}</p>
          </div>
          <p className="shrink-0 text-xs text-mist">
            {runtime.engineManaged ? "engine ready" : "engine offline"}
          </p>
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
        {tab === "work" ? <ThreadsPanel runtime={runtime} bot={bot} /> : null}
        {tab === "responsibilities" ? (
          session ? (
            <ResponsibilitiesPanel session={session} bot={bot} onBotChanged={onBotChanged} />
          ) : (
            <p className="text-sm text-mist">
              Connect your OpenWork account to give {bot.name} scheduled responsibilities. They run
              on OpenWork Cloud and keep working while this app is closed.
            </p>
          )
        ) : null}
        {tab === "memory" ? <MemoryPanel bot={bot} /> : null}
      </main>
    </div>
  );
}
