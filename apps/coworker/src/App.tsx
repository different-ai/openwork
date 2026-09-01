import { useCallback, useEffect, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import { createDenAutomationsClient, readDenSession, writeDenSession, type DenSession } from "@/lib/den";
import { readCoworkerActivity, type CoworkerActivity } from "@/lib/threads";
import { Button, ErrorNote } from "@/ui/kit";
import { NewCoworker } from "@/ui/new-coworker";
import { SignInGate } from "@/ui/sign-in";
import { CoworkerHome } from "@/ui/coworker-home";
import { CoworkerRail } from "@/ui/coworker-rail";
import { OnboardingWelcome } from "@/ui/onboarding";
import { AppLoader, CoworkerMark } from "@/ui/brand";

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bootError, setBootError] = useState("");
  const [session, setSession] = useState<DenSession | null>(() => readDenSession());
  const [coworkers, setBots] = useState<CoworkerSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(false);
  const [openConfigurationSignal, setOpenConfigurationSignal] = useState(0);
  const [activityBySlug, setActivityBySlug] = useState<Record<string, CoworkerActivity>>({});
  const [attentionBySlug, setAttentionBySlug] = useState<Record<string, string>>({});

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

  useEffect(() => {
    if (!runtime) return;
    let cancelled = false;
    const refreshActivity = async () => {
      const entries = await Promise.all(
        coworkers.map(async (coworker) => {
          if (!coworker.workspaceId) {
            return [
              coworker.slug,
              { state: "offline", label: "Setting up", detail: "Workspace is not ready", updatedAt: 0 },
            ] as const;
          }
          const [threadActivity, localResponsibilities] = await Promise.all([
            readCoworkerActivity({
              serverUrl: runtime.serverUrl,
              workspaceId: coworker.workspaceId,
              token: runtime.ownerToken,
            }),
            coworkerBridge.localResponsibilities.list(coworker.slug).catch(() => []),
          ]);
          const localRunning = localResponsibilities.find((item) => item.latestRun?.status === "running");
          const localSuccess = localResponsibilities
            .filter((item) => item.latestRun?.status === "succeeded")
            .sort((left, right) => (right.latestRun?.finishedAt ?? 0) - (left.latestRun?.finishedAt ?? 0))[0];
          const localSuccessAt = localSuccess?.latestRun?.finishedAt ?? 0;
          const latestActivity = localSuccess && localSuccessAt > (threadActivity.last?.updatedAt ?? 0)
            ? { title: localSuccess.name, updatedAt: localSuccessAt, threadId: localSuccess.latestRun?.threadId }
            : threadActivity.last;
          if (localRunning?.latestRun) {
            return [
              coworker.slug,
              {
                state: "working",
                label: "Working",
                detail: localRunning.name,
                updatedAt: localRunning.latestRun.startedAt,
                ...(localRunning.latestRun.threadId ? { threadId: localRunning.latestRun.threadId } : {}),
                ...(latestActivity ? { last: latestActivity } : {}),
              },
            ] as const;
          }
          const localFailure = localResponsibilities
            .filter((item) => item.latestRun?.status === "failed")
            .sort((left, right) => (right.latestRun?.finishedAt ?? 0) - (left.latestRun?.finishedAt ?? 0))[0];
          if (localFailure?.latestRun) {
            return [
              coworker.slug,
              {
                state: "attention",
                label: "Local run needs you",
                detail: localFailure.latestRun.error || localFailure.name,
                updatedAt: localFailure.latestRun.finishedAt ?? localFailure.latestRun.startedAt,
                ...(localFailure.latestRun.threadId ? { threadId: localFailure.latestRun.threadId } : {}),
                ...(latestActivity ? { last: latestActivity } : {}),
              },
            ] as const;
          }
          return [coworker.slug, latestActivity ? { ...threadActivity, last: latestActivity } : threadActivity] as const;
        }),
      );
      if (!cancelled) setActivityBySlug(Object.fromEntries(entries));
    };
    void refreshActivity();
    const timer = window.setInterval(() => void refreshActivity(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtime, coworkers]);

  useEffect(() => {
    if (!session) {
      setAttentionBySlug({});
      return;
    }
    let cancelled = false;
    const den = createDenAutomationsClient(session);
    const refreshAttention = async () => {
      try {
        const list = await den.list();
        const next: Record<string, string> = {};
        for (const coworker of coworkers) {
          const attention = list.items.find(
            (entry) =>
              entry.automation.state === "needs_attention" &&
              (coworker.automations.includes(entry.automation.id) ||
                Boolean(coworker.workspaceId && entry.revision.workspaceId === coworker.workspaceId)),
          );
          if (attention) {
            next[coworker.slug] =
              attention.automation.needsAttentionReason?.message || attention.automation.name;
          }
        }
        if (!cancelled) setAttentionBySlug(next);
      } catch {
        // The responsibilities rail presents connection errors in context.
      }
    };
    void refreshAttention();
    const timer = window.setInterval(() => void refreshAttention(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session, coworkers]);

  const refreshRuntime = useCallback(async () => {
    const info = await coworkerBridge.runtimeInfo();
    setRuntime(info);
  }, []);

  if (bootError) {
    return (
      <div className="window-shell window-drag flex h-full items-center justify-center p-8">
        <div className="window-no-drag w-full max-w-md rounded-[26px] border border-line bg-ink/88 p-7 text-center">
          <CoworkerMark className="mx-auto" label="Open Coworker" size={64} />
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.025em] text-snow">Open Coworker needs a moment</h1>
          <p className="mb-5 mt-1 text-sm text-mist">The local workspace could not finish starting.</p>
          <ErrorNote>{bootError}</ErrorNote>
          <Button className="mt-4 w-full" onClick={() => void boot()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!runtime) {
    return <AppLoader />;
  }

  if (connecting) {
    return (
      <SignInGate
        denBaseUrl={runtime.denBaseUrl}
        onSignedIn={(next) => {
          writeDenSession(next);
          setSession(next);
          setConnecting(false);
          if (coworkers.length === 0) {
            setOnboardingReady(true);
            setCreating(true);
          }
        }}
        onDismiss={() => setConnecting(false)}
      />
    );
  }

  if (coworkers.length === 0 && !onboardingReady && !creating) {
    return (
      <OnboardingWelcome
        onConnect={() => setConnecting(true)}
        onContinueLocally={() => {
          setOnboardingReady(true);
          setCreating(true);
        }}
      />
    );
  }

  const selected = coworkers.find((coworker) => coworker.slug === selectedSlug) ?? null;
  const visibleActivityBySlug: Record<string, CoworkerActivity> = {};
  for (const coworker of coworkers) {
    const attention = attentionBySlug[coworker.slug];
    const activity = activityBySlug[coworker.slug];
    if (attention) {
      visibleActivityBySlug[coworker.slug] = {
        state: "attention",
        label: "Needs you",
        detail: attention,
        updatedAt: activity?.updatedAt ?? 0,
        ...(activity?.last ? { last: activity.last } : {}),
      };
    } else if (activity) {
      visibleActivityBySlug[coworker.slug] = activity;
    }
  }

  function updateCoworkerInList(updated: CoworkerSummary) {
    setBots((current) => current.map((coworker) => (coworker.slug === updated.slug ? updated : coworker)));
  }

  function removeCoworkerFromList(slug: string) {
    const remaining = coworkers.filter((coworker) => coworker.slug !== slug);
    setBots(remaining);
    if (selectedSlug === slug) {
      setOpenConfigurationSignal(0);
      setSelectedSlug(remaining[0]?.slug ?? "");
    }
  }

  return (
    <div className="window-shell flex h-full overflow-hidden">
      <CoworkerRail
        runtime={runtime}
        session={session}
        coworkers={coworkers}
        activityBySlug={visibleActivityBySlug}
        selectedSlug={creating ? "" : selectedSlug}
        onSelect={(slug) => {
          setCreating(false);
          setOpenConfigurationSignal(0);
          setSelectedSlug(slug);
        }}
        onNewCoworker={() => {
          setOpenConfigurationSignal(0);
          setCreating(true);
        }}
        onOpenOpenWork={() => {
          if (!selected) {
            setConnecting(true);
            return;
          }
          setCreating(false);
          setOpenConfigurationSignal((value) => value + 1);
        }}
      />
      {creating || !selected ? (
        <div className="min-w-0 flex-1">
          <NewCoworker
            runtime={runtime}
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
          activity={visibleActivityBySlug[selected.slug]}
          onCoworkerChanged={updateCoworkerInList}
          onCoworkerRemoved={removeCoworkerFromList}
          onRefreshRuntime={refreshRuntime}
          onConnect={() => setConnecting(true)}
          onSignOut={() => {
            writeDenSession(null);
            setSession(null);
          }}
          openConfigurationSignal={openConfigurationSignal}
        />
      )}
    </div>
  );
}
