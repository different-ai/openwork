import { patternDrafts, workPattern } from "@/lib/work-patterns";
import { CalendarView, type CalendarEventTarget, type CalendarRequest } from "@/ui/calendar";
import { useCalendarData } from "@/ui/calendar-data";
import { useCalendarPreferences } from "@/ui/calendar-preferences";
import { eventForTarget, groupEventTarget, type EventArtifact } from "@/lib/events";
import type { DocumentNavigationGuard } from "@/ui/documents";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerActivityItem, type CoworkerGroupSummary, type CoworkerSummary, type CoworkerTemplateSync, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import { acknowledgeCoworker } from "@/ui/coworker-avatar";
import { publishGroupRun } from "@/lib/group-runs";
import { describeGroupPresentation } from "@/lib/group-presentation";
import {
  createDenAutomationsClient,
  exchangeGrant,
  parsePastedGrant,
  providerSyncSession,
  readDenSession,
  writeDenSession,
  type ConnectToken,
  type DenSession,
} from "@/lib/den";
import {
  connectReconcilePayload,
  connectStateFromHealth,
  reconcileConnect,
  removeConnect,
  type ConnectState,
} from "@/lib/connect";
import { readCoworkerActivity, type CoworkerActivity } from "@/lib/threads";
import { Button, ErrorNote } from "@/ui/kit";
import { NewCoworker } from "@/ui/new-coworker";
import { GroupDetailsSheet } from "@/ui/group-details";
import { NewGroupSheet } from "@/ui/new-group";
import { GroupChat } from "@/ui/group-chat";
import { SignInGate } from "@/ui/sign-in";
import { CoworkerHome, type CoworkerHomeRequest } from "@/ui/coworker-home";
import { CoworkerRail, type CoworkerMainContent } from "@/ui/coworker-rail";
import { useResizablePanel } from "@/ui/use-resizable-panel";
import type { PanelBounds } from "@/lib/panel-layout";

/** The team rail: drag it narrower than a row can show and it folds to avatars. */
const RAIL_BOUNDS: PanelBounds = { min: 220, max: 380, collapsedWidth: 88, collapseBelow: 170 };
import { OnboardingWelcome } from "@/ui/onboarding";
import { OnboardingIntents } from "@/ui/onboarding-intents";
import { OnboardingTeam } from "@/ui/onboarding-team";
import { emptyOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft, toggleIntent, type OnboardingDraft } from "@/lib/onboarding-team";
import type { TeamRole } from "@/lib/bridge";
import { AppLoader, CoworkerMark } from "@/ui/brand";
import type { SettingsSection } from "@/ui/openwork-settings";
import { VoiceContext } from "@/ui/use-voice";
import { useActivityInbox } from "@/ui/use-activity-inbox";
import type { ActivityDocumentTarget } from "@/ui/activity-inbox";

// Whole-window or rarely opened screens load on first use so the startup chunk
// carries the team, discussions and groups only. Local setup shares the provider
// editor with Settings; the root loader covers it, the shell covers the rest.
const ActivityInbox = lazy(() => import("@/ui/activity-inbox").then((module) => ({ default: module.ActivityInbox })));
const LocalModeScreen = lazy(() => import("@/ui/local-mode").then((module) => ({ default: module.LocalModeScreen })));
const OpenWorkSettings = lazy(() => import("@/ui/openwork-settings").then((module) => ({ default: module.OpenWorkSettings })));
const FactoryResetScreen = lazy(() => import("@/ui/factory-reset").then((module) => ({ default: module.FactoryResetScreen })));
const OnboardingReplay = lazy(() => import("@/ui/onboarding-replay").then((module) => ({ default: module.OnboardingReplay })));

/** How long a freshly (re)started workspace may stay silent before it is a problem worth naming. */
const WORKSPACE_WARMUP_MS = 45_000;

