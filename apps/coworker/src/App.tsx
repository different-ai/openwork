import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import {
  createDenAutomationsClient,
  exchangeGrant,
  parsePastedGrant,
  providerSyncSession,
  readDenSession,
  writeDenSession,
  type DenSession,
} from "@/lib/den";
import { readCoworkerActivity, type CoworkerActivity } from "@/lib/threads";
import { Button, ErrorNote } from "@/ui/kit";
import { NewCoworker } from "@/ui/new-coworker";
import { SignInGate } from "@/ui/sign-in";
import { CoworkerHome } from "@/ui/coworker-home";
import { CoworkerRail } from "@/ui/coworker-rail";
import { OnboardingWelcome } from "@/ui/onboarding";
import { AppLoader, CoworkerMark } from "@/ui/brand";
import { OpenWorkSettings, type SettingsSection } from "@/ui/openwork-settings";

/** Identity of a pushed account context; the server itself no-ops on a repeat. */
function sessionKey(session: DenSession): string {
  return `${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`;
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bootError, setBootError] = useState("");
  const [session, setSession] = useState<DenSession | null>(() => readDenSession());
  const [providerSync, setProviderSync] = useState<ProviderSyncRun | null>(null);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [coworkers, setBots] = useState<CoworkerSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(false);
  const [globalSettings, setGlobalSettings] = useState<SettingsSection | null>(null);
  const [globalSettingsMounted, setGlobalSettingsMounted] = useState(false);
  const [activityBySlug, setActivityBySlug] = useState<Record<string, CoworkerActivity>>({});
  const [liveActivityBySlug, setLiveActivityBySlug] = useState<Record<string, CoworkerActivity>>({});
  const [attentionBySlug, setAttentionBySlug] = useState<Record<string, string>>({});
  /** Cloud responsibilities Den is running right now, per coworker: "Running in OpenWork Cloud". */
  const [cloudRunBySlug, setCloudRunBySlug] = useState<Record<string, CoworkerActivity>>({});
  const pushedSessionKeyRef = useRef("");
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);

  const boot = useCallback(async () => {
    try {
      const list = await coworkerBridge.coworkers.list();
      const info = await coworkerBridge.runtimeInfo();
      setRuntime(info);
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

  const openGlobalSettings = useCallback((section: SettingsSection = "general") => {
    const opener = document.activeElement;
    settingsReturnFocusRef.current = opener instanceof HTMLElement && opener !== document.body ? opener : null;
    setGlobalSettingsMounted(true);
    setGlobalSettings(section);
  }, []);

  const closeGlobalSettings = useCallback(() => {
    setGlobalSettings(null);
  }, []);

  useEffect(() => {
    if (globalSettings) return;
    const target = settingsReturnFocusRef.current;
    settingsReturnFocusRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [globalSettings]);

  const refreshRuntime = useCallback(async () => {
    const info = await coworkerBridge.runtimeInfo();
    setRuntime(info);
  }, []);

  /**
   * Hand the signed-in account to the embedded server so the member's
   * authorized providers become engine providers. Runs on boot for a stored
   * session and again after every sign-in; the server ignores a repeat.
   */
  const pushSession = useCallback(async (next: DenSession): Promise<ProviderSyncRun> => {
    pushedSessionKeyRef.current = sessionKey(next);
    try {
      const run = await coworkerBridge.den.setSession(providerSyncSession(next));
      setProviderSync(run);
      return run;
    } catch (cause) {
      const failed: ProviderSyncRun = { status: "failed", message: cause instanceof Error ? cause.message : String(cause) };
      setProviderSync(failed);
      return failed;
    } finally {
      void refreshRuntime();
    }
  }, [refreshRuntime]);

  useEffect(() => {
    if (!runtime || !session || pushedSessionKeyRef.current === sessionKey(session)) return;
    void pushSession(session);
  }, [pushSession, runtime, session]);

  const signInWithGrant = useCallback(async (grant: string, baseUrl?: string) => {
    if (!runtime) return;
    setSignInBusy(true);
    setSignInError("");
    try {
      const next = await exchangeGrant(baseUrl ?? runtime.denBaseUrl, grant);
      writeDenSession(next);
      setSession(next);
      await pushSession(next);
      setConnecting(false);
      if (coworkers.length === 0) {
        setOnboardingReady(true);
        setCreating(true);
      }
    } catch (cause) {
      setSignInError(cause instanceof Error ? cause.message : String(cause));
      setConnecting(true);
    } finally {
      setSignInBusy(false);
    }
  }, [coworkers.length, pushSession, runtime]);

  // Den's "Open in app" button returns here as an opencoworker://den-auth link.
  useEffect(() => {
    if (!runtime) return;
    return coworkerBridge.onDeepLink((urls) => {
      for (const url of urls) {
        const parsed = parsePastedGrant(url);
        if (parsed) {
          void signInWithGrant(parsed.grant, parsed.baseUrl);
          return;
        }
      }
    });
  }, [runtime, signInWithGrant]);

  const signOut = useCallback(async () => {
    writeDenSession(null);
    setSession(null);
    setProviderSync(null);
    pushedSessionKeyRef.current = "";
    try {
      await coworkerBridge.den.clearSession();
    } finally {
      void refreshRuntime();
    }
  }, [refreshRuntime]);

  const syncProviders = useCallback(async (): Promise<ProviderSyncRun> => {
    try {
      const run = await coworkerBridge.den.syncProviders();
      setProviderSync(run);
      return run;
    } catch (cause) {
      const failed: ProviderSyncRun = { status: "failed", message: cause instanceof Error ? cause.message : String(cause) };
      setProviderSync(failed);
      return failed;
    } finally {
      void refreshRuntime();
    }
  }, [refreshRuntime]);

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
              conversationThreadId: coworker.conversationThreadId,
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
      setCloudRunBySlug({});
      return;
    }
    let cancelled = false;
    const den = createDenAutomationsClient(session);
    const refreshAttention = async () => {
      try {
        const list = await den.list();
        const next: Record<string, string> = {};
        const running: Record<string, CoworkerActivity> = {};
        for (const coworker of coworkers) {
          const owned = list.items.filter(
            (entry) =>
              coworker.automations.includes(entry.automation.id) ||
              Boolean(coworker.workspaceId && entry.revision.workspaceId === coworker.workspaceId),
          );
          const attention = owned.find((entry) => entry.automation.state === "needs_attention");
          if (attention) {
            next[coworker.slug] =
              attention.automation.needsAttentionReason?.message || attention.automation.name;
          }
          const active = owned.find((entry) =>
            entry.latestRun !== null && ["queued", "claimed", "running"].includes(entry.latestRun.status),
          );
          if (active?.latestRun) {
            running[coworker.slug] = {
              state: "working",
              label: active.latestRun.status === "running" ? "Running in OpenWork Cloud" : "Queued in OpenWork Cloud",
              detail: active.automation.name,
              updatedAt: active.latestRun.startedAt ?? active.latestRun.createdAt,
            };
          }
        }
        if (!cancelled) {
          setAttentionBySlug(next);
          setCloudRunBySlug(running);
        }
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

  const updateSelectedLiveActivity = useCallback((activity: CoworkerActivity | null) => {
    if (!selectedSlug) return;
    setLiveActivityBySlug((current) => {
      if (activity) return { ...current, [selectedSlug]: activity };
      if (!(selectedSlug in current)) return current;
      const next = { ...current };
      delete next[selectedSlug];
      return next;
    });
  }, [selectedSlug]);

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
        runtime={runtime}
        busy={signInBusy}
        error={signInError}
        onGrant={(grant, baseUrl) => void signInWithGrant(grant, baseUrl)}
        onDismiss={() => {
          setSignInError("");
          setConnecting(false);
        }}
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
    const liveActivity = liveActivityBySlug[coworker.slug];
    const cloudRun = cloudRunBySlug[coworker.slug];
    if (attention) {
      visibleActivityBySlug[coworker.slug] = {
        state: "attention",
        label: "Needs you",
        detail: attention,
        updatedAt: activity?.updatedAt ?? 0,
        ...(activity?.last ? { last: activity.last } : {}),
      };
    } else if (liveActivity) {
      visibleActivityBySlug[coworker.slug] = liveActivity;
    } else if (cloudRun) {
      visibleActivityBySlug[coworker.slug] = { ...cloudRun, ...(activity?.last ? { last: activity.last } : {}) };
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
      setSelectedSlug(remaining[0]?.slug ?? "");
    }
  }

  return (
    <div className="window-shell relative flex h-full overflow-hidden" data-testid="coworker-shell">
      <div
        className={globalSettings ? "hidden" : "flex min-w-0 flex-1"}
        data-testid="coworker-workspace"
        data-active={globalSettings ? "false" : "true"}
      >
        <CoworkerRail
          runtime={runtime}
          session={session}
          coworkers={coworkers}
          activityBySlug={visibleActivityBySlug}
          selectedSlug={creating ? "" : selectedSlug}
          onSelect={(slug) => {
            setCreating(false);
            setSelectedSlug(slug);
          }}
          onNewCoworker={() => {
            setCreating(true);
          }}
          onOpenOpenWork={() => openGlobalSettings()}
        />
        {creating || !selected ? (
          <div className="min-w-0 flex-1">
            <NewCoworker
              runtime={runtime}
              session={session}
              onConnect={() => setConnecting(true)}
              onSyncProviders={syncProviders}
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
            onActivityChange={updateSelectedLiveActivity}
            onCoworkerChanged={updateCoworkerInList}
            onCoworkerRemoved={removeCoworkerFromList}
            onRefreshRuntime={refreshRuntime}
            onSyncProviders={syncProviders}
            onOpenOpenWork={(section) => openGlobalSettings(section ?? "general")}
          />
        )}
      </div>
      {globalSettingsMounted ? (
        <div
          className={globalSettings ? "absolute inset-0 flex" : "hidden"}
          data-testid="openwork-settings-pane"
          data-active={globalSettings ? "true" : "false"}
        >
          <OpenWorkSettings
            active={Boolean(globalSettings)}
            runtime={runtime}
            session={session}
            providerSync={providerSync}
            coworkers={coworkers}
            selectedCoworker={selected}
            initialSection={globalSettings ?? "general"}
            onClose={closeGlobalSettings}
            onConnect={() => setConnecting(true)}
            onSignOut={signOut}
            onSyncProviders={syncProviders}
            onRefreshRuntime={refreshRuntime}
          />
        </div>
      ) : null}
    </div>
  );
}
