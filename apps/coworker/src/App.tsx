import { useCallback, useEffect, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import { readDenSession, writeDenSession, type DenSession } from "@/lib/den";
import { Button, ErrorNote } from "@/ui/kit";
import { NewCoworker } from "@/ui/new-coworker";
import { SignInGate } from "@/ui/sign-in";
import { CoworkerHome } from "@/ui/coworker-home";
import { CoworkerRail } from "@/ui/coworker-rail";

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bootError, setBootError] = useState("");
  const [session, setSession] = useState<DenSession | null>(() => readDenSession());
  const [coworkers, setBots] = useState<CoworkerSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const boot = useCallback(async () => {
    try {
      const info = await coworkerBridge.runtimeInfo();
      setRuntime(info);
      const list = await coworkerBridge.coworkers.list();
      setBots(list);
      setSelectedSlug((current) =>
        current && list.some((coworker) => coworker.slug === current) ? current : (list[0]?.slug ?? ""),
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
    const info = await coworkerBridge.runtimeInfo();
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
        <p className="text-sm text-mist">Starting your coworkers' home…</p>
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

  const selected = coworkers.find((coworker) => coworker.slug === selectedSlug) ?? null;

  function updateCoworkerInList(updated: CoworkerSummary) {
    setBots((current) => current.map((coworker) => (coworker.slug === updated.slug ? updated : coworker)));
  }

  function removeCoworkerFromList(slug: string) {
    const remaining = coworkers.filter((coworker) => coworker.slug !== slug);
    setBots(remaining);
    if (selectedSlug === slug) setSelectedSlug(remaining[0]?.slug ?? "");
  }

  return (
    <div className="flex h-full">
      <CoworkerRail
        coworkers={coworkers}
        selectedSlug={creating ? "" : selectedSlug}
        session={session}
        onSelect={(slug) => {
          setCreating(false);
          setSelectedSlug(slug);
        }}
        onNewCoworker={() => setCreating(true)}
        onConnect={() => setConnecting(true)}
        onSignOut={() => {
          writeDenSession(null);
          setSession(null);
        }}
      />
      {creating || !selected ? (
        <div className="min-w-0 flex-1">
          <NewCoworker
            onCancel={selected || coworkers.length > 0 ? () => setCreating(false) : null}
            onCreated={(coworker) => {
              setCreating(false);
              setBots((current) =>
                [...current.filter((item) => item.slug !== coworker.slug), coworker].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              setSelectedSlug(coworker.slug);
              void refreshRuntime();
            }}
          />
        </div>
      ) : (
        <CoworkerHome
          key={selected.slug}
          runtime={runtime}
          session={session}
          coworkers={coworkers}
          coworker={selected}
          onCoworkerChanged={updateCoworkerInList}
          onCoworkerRemoved={removeCoworkerFromList}
          onRefreshRuntime={refreshRuntime}
          onConnect={() => setConnecting(true)}
        />
      )}
    </div>
  );
}