/** Identity of a pushed account context; the server itself no-ops on a repeat. */
function sessionKey(session: DenSession): string {
  return `${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`;
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bootError, setBootError] = useState("");
  const [session, setSession] = useState<DenSession | null>(() => readDenSession());
  const [providerSync, setProviderSync] = useState<ProviderSyncRun | null>(null);
  const [templateSync, setTemplateSync] = useState<CoworkerTemplateSync | null>(null);
  const [templateError, setTemplateError] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [coworkers, setBots] = useState<CoworkerSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [creating, setCreating] = useState(false);
  /** Group chats: several coworkers in one conversation. Selecting one takes the main column. */
  const [groups, setGroups] = useState<CoworkerGroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [mainContent, setMainContent] = useState<CoworkerMainContent>("chat");
  const [activityContext, setActivityContext] = useState<"chat" | "calendar">("chat");
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [groupEventSource, setGroupEventSource] = useState<(CalendarEventTarget & { groupId: string }) | null>(null);
  const [navigationNotice, setNavigationNotice] = useState("");
  const readerNavigation: DocumentNavigationGuard = useRef(null);
  const coworkersRef = useRef(coworkers);
  coworkersRef.current = coworkers;
  const allowSourceNavigation = useCallback(() => {
    const message = readerNavigation.current?.() ?? "";
    setNavigationNotice(message);
    return !message;
  }, []);
  const navigationGeneration = useRef(0);
  const requestSequence = useRef(0);
  const navigate = useCallback((view: CoworkerMainContent, exitActivity = false) => {
    navigationGeneration.current += 1;
    setNavigationNotice("");
    if (view !== "activity") setActivityContext(view);
    setMainContent((current) => current === "activity" && view !== "activity" && !exitActivity ? "activity" : view);
  }, []);
  const calendarConversationOrigin = useRef<{ groupId: string; eventId: string } | null>(null);
  const calendarEventId = useRef<string | null>(null);
  const rememberCalendarEvent = useCallback((eventId: string | null) => {
    navigationGeneration.current += 1;
    calendarEventId.current = eventId;
  }, []);
  const [calendarRequest, setCalendarRequest] = useState<CalendarRequest | null>(null);
  const [groupDocumentRequest, setGroupDocumentRequest] = useState<{ id: number; groupId: string; documentId: string } | null>(null);
  const calendar = useCalendarData(coworkers, session, Boolean(runtime));
  const [calendarPreferences, setCalendarPreferences] = useCalendarPreferences();

  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupLines, setGroupLines] = useState<Record<string, string>>({});
  const [groupActiveSlugs, setGroupActiveSlugs] = useState<Record<string, string[]>>({});
  const setGroupLine = useCallback((id: string, line: string, activeSlugs: string[]) => {
    setGroupLines((current) => (current[id] === line ? current : { ...current, [id]: line }));
    setGroupActiveSlugs((current) => current[id]?.join("\0") === activeSlugs.join("\0") ? current : { ...current, [id]: activeSlugs });
  }, []);
  const replaceGroup = useCallback((group: CoworkerGroupSummary) => {
    setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);
  /** A request made of one coworker's view from elsewhere: a group's "Choose AI model" or an assignment it created. */
  const [homeRequest, setHomeRequest] = useState<(CoworkerHomeRequest & { slug: string; createdAt?: string }) | null>(null);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(false);
  /** The "Use this Mac" step: what this Mac already has, before the first coworker. */
  const [localSetup, setLocalSetup] = useState(false);
  /** After the account or local-mode step: what the team will help with, then the proposed team. */
  const [onboardingStep, setOnboardingStep] = useState<"" | "intents" | "team">("");
  const [onboardingDraft, setOnboardingDraft] = useState<OnboardingDraft>(() => emptyOnboardingDraft());
  const [teamCatalog, setTeamCatalog] = useState<TeamRole[]>([]);
  const [globalSettings, setGlobalSettings] = useState<SettingsSection | null>(null);
  const [globalSettingsMounted, setGlobalSettingsMounted] = useState(false);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [activityMounted, setActivityMounted] = useState(false);
  const [activityGroupRequest, setActivityGroupRequest] = useState<{ id: number; groupId: string; eventId: string; onOpened?: () => Promise<void> } | null>(null);
  const inbox = useActivityInbox(Boolean(runtime) && !factoryResetOpen);
  // A read-only tour, deliberately separate from first-run flags and persisted team drafts.
  const [replayOnboarding, setReplayOnboarding] = useState<"welcome" | "ai" | null>(null);
  const [activityBySlug, setActivityBySlug] = useState<Record<string, CoworkerActivity>>({});
  const [liveActivityBySlug, setLiveActivityBySlug] = useState<Record<string, CoworkerActivity>>({});
  const [attentionBySlug, setAttentionBySlug] = useState<Record<string, string>>({});
  /** OpenWork Connect (the `openwork-cloud` gateway) state per coworker, while signed in. */
  const [connectBySlug, setConnectBySlug] = useState<Record<string, ConnectState>>({});
  const connectTokenRef = useRef<{ sessionKey: string; token: ConnectToken } | null>(null);
  const connectedWorkspacesRef = useRef<Set<string>>(new Set());
  /** Automatic retries per coworker while the AI service is still coming up; cleared on success. */
  const connectRetryRef = useRef<Record<string, { attempts: number; timer: number }>>({});
  /** Cloud responsibilities Den is running right now, per coworker: "Running in OpenWork Cloud". */
  const [cloudRunBySlug, setCloudRunBySlug] = useState<Record<string, CoworkerActivity>>({});
  const pushedSessionKeyRef = useRef("");
  /** When each coworker's workspace first stopped answering; cleared by the next good read. */
  const notAnsweringSinceRef = useRef<Record<string, number>>({});
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const resetReturnFocusRef = useRef<HTMLElement | null>(null);
  const groupReadingRef = useRef(false);
  const activityReadingRef = useRef(false);

  const boot = useCallback(async () => {
    try {
      const list = await coworkerBridge.coworkers.list();
      const info = await coworkerBridge.runtimeInfo();
      // A fresh window runs no group turn, so any still recorded as running was cut off: settle it first.
      await coworkerBridge.groups.recoverInterrupted().catch(() => []);
      const groups = await coworkerBridge.groups.list().catch(() => []);
      // Publish the saved team and its selection together, keeping the loader up until both are ready.
      setRuntime(info);
      setBots(list);
      setGroups(groups);
      setSelectedSlug((current) =>
        current && list.some((coworker) => coworker.slug === current) ? current : (list[0]?.slug ?? ""),
      );
      if (list.length === 0) {
        // A team drafted before a quit or reload comes back where it was left.
        const saved = loadOnboardingDraft(window.sessionStorage);
        setOnboardingDraft(saved);
        if (saved.drafts.length > 0) setOnboardingStep("team");
      }
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
    const refresh = async () => {
      if (cancelled || factoryResetOpen || groupReadingRef.current) return;
      groupReadingRef.current = true;
      try {
        const list = await coworkerBridge.groups.list();
        if (cancelled) return;
        setGroups((current) => current.length === list.length && current.every((group, index) => group.id === list[index]?.id && group.updatedAt === list[index]?.updatedAt) ? current : list);
        for (const group of list.filter((group) => !group.archivedAt)) {
          const [status, activity] = await Promise.all([
            coworkerBridge.groups.status(group.id).catch(() => null),
            coworkerBridge.groups.activity(group.id).catch(() => null),
          ]);
          if (cancelled) return;
          if (status) publishGroupRun({ groupId: group.id, active: status.active, ...(status.turn ? { turn: status.turn } : {}), done: !status.active });
          const nameFor = (slug: string) => coworkers.find((coworker) => coworker.slug === slug)?.name ?? slug;
          const presentation = describeGroupPresentation({ executions: activity?.executions ?? [], interactions: status?.interactions ?? [], active: status?.active ?? false, turn: status?.turn ?? group.turns.at(-1) ?? null, events: activity?.timeline ?? [], nameFor, unavailable: !status || !activity });
          setGroupLine(group.id, presentation.line, presentation.activeSlugs);
        }
      } catch {
        if (!cancelled) {
          setGroupActiveSlugs({});
          setGroupLines((current) => Object.fromEntries(Object.keys(current).map((id) => [id, "Activity unavailable"])));
        }
      } finally { groupReadingRef.current = false; }
    };
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2000);
    const open = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") {
        const generation = ++navigationGeneration.current;
        void coworkerBridge.groups.get(event.detail).then((group) => { if (!group.archivedAt && generation === navigationGeneration.current && allowSourceNavigation()) { setGroups((current) => current.some((entry) => entry.id === group.id) ? current : [...current, group]); setActivityGroupRequest(null); setGroupDocumentRequest(null); setHomeRequest(null); setGroupEventSource(null); calendarConversationOrigin.current = null; setSelectedActivityId(null); setSelectedGroupId(group.id); navigate("chat"); setGroupDetailsOpen(false); } }).catch(() => undefined);
      }
    };
    window.addEventListener("coworker:open-group", open);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("coworker:open-group", open); };
  }, [runtime?.serverUrl, coworkers, setGroupLine, factoryResetOpen, navigate, allowSourceNavigation]);

  const openGlobalSettings = useCallback((section: SettingsSection = "general") => {
    navigationGeneration.current += 1;
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

  useEffect(() => {
    if (factoryResetOpen) return;
    const target = resetReturnFocusRef.current;
    resetReturnFocusRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [factoryResetOpen]);

  const refreshRuntime = useCallback(async () => {
    const info = await coworkerBridge.runtimeInfo();
    setRuntime(info);
  }, []);

  const restartRuntime = useCallback(async () => {
    setRuntime(await coworkerBridge.restartRuntime());
  }, []);

  const receiveImportedTemplates = useCallback((result: CoworkerTemplateSync) => {
    const first = result.created[0];
    if (!first) return;
    setBots((current) => [...current, ...result.created.filter((item) => !current.some((known) => known.slug === item.slug))]);
    setSelectedSlug((current) => current || first.slug);
    setOnboardingReady(true);
    setOnboardingStep("");
    setCreating(false);
    void refreshRuntime();
  }, [refreshRuntime]);

  const receiveTemplates = useCallback((result: CoworkerTemplateSync) => {
    setTemplateSync(result);
    setTemplateError("");
    receiveImportedTemplates(result);
  }, [receiveImportedTemplates]);

  const syncAssignedCoworkers = useCallback(async (installIds: string[] = []) => {
    if (!session) return;
    const key = sessionKey(session);
    try {
      const result = await coworkerBridge.templates.sync({ userEmail: session.userEmail, automatic: true, installIds });
      if (pushedSessionKeyRef.current === key) receiveTemplates(result);
    } catch (cause) {
      if (pushedSessionKeyRef.current === key) setTemplateError(cause instanceof Error ? cause.message : "Your team's coworkers could not be refreshed.");
    }
  }, [receiveTemplates, session]);

  /**
   * Hand the signed-in account to the embedded server so the member's
   * authorized providers become available to every coworker. Runs on boot for a stored
   * session and again after every sign-in; the server ignores a repeat.
   */
  const pushSession = useCallback(async (next: DenSession): Promise<ProviderSyncRun> => {
    pushedSessionKeyRef.current = sessionKey(next);
    try {
      const run = await coworkerBridge.den.setSession(providerSyncSession(next));
      setProviderSync(run);
      setTemplateSync(null);
      setTemplateError("");
      try {
        const result = await coworkerBridge.templates.sync({ userEmail: next.userEmail, automatic: true });
        if (pushedSessionKeyRef.current === sessionKey(next)) receiveTemplates(result);
      } catch (cause) {
        if (pushedSessionKeyRef.current === sessionKey(next)) setTemplateError(cause instanceof Error ? cause.message : "Your team's coworkers could not be loaded. Refresh them in Account settings.");
      }
      return run;
    } catch (cause) {
      const failed: ProviderSyncRun = { status: "failed", message: cause instanceof Error ? cause.message : String(cause) };
      setProviderSync(failed);
      return failed;
    } finally {
      void refreshRuntime();
    }
  }, [receiveTemplates, refreshRuntime]);

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
      if (coworkers.length === 0) setOnboardingStep("intents");
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
    // The organization's capabilities leave with the account.
    if (runtime) {
      await Promise.all(coworkers
        .filter((coworker) => coworker.workspaceId)
        .map((coworker) => removeConnect(runtime, coworker.workspaceId).catch(() => undefined)));
    }
    for (const pending of Object.values(connectRetryRef.current)) window.clearTimeout(pending.timer);
    connectRetryRef.current = {};
    connectedWorkspacesRef.current.clear();
    connectTokenRef.current = null;
    setConnectBySlug({});
    writeDenSession(null);
    setSession(null);
    setProviderSync(null);
    pushedSessionKeyRef.current = "";
    try {
      await coworkerBridge.den.clearSession();
    } finally {
      void refreshRuntime();
    }
  }, [coworkers, refreshRuntime, runtime]);

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

  /**
   * Bring the organization's capabilities to every coworker: mint one gateway
   * token for the session and register the gateway in each coworker's
   * workspace. Idempotent; `force` re-registers (Repair) and re-mints a token
   * that is about to expire.
   */
  const syncConnect = useCallback(async (options: { force?: boolean; remint?: boolean; slug?: string } = {}) => {
    if (!runtime?.engineManaged || !session) return;
    const key = sessionKey(session);
    const targets = coworkers.filter((coworker) =>
      coworker.workspaceId
      && (!options.slug || coworker.slug === options.slug)
      && (options.force || !connectedWorkspacesRef.current.has(`${key}\u0000${coworker.workspaceId}`)),
    );
    if (targets.length === 0) return;
    for (const coworker of targets) {
      const pending = connectRetryRef.current[coworker.slug];
      if (pending) window.clearTimeout(pending.timer);
    }
    setConnectBySlug((current) => {
      const next = { ...current };
      for (const coworker of targets) next[coworker.slug] = { status: "connecting" };
      return next;
    });
    let token = connectTokenRef.current?.sessionKey === key ? connectTokenRef.current.token : null;
    const expiresSoon = token ? Date.parse(token.expiresAt) - Date.now() < 5 * 60_000 : true;
    try {
      if (!token || expiresSoon || options.remint) {
        token = await createDenAutomationsClient(session).mintMcpToken();
        connectTokenRef.current = { sessionKey: key, token };
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setConnectBySlug((current) => {
        const next = { ...current };
        for (const coworker of targets) next[coworker.slug] = { status: "unavailable", message: `OpenWork could not issue a Connect token: ${message}` };
        return next;
      });
      return;
    }
    const minted = token;
    await Promise.all(targets.map(async (coworker) => {
      const payload = connectReconcilePayload({ workspaceId: coworker.workspaceId, session, token: minted, appVersion: runtime.version });
      let state: ConnectState;
      try {
        if (!payload) throw new Error("OpenWork did not name a gateway for this organization.");
        state = connectStateFromHealth(await reconcileConnect(runtime, coworker.workspaceId, payload));
        connectedWorkspacesRef.current.add(`${key}\u0000${coworker.workspaceId}`);
      } catch (cause) {
        state = { status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
      }
      setConnectBySlug((current) => ({ ...current, [coworker.slug]: state }));
      // Right after a coworker is created its AI service may still be starting, so the first
      // registration can land before the engine answers. Try again by itself a few times.
      const previous = connectRetryRef.current[coworker.slug]?.attempts ?? 0;
      if (state.status === "connected" || previous >= 6) {
        delete connectRetryRef.current[coworker.slug];
        return;
      }
      const attempts = previous + 1;
      const timer = window.setTimeout(() => void syncConnect({ force: true, slug: coworker.slug }), Math.min(60_000, 5_000 * attempts));
      connectRetryRef.current[coworker.slug] = { attempts, timer };
    }));
  }, [coworkers, runtime, session]);

  useEffect(() => {
    if (!session || !runtime?.engineManaged) return;
    void syncConnect();
    // Tokens are short-lived: refresh before they lapse while the app stays open.
    const timer = window.setInterval(() => void syncConnect({ force: true, remint: true }), 20 * 60_000);
    return () => window.clearInterval(timer);
  }, [runtime?.engineManaged, session, syncConnect]);

  useEffect(() => {
    // These reads feed the hidden sidebar, not native job execution. Keep the
    // last display snapshot while reset is open; refresh it when returning.
    if (!runtime || factoryResetOpen) return;
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
          if (!runtime.engineManaged) {
            // One phrase for one fact: the header, rail, and sidebar all say the AI service is unavailable.
            return [coworker.slug, { state: "offline", label: "AI unavailable", detail: "", updatedAt: 0 }] as const;
          }
          // Worker threads are work in progress, never finished assignments; their ids come from the main process.
          const workers = await coworkerBridge.workers.list(coworker.slug).catch(() => []);
          const [readActivity, localResponsibilities] = await Promise.all([
            readCoworkerActivity({
              serverUrl: runtime.serverUrl,
              workspaceId: coworker.workspaceId,
              token: runtime.ownerToken,
              conversationThreadId: coworker.conversationThreadId,
              workerThreadIds: workers.map((worker) => worker.threadId).filter(Boolean),
            }),
            coworkerBridge.localResponsibilities.list(coworker.slug).catch(() => []),
          ]);
          // A workspace that has just been (re)started may not answer for a moment.
          // That is a warm-up, shown calmly; it becomes a problem only if it lasts.
          const now = Date.now();
          if (readActivity.state !== "offline") delete notAnsweringSinceRef.current[coworker.slug];
          const notAnsweringSince = readActivity.state === "offline"
            ? (notAnsweringSinceRef.current[coworker.slug] ??= now)
            : null;
          const threadActivity: CoworkerActivity =
            notAnsweringSince !== null && now - notAnsweringSince < WORKSPACE_WARMUP_MS
              ? { state: "starting", label: "Starting up", detail: "", updatedAt: 0 }
              : readActivity;
          // A Worker waiting on a decision needs the person as much as a pending question does; the card is in the discussion.
          const deciding = workers.find((worker) => worker.status === "waiting" && worker.waitingFor === "decision");
          if (deciding && threadActivity.state !== "attention" && threadActivity.state !== "offline" && threadActivity.state !== "starting") {
            return [
              coworker.slug,
              {
                state: "attention",
                label: "Needs you",
                detail: `${deciding.name} needs a decision`,
                updatedAt: deciding.updatedAt,
                ...(coworker.conversationThreadId ? { threadId: coworker.conversationThreadId } : {}),
                ...(threadActivity.last ? { last: threadActivity.last } : {}),
                ...(threadActivity.recent ? { recent: threadActivity.recent } : {}),
              },
            ] as const;
          }
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
                label: "Running locally",
                detail: localRunning.name,
                updatedAt: localRunning.latestRun.startedAt,
                ...(localRunning.latestRun.threadId ? { threadId: localRunning.latestRun.threadId } : {}),
                ...(latestActivity ? { last: latestActivity } : {}),
                ...(threadActivity.recent ? { recent: threadActivity.recent } : {}),
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
                label: "Run failed",
                detail: localFailure.name,
                updatedAt: localFailure.latestRun.finishedAt ?? localFailure.latestRun.startedAt,
                ...(localFailure.latestRun.threadId ? { threadId: localFailure.latestRun.threadId } : {}),
                ...(latestActivity ? { last: latestActivity } : {}),
                ...(threadActivity.recent ? { recent: threadActivity.recent } : {}),
              },
            ] as const;
          }
          // The soonest scheduled responsibility, so an idle coworker can say what is next.
          const upcoming = localResponsibilities
            .filter((item) => item.state === "active" && typeof item.nextDueAt === "number" && item.nextDueAt > now)
            .sort((left, right) => (left.nextDueAt ?? 0) - (right.nextDueAt ?? 0))[0];
          const withNext = upcoming && upcoming.nextDueAt ? { next: { name: upcoming.name, at: upcoming.nextDueAt } } : {};
          return [coworker.slug, { ...threadActivity, ...(latestActivity ? { last: latestActivity } : {}), ...withNext }] as const;
        }),
      );
      if (!cancelled) setActivityBySlug(Object.fromEntries(entries));
    };
    if (runtime.engineManaged) {
      // The service is back: a label recorded while it was down is stale now,
      // and the first fresh read may take a moment while the service warms up.
      setActivityBySlug((current) => {
        let changed = false;
        const next: Record<string, CoworkerActivity> = { ...current };
        for (const [slug, activity] of Object.entries(current)) {
          if (activity.label !== "AI unavailable") continue;
          next[slug] = { state: "starting", label: "Starting up", detail: "", updatedAt: 0 };
          changed = true;
        }
        return changed ? next : current;
      });
    }
    const refresh = () => {
      // Persist the in-flight guard across effect restarts as well as timer ticks.
      if (cancelled || activityReadingRef.current) return;
      activityReadingRef.current = true;
      void refreshActivity().catch(() => undefined).finally(() => { activityReadingRef.current = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtime, coworkers, factoryResetOpen]);

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

  const rail = useResizablePanel({
    storageKey: "open-coworker.team-rail",
    side: "left",
    bounds: RAIL_BOUNDS,
    defaultWidth: 272,
  });

  // The catalog the onboarding steps propose from, read once when they are first needed.
  useEffect(() => {
    if (!onboardingStep || teamCatalog.length > 0) return;
    let cancelled = false;
    coworkerBridge.team.catalog()
      .then((catalog) => {
        if (!cancelled) setTeamCatalog(catalog);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onboardingStep, teamCatalog.length]);

  /** Change the draft from its latest value (two quick taps must both land) and keep it for the session. */
  const updateOnboardingDraft = useCallback((next: OnboardingDraft | ((current: OnboardingDraft) => OnboardingDraft)) => {
    setOnboardingDraft((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      saveOnboardingDraft(window.sessionStorage, resolved);
      return resolved;
    });
  }, []);

  /** Skip the proposed team: today's blank Add screen. */
  const addOwnCoworker = useCallback(() => {
    setOnboardingStep("");
    setOnboardingReady(true);
    setCreating(true);
  }, []);

  const proposeTeam = useCallback(async () => {
    try {
      const drafts = patternDrafts(await coworkerBridge.team.recommend(onboardingDraft.intents), onboardingDraft.patternId ?? "");
      updateOnboardingDraft((current) => ({ ...current, drafts }));
      setOnboardingStep("team");
    } catch (cause) {
      setBootError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onboardingDraft.intents, onboardingDraft.patternId, updateOnboardingDraft]);

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

  if (coworkers.length === 0 && calendar.loading && !creating) return <AppLoader />;

  if (coworkers.length === 0 && calendar.events.length === 0 && !onboardingReady && !creating) {
    if (onboardingStep === "team") {
      return (
        <OnboardingTeam
          catalog={teamCatalog}
          draft={onboardingDraft}
          onChange={updateOnboardingDraft}
          onBack={() => setOnboardingStep("intents")}
          onCreated={(team, firstSlug) => {
            const first = team.find((coworker) => coworker.slug === firstSlug) ?? team[0];
            if (first) acknowledgeCoworker(first.slug, "wake");
            setBots(team);
            setSelectedSlug(team.some((coworker) => coworker.slug === firstSlug) ? firstSlug : (team[0]?.slug ?? ""));
            setOnboardingDraft(emptyOnboardingDraft());
            setOnboardingStep("");
            setOnboardingReady(true);
            void refreshRuntime();
          }}
        />
      );
    }
    if (onboardingStep === "intents") {
      return (
        <OnboardingIntents
          catalog={teamCatalog}
          selected={onboardingDraft.intents}
          patternId={onboardingDraft.patternId ?? ""}
          onPattern={(patternId) => updateOnboardingDraft((current) => ({ ...current, patternId, intents: workPattern(patternId)?.jobs.map((job) => job.roleId) ?? [] }))}
          onToggle={(id) => updateOnboardingDraft((current) => ({ ...current, intents: toggleIntent(current.intents, id) }))}
          onContinue={() => void proposeTeam()}
          onOwn={addOwnCoworker}
          onBack={() => setOnboardingStep("")}
        />
      );
    }
    if (localSetup) {
      return (
        <LocalModeScreen
          runtime={runtime}
          session={session}
          onConnectAccount={() => setConnecting(true)}
          onRuntimeChanged={refreshRuntime}
          onBack={() => setLocalSetup(false)}
          onContinue={() => {
            setLocalSetup(false);
            setOnboardingStep("intents");
          }}
        />
      );
    }
    return (
      <OnboardingWelcome
        onConnect={() => setConnecting(true)}
        onContinueLocally={() => setLocalSetup(true)}
        onImport={async () => {
          const result = await coworkerBridge.templates.import();
          if (result) {
            if (result.created.length === 0) throw new Error("This template was already added. Its previous working copy has been kept.");
            receiveImportedTemplates(result);
          }
        }}
      />
    );
  }

  const selected = coworkers.find((coworker) => coworker.slug === selectedSlug) ?? null;
  const liveGroups = groups.filter((group) => !group.archivedAt);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const eventGroupIds = new Set(calendar.events.map((event) => event.groupId));
  const selectedEventTarget = selectedGroup ? groupEventTarget(selectedGroup, calendar.events, groupEventSource ?? undefined) : undefined;
  const selectedEvent = selectedEventTarget ? eventForTarget(calendar.events, calendar.eventRuns, selectedEventTarget) : undefined;
  const selectedEventLink = selectedEventTarget ? { id: selectedEventTarget.eventId, title: selectedEvent?.title ?? selectedGroup?.name ?? "Event" } : undefined;
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
        ...(activity?.recent ? { recent: activity.recent } : {}),
      };
    } else if (liveActivity) {
      // The thread view knows the live state; the polled read still owns the history.
      visibleActivityBySlug[coworker.slug] = {
        ...liveActivity,
        ...(liveActivity.last ?? activity?.last ? { last: liveActivity.last ?? activity?.last } : {}),
        ...(activity?.recent ? { recent: activity.recent } : {}),
      };
    } else if (cloudRun) {
      visibleActivityBySlug[coworker.slug] = {
        ...cloudRun,
        ...(activity?.last ? { last: activity.last } : {}),
        ...(activity?.recent ? { recent: activity.recent } : {}),
      };
    } else if (activity) {
      visibleActivityBySlug[coworker.slug] = activity;
    }
  }

  function updateCoworkerInList(updated: CoworkerSummary) {
    setBots((current) => current.map((coworker) => (coworker.slug === updated.slug ? updated : coworker)));
  }

  /** A coworker joined the team (from onboarding, the Add screen, or a teammate's suggestion the person accepted). */
  function addCoworkerToList(coworker: CoworkerSummary) {
    acknowledgeCoworker(coworker.slug, "wake");
    setBots((current) => [...current.filter((item) => item.slug !== coworker.slug), coworker].sort((a, b) => a.name.localeCompare(b.name)));
    void refreshRuntime();
  }

  /** Open another coworker's conversation, optionally with a message to send there as the person's own. */
  function visitCoworker(slug: string, prompt?: string) {
    if (!allowSourceNavigation()) return false;
    acknowledgeCoworker(slug);
    setSelectedActivityId(null);
    setGroupDetailsOpen(false);
    setActivityGroupRequest(null);
    setSelectedGroupId("");
    setSelectedSlug(slug);
    setGroupDocumentRequest(null);
    setGroupEventSource(null);
    calendarConversationOrigin.current = null;
    navigate("chat");
    setHomeRequest(prompt ? { id: nextRequestId(), slug, kind: "turn", prompt } : null);
    return true;
  }

  function nextRequestId() {
    requestSequence.current = Math.max(Date.now(), requestSequence.current + 1);
    return requestSequence.current;
  }

  function resumeCalendar() {
    navigate("calendar");
    setGroupDetailsOpen(false);
  }

  function exitActivity() {
    navigate("chat", true);
  }

  async function requestCalendar(input: Omit<CalendarRequest, "id">, activityId: string | null = null) {
    const generation = ++navigationGeneration.current;
    let at = input.at;
    let notice = input.notice;
    if (input.eventId && at === undefined) {
      const run = input.runId ? calendar.eventRuns.find((entry) => entry.id === input.runId && entry.eventId === input.eventId) : undefined;
      const event = calendar.events.find((entry) => entry.id === input.eventId);
      at = input.runId ? run?.scheduledFor : event?.nextDueAt ?? event?.startsAt;
      if (at === undefined) {
        try {
          const detail = await coworkerBridge.events.get(input.eventId);
          at = input.runId ? detail.runs.find((entry) => entry.id === input.runId)?.scheduledFor : detail.event.nextDueAt ?? detail.event.startsAt;
          if (at === undefined) notice = "This session's date is unavailable. Its requested history is kept selected.";
        } catch {
          notice = "The event's date could not be loaded. Your current calendar date is kept; check the event details.";
        }
      }
    }
    if (generation !== navigationGeneration.current) return;
    setSelectedActivityId(activityId);
    calendarConversationOrigin.current = null;
    setCalendarRequest({ ...input, at, notice, id: nextRequestId() });
    setActivityGroupRequest(null);
    resumeCalendar();
  }

  function openActivityEvent(target: CalendarEventTarget) {
    void requestCalendar({ ...target, fromActivity: true }, `event:${target.eventId}:${target.at ?? ""}:${target.runId ?? ""}`);
  }

  async function openActivityItem(item: CoworkerActivityItem) {
    const generation = ++navigationGeneration.current;
    const current = (await coworkerBridge.activity.list()).find((entry) => entry.id === item.id);
    if (generation !== navigationGeneration.current) return;
    if (!current) throw new Error("This activity is no longer available. Refresh Activity to update the list.");
    if (current.kind === "event-reminder") {
      await requestCalendar({ eventId: current.target.eventId, at: current.target.scheduledFor, fromActivity: true, reminderId: current.id }, current.id);
      return;
    }
    if (!allowSourceNavigation()) return;
    const owner = await coworkerBridge.coworkers.get(current.slug);
    if (generation !== navigationGeneration.current) return;
    if (owner.createdAt !== current.coworkerCreatedAt || owner.workspaceId !== current.workspaceId || !coworkersRef.current.some((member) => member.slug === owner.slug && member.createdAt === owner.createdAt && member.workspaceId === owner.workspaceId)) {
      throw new Error("This activity belongs to an earlier coworker identity. It has not been opened in a replacement's workspace.");
    }
    const group = current.target.kind === "group" ? await coworkerBridge.groups.get(current.target.groupId) : null;
    if (generation !== navigationGeneration.current || !allowSourceNavigation()) return;
    if (group && (group.archivedAt !== null || !group.participantSlugs.includes(current.slug))) throw new Error("This conversation is no longer available to this coworker. Refresh Activity to update the list.");
    calendarConversationOrigin.current = null;
    const id = nextRequestId();
    const onOpened = async () => {
      setHomeRequest((request) => request?.id === id ? null : request);
      setActivityGroupRequest((request) => request?.id === id ? null : request);
      await inbox.markRead([current.id]);
    };
    if (current.target.kind === "group" && group) {
      replaceGroup(group);
      setSelectedGroupId(group.id);
      setGroupDocumentRequest(null);
      setHomeRequest(null);
      setGroupEventSource(current.target.workplaceEventId ? { groupId: group.id, eventId: current.target.workplaceEventId, runId: current.target.runId, at: current.target.scheduledFor } : null);
      setActivityGroupRequest({ id, groupId: group.id, eventId: current.target.eventId, onOpened });
    } else if (current.target.kind === "private") {
      setSelectedGroupId("");
      setSelectedSlug(current.slug);
      setActivityGroupRequest(null);
      setGroupDocumentRequest(null);
      setGroupEventSource(null);
      setHomeRequest({ id, slug: current.slug, createdAt: current.coworkerCreatedAt, kind: "discussion", threadId: current.target.threadId, onOpened });
    }
    setSelectedActivityId(current.id);
    setGroupDetailsOpen(false);
    navigate("chat");
  }

  function openEvent(eventId: string) {
    const origin = calendarConversationOrigin.current;
    if (origin?.eventId === eventId && origin.groupId === selectedGroupId && calendarEventId.current === eventId) {
      resumeCalendar();
      return;
    }
    void requestCalendar(selectedEventTarget?.eventId === eventId ? selectedEventTarget : { eventId });
  }

  async function openEventConversation(groupId: string, target?: CalendarEventTarget) {
    const generation = ++navigationGeneration.current;
    if (!allowSourceNavigation()) return;
    if (!groupId) throw new Error("This event has no recorded conversation yet.");
    const group = await coworkerBridge.groups.get(groupId);
    if (generation !== navigationGeneration.current || !allowSourceNavigation()) return;
    if (group.archivedAt !== null) throw new Error("This conversation has been archived. Its history has been kept.");
    calendarConversationOrigin.current = target ? { groupId, eventId: target.eventId } : null;
    setGroupEventSource(target ? { ...target, groupId } : null);
    if (!target) setSelectedActivityId(null);
    replaceGroup(group);
    setActivityGroupRequest(null);
    setGroupDocumentRequest(null);
    setHomeRequest(null);
    setGroupDetailsOpen(false);
    setSelectedGroupId(group.id);
    navigate("chat");
  }

  async function openEventArtifact(artifact: EventArtifact) {
    const generation = ++navigationGeneration.current;
    if (!allowSourceNavigation()) return;
    if (artifact.owner.kind === "group") {
      const group = await coworkerBridge.groups.get(artifact.owner.groupId);
      if (generation !== navigationGeneration.current || !allowSourceNavigation()) return;
      if (group.archivedAt !== null) throw new Error("This group's documents are no longer in the active team.");
      const sourceEvent = calendar.events.find((event) => event.id === calendarEventId.current && event.groupId === group.id);
      const origin = sourceEvent ? { groupId: group.id, eventId: sourceEvent.id } : null;
      calendarConversationOrigin.current = origin;
      setGroupEventSource(origin);
      replaceGroup(group);
      setActivityGroupRequest(null);
      setHomeRequest(null);
      setSelectedActivityId(null);
      setGroupDetailsOpen(false);
      setSelectedGroupId(group.id);
      setGroupDocumentRequest({ id: nextRequestId(), groupId: group.id, documentId: artifact.documentId });
      navigate("chat");
      return;
    }
    const owner = await coworkerBridge.coworkers.get(artifact.owner.slug);
    if (generation !== navigationGeneration.current) return;
    if (owner.createdAt !== artifact.owner.createdAt) throw new Error("This reference belongs to an earlier coworker identity. It has not been opened in the replacement's documents.");
    if (!coworkersRef.current.some((member) => member.slug === owner.slug && member.createdAt === owner.createdAt)) throw new Error("The document's owner is no longer in the active team. The reference has been kept.");
    if (!visitCoworker(owner.slug)) return;
    setHomeRequest({ id: nextRequestId(), slug: owner.slug, createdAt: owner.createdAt, kind: "document", documentId: artifact.documentId });
  }

  async function openActivityDocument(target: ActivityDocumentTarget) {
    const generation = ++navigationGeneration.current;
    if (!allowSourceNavigation()) return;
    if (target.kind === "group") {
      const group = await coworkerBridge.groups.get(target.groupId);
      if (generation !== navigationGeneration.current) return;
      if (group.archivedAt !== null || group.createdAt !== target.createdAt) throw new Error("This group's documents are no longer in the active team.");
      const document = await coworkerBridge.groups.documents.read(group.id, target.documentId);
      if (generation !== navigationGeneration.current || !allowSourceNavigation()) return;
      if (document.groupId !== group.id || document.id !== target.documentId) throw new Error("The requested group document was not returned.");
      replaceGroup(group);
      setSelectedGroupId(group.id);
      setActivityGroupRequest(null);
      setHomeRequest(null);
      setGroupEventSource(null);
      calendarConversationOrigin.current = null;
      setGroupDetailsOpen(false);
      setGroupDocumentRequest({ id: nextRequestId(), groupId: group.id, documentId: target.documentId });
      setSelectedActivityId(`document:group:${group.id}:${group.createdAt}:${target.documentId}`);
      navigate("chat");
      return;
    }
    const owner = await coworkerBridge.coworkers.get(target.slug);
    if (generation !== navigationGeneration.current) return;
    if (owner.createdAt !== target.createdAt || !coworkersRef.current.some((member) => member.slug === owner.slug && member.createdAt === owner.createdAt)) {
      throw new Error("This document belongs to an earlier coworker identity or a coworker no longer on the team.");
    }
    const document = await coworkerBridge.documents.read(owner.slug, target.documentId);
    if (generation !== navigationGeneration.current) return;
    if (document.id !== target.documentId || !coworkersRef.current.some((member) => member.slug === owner.slug && member.createdAt === owner.createdAt)) throw new Error("The requested document's owner changed. Refresh Activity before opening it.");
    if (!visitCoworker(owner.slug)) return;
    setHomeRequest({ id: nextRequestId(), slug: owner.slug, createdAt: owner.createdAt, kind: "document", documentId: target.documentId });
    setSelectedActivityId(`document:coworker:${owner.slug}:${owner.createdAt}:${target.documentId}`);
  }

  function removeCoworkerFromList(slug: string) {
    const remaining = coworkers.filter((coworker) => coworker.slug !== slug);
    setBots(remaining);
    if (selectedSlug === slug) {
      setSelectedSlug(remaining[0]?.slug ?? "");
    }
  }

  const workspaceActive = !globalSettings && !factoryResetOpen && !replayOnboarding;
  const settingsActive = Boolean(globalSettings) && !factoryResetOpen && !replayOnboarding;
  const activityVisible = mainContent === "activity";
  const contentContext = activityVisible ? activityContext : mainContent;
  const calendarVisible = contentContext === "calendar" || (contentContext === "chat" && !selected && !selectedGroup);
  const chatActive = workspaceActive && !calendarVisible;
  const calendarReminder = inbox.items.find((item) => item.kind === "event-reminder" && item.id === calendarRequest?.reminderId);

  return (
    <VoiceContext.Provider value={{ accountKey: session ? `${sessionKey(session)}\u0000${session.userEmail}` : "signed-out", openModels: () => openGlobalSettings("models"), signIn: () => setConnecting(true) }}>
    <div className="window-shell relative flex h-full overflow-hidden" data-testid="coworker-shell">
      <div
        className={workspaceActive ? "flex min-w-0 flex-1" : "hidden"}
        data-testid="coworker-workspace"
        data-active={workspaceActive ? "true" : "false"}
      >
        {creating || (!selected && calendar.events.length === 0) ? (
          // Creation takes the whole window: the team list returns once the coworker exists.
          <div key="create" className="view-enter flex min-w-0 flex-1">
            <NewCoworker
              team={coworkers}
              onAskTeam={(slug, prompt) => { setCreating(false); visitCoworker(slug, prompt); }}
              onCancel={selected || coworkers.length > 0 || calendar.events.length > 0 ? () => setCreating(false) : null}
              onCreated={(coworker) => {
                setCreating(false);
                addCoworkerToList(coworker);
                setSelectedSlug(coworker.slug);
                navigate("chat");
              }}
            />
          </div>
        ) : (
          <div key="team" className="view-enter flex min-w-0 flex-1">
            <CoworkerRail
              calendarData={calendar}
              calendarPreferences={calendarPreferences}
              onCalendarPreferencesChange={setCalendarPreferences}
              mainContent={activityVisible ? "activity" : calendarVisible ? "calendar" : "chat"}
              onMainContentChange={(view) => {
                if (view === "activity" && !activityVisible) setActivityContext(calendarVisible ? "calendar" : "chat");
                setGroupDetailsOpen(false);
                navigate(view, view !== "activity");
                if (view === "activity") { setActivityMounted(true); void inbox.refresh(); }
              }}
              chatAvailable={Boolean(selected || selectedGroup)}
              runtime={runtime}
              session={session}
              coworkers={coworkers}
              activityBySlug={visibleActivityBySlug}
              selectedSlug={activityVisible || selectedGroup ? "" : selectedSlug}
              unreadActivity={inbox.items.filter((item) => item.readAt === null).length}
              unreadMentions={inbox.items.filter((item) => item.readAt === null && item.kind === "mention").length}
              activityError={Boolean(inbox.error)}
              panel={rail}
              onSelect={(slug) => visitCoworker(slug)}
              onOpenCalendar={(slug) => { void requestCalendar({ coworkerSlug: slug }); }}
              eventGroupIds={eventGroupIds}
              onNewCoworker={() => { navigationGeneration.current += 1; if (allowSourceNavigation()) setCreating(true); }}
              onOpenOpenWork={() => openGlobalSettings()}
              groups={liveGroups}
              groupLines={groupLines}
              groupActiveSlugs={groupActiveSlugs}
              selectedGroupId={activityVisible ? "" : selectedGroup?.id ?? ""}
              onSelectGroup={(id) => { navigationGeneration.current += 1; if (!allowSourceNavigation()) return; setActivityGroupRequest(null); setGroupDocumentRequest(null); setHomeRequest(null); setGroupEventSource(null); calendarConversationOrigin.current = null; setSelectedActivityId(null); setSelectedGroupId(id); navigate("chat"); setGroupDetailsOpen(false); }}
              onNewGroup={() => { navigationGeneration.current += 1; if (allowSourceNavigation()) setCreatingGroup(true); }}
              activityContent={activityMounted ? (
                <Suspense fallback={null}>
                  <ActivityInbox
                    active={workspaceActive && activityVisible && !creatingGroup}
                    selectedId={selectedActivityId}
                    items={inbox.items} loading={inbox.loading} error={inbox.error} busy={inbox.busy}
                    coworkers={coworkers} groups={liveGroups} activityBySlug={visibleActivityBySlug}
                    onRefresh={() => void inbox.refresh()} onMarkRead={inbox.markRead} onOpen={openActivityItem}
                    onOpenDocument={openActivityDocument}
                    calendar={calendar}
                    onOpenEvent={openActivityEvent}
                    onOpenCalendar={() => { setSelectedActivityId(null); resumeCalendar(); }}
                    onNewEvent={() => { void requestCalendar({ intent: "create", fromActivity: true }); }}
                  />
                </Suspense>
              ) : undefined}
            />
            {creatingGroup ? (
              <NewGroupSheet
                coworkers={coworkers}
                onCancel={() => setCreatingGroup(false)}
                onCreated={(group) => {
                  replaceGroup(group);
                  setCreatingGroup(false);
                  if (!allowSourceNavigation()) return;
                  setActivityGroupRequest(null);
                  setGroupDocumentRequest(null);
                  setHomeRequest(null);
                  setGroupEventSource(null);
                  calendarConversationOrigin.current = null;
                  setSelectedActivityId(null);
                  setSelectedGroupId(group.id);
                  navigate("chat");
                }}
              />
            ) : null}
            {selectedGroup && groupDetailsOpen && !selectedEventLink ? (
              <GroupDetailsSheet
                group={selectedGroup}
                coworkers={coworkers}
                runtime={runtime}
                onClose={() => setGroupDetailsOpen(false)}
                onChanged={replaceGroup}
                onArchived={(group) => {
                  replaceGroup(group);
                  setGroupDetailsOpen(false);
                  setSelectedGroupId("");
                }}
              />
            ) : null}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col" onPointerDownCapture={() => { navigationGeneration.current += 1; }} onKeyDownCapture={() => { navigationGeneration.current += 1; }}>
            {navigationNotice ? <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-mist">
              <p className="min-w-0 flex-1">{navigationNotice}</p>
              <Button variant="ghost" className="text-xs" onClick={() => navigate("chat", true)}>Return to chat</Button>
              <Button variant="ghost" className="text-xs" onClick={() => setNavigationNotice("")}>Dismiss</Button>
            </div> : null}
            <div className={!calendarVisible ? "flex min-h-0 min-w-0 flex-1" : "hidden"} data-testid="chat-main-content" data-active={chatActive}>
            {selectedGroup ? (
              <GroupChat
                key={`${selectedGroup.id}:${selectedGroup.createdAt}`}
                group={selectedGroup}
                navigationGuard={readerNavigation}
                active={chatActive && !groupDetailsOpen && !creatingGroup}
                onExitActivity={activityVisible ? exitActivity : undefined}
                activityRequest={activityGroupRequest?.groupId === selectedGroup.id ? activityGroupRequest : null}
                event={selectedEventLink}
                onOpenEvent={openEvent}
                documentRequest={groupDocumentRequest?.groupId === selectedGroup.id ? groupDocumentRequest : null}
                documentsApi={coworkerBridge.groups.documents}
                coworkers={coworkers}
                runtime={runtime}
                onGroupChanged={replaceGroup}
                onGroupArchived={(group) => {
                  replaceGroup(group);
                  setSelectedGroupId("");
                }}
                onActivityLine={setGroupLine}
                onChooseModel={(slug) => {
                  if (visitCoworker(slug)) setHomeRequest({ id: nextRequestId(), slug, kind: "settings", section: "model" });
                }}
                onOpenAssignment={(slug, threadId) => {
                  if (visitCoworker(slug)) setHomeRequest({ id: nextRequestId(), slug, kind: "thread", threadId });
                }}
                onOpenDetails={() => setGroupDetailsOpen(true)}
              />
            ) : (
            selected ? <CoworkerHome
              key={`${selected.slug}:${selected.createdAt}`}
              navigationGuard={readerNavigation}
              active={chatActive && !creatingGroup}
              onExitActivity={activityVisible ? exitActivity : undefined}
              runtime={runtime}
              session={session}
              coworkers={coworkers}
              coworker={selected}
              activity={visibleActivityBySlug[selected.slug]}
              request={homeRequest?.slug === selected.slug && (!homeRequest.createdAt || homeRequest.createdAt === selected.createdAt) ? homeRequest : null}
              onActivityChange={updateSelectedLiveActivity}
              onCoworkerChanged={updateCoworkerInList}
              onCoworkerRemoved={removeCoworkerFromList}
              onRefreshRuntime={refreshRuntime}
              onRestartRuntime={restartRuntime}
              onSyncProviders={syncProviders}
              onOpenOpenWork={(section) => openGlobalSettings(section ?? "general")}
              connect={connectBySlug[selected.slug] ?? null}
              onRepairConnect={() => syncConnect({ force: true, remint: true, slug: selected.slug })}
              onConnectAccount={() => setConnecting(true)}
              railWidth={activityVisible ? Math.max(RAIL_BOUNDS.min, rail.width) : rail.width}
              onCoworkerAdded={addCoworkerToList}
              canHandOff={allowSourceNavigation}
              onHandOff={(slug, prompt) => visitCoworker(slug, prompt)}
              onVisitCoworker={(slug) => visitCoworker(slug)}
            /> : null
            )}
            </div>
            <div className={calendarVisible ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <CalendarView active={workspaceActive && calendarVisible && !creatingGroup && !groupDetailsOpen} coworkers={coworkers} data={calendar} preferences={calendarPreferences} onPreferencesChange={setCalendarPreferences} request={calendarRequest}
                onExitActivity={activityVisible ? () => navigate("calendar", true) : undefined}
                activityReminder={calendarReminder ? { id: calendarReminder.id, read: calendarReminder.readAt !== null, busy: inbox.busy, onMarkRead: () => inbox.markRead([calendarReminder.id]) } : undefined}
                onEventSelectionChange={rememberCalendarEvent}
                onOpenConversation={openEventConversation} onOpenArtifact={openEventArtifact} onOpenResponsibility={(slug, threadId) => {
                if (!visitCoworker(slug)) return;
                setHomeRequest(threadId ? { id: nextRequestId(), slug, kind: "thread", threadId } : { id: nextRequestId(), slug, kind: "responsibilities" });
              }} />
            </div>
            </div>
          </div>
        )}
      </div>
      {globalSettingsMounted ? (
        <div
          className={settingsActive ? "absolute inset-0 flex" : "hidden"}
          data-testid="openwork-settings-pane"
          data-active={settingsActive ? "true" : "false"}
        >
          <Suspense fallback={null}>
          <OpenWorkSettings
            active={settingsActive}
            runtime={runtime}
            session={session}
            providerSync={providerSync}
            templateSync={session ? templateSync : null}
            templateError={session ? templateError : ""}
            onSyncTemplates={syncAssignedCoworkers}
            onImportedTemplates={receiveImportedTemplates}
            coworkers={coworkers}
            selectedCoworker={selected}
            initialSection={globalSettings ?? "general"}
            onClose={closeGlobalSettings}
            onConnect={() => setConnecting(true)}
            onSignOut={signOut}
            onSyncProviders={syncProviders}
            onRefreshRuntime={refreshRuntime}
            onRestartRuntime={restartRuntime}
            onCoworkerChanged={updateCoworkerInList}
            onReplayOnboarding={() => {
              setGlobalSettings("fresh-start");
              setReplayOnboarding("welcome");
            }}
            onFactoryReset={() => {
              const opener = document.activeElement;
              resetReturnFocusRef.current = opener instanceof HTMLElement ? opener : null;
              setGlobalSettings("fresh-start");
              setFactoryResetOpen(true);
            }}
          />
          </Suspense>
        </div>
      ) : null}
      <Suspense fallback={null}>
        {factoryResetOpen ? <FactoryResetScreen coworkers={coworkers} onBack={() => setFactoryResetOpen(false)} /> : null}
        {replayOnboarding ? <OnboardingReplay step={replayOnboarding} onStep={setReplayOnboarding} runtime={runtime} session={session} onExit={() => {
          setReplayOnboarding(null);
          setGlobalSettings(null);
        }} /> : null}
      </Suspense>
    </div>
    </VoiceContext.Provider>
  );
}
