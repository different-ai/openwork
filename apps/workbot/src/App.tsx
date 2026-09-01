import { useCallback, useEffect, useState } from "react";
import { workbot, type BotSummary, type RuntimeInfo } from "@/lib/bridge";
import { readDenSession, writeDenSession, type DenSession } from "@/lib/den";
import { Button, ErrorNote } from "@/ui/kit";
import { NewWorker } from "@/ui/new-worker";
import { SignInGate } from "@/ui/sign-in";
import { WorkerHome } from "@/ui/worker-home";
import { WorkerRail } from "@/ui/worker-rail";

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bootError, setBootError] = useState("");
  const [session, setSession] = useState<DenSession | null>(() => readDenSession());
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const boot = useCallback(async () => {
    try {
      const info = await workbot.runtimeInfo();
      setRuntime(info);
      const list = await workbot.bots.list();
      setBots(list);
      setSelectedSlug((current) =>
        current && list.some((bot) => bot.slug === current) ? current : (list[0]?.slug ?? ""),
      );
      setBootError("");
    } catch (cause) {
      setBootError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const refreshRuntime = useCallback(async () => {
    const info = await workbot.runtimeInfo();
    setRuntime(info);
  }, []);

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-md space-y-4">
          <ErrorNote>{bootError}</ErrorNote>
          <Button className="w-full" onClick={() => void boot()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!runtime) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-mist">Starting your workers' home…</p>
      </div>
    );
  }

  const mustSignIn = !session && !runtime.allowOffline;
  if (mustSignIn || connecting) {
    return (
      <SignInGate
        denBaseUrl={runtime.denBaseUrl}
        onSignedIn={(next) => {
          writeDenSession(next);
          setSession(next);
          setConnecting(false);
        }}
        onDismiss={mustSignIn ? null : () => setConnecting(false)}
      />
    );
  }

  const selected = bots.find((bot) => bot.slug === selectedSlug) ?? null;

  function updateBotInList(updated: BotSummary) {
    setBots((current) => current.map((bot) => (bot.slug === updated.slug ? updated : bot)));
  }

  function removeBotFromList(slug: string) {
    const remaining = bots.filter((bot) => bot.slug !== slug);
    setBots(remaining);
    if (selectedSlug === slug) setSelectedSlug(remaining[0]?.slug ?? "");
  }

  return (
    <div className="flex h-full">
      <WorkerRail
        bots={bots}
        selectedSlug={creating ? "" : selectedSlug}
        session={session}
        onSelect={(slug) => {
          setCreating(false);
          setSelectedSlug(slug);
        }}
        onNewWorker={() => setCreating(true)}
        onConnect={() => setConnecting(true)}
        onSignOut={() => {
          writeDenSession(null);
          setSession(null);
        }}
      />
      {creating || !selected ? (
        <div className="min-w-0 flex-1">
          <NewWorker
            onCancel={selected || bots.length > 0 ? () => setCreating(false) : null}
            onCreated={(bot) => {
              setCreating(false);
              setBots((current) =>
                [...current.filter((item) => item.slug !== bot.slug), bot].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              setSelectedSlug(bot.slug);
              void refreshRuntime();
            }}
          />
        </div>
      ) : (
        <WorkerHome
          key={selected.slug}
          runtime={runtime}
          session={session}
          bots={bots}
          bot={selected}
          onBotChanged={updateBotInList}
          onBotRemoved={removeBotFromList}
          onRefreshRuntime={refreshRuntime}
          onConnect={() => setConnecting(true)}
        />
      )}
    </div>
  );
}
