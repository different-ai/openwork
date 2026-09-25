import { patternDrafts, workPattern } from "@/lib/work-patterns";
import { CalendarView, type CalendarEventTarget, type CalendarRequest } from "@/ui/calendar";
import { useCalendarData } from "@/ui/calendar-data";
import { useCalendarPreferences } from "@/ui/calendar-preferences";
import { eventForTarget, groupEventTarget, type EventArtifact } from "@/lib/events";
import type { DocumentNavigationGuard } from "@/ui/documents";
import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  parseConnectHealth,
  type ConnectState,
} from "@/lib/connect";
import { projectWorkspaceReadiness, readCoworkerActivity, runtimeWorkspaceReadinessKey, workspacePreparationScope, workspaceReadinessCache, type CoworkerActivity, type WorkspacePreparationScope } from "@/lib/threads";
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
import { completeOnboardingDraft, emptyOnboardingDraft, loadOnboardingDraft, onboardingDraftForContext, onboardingStepFor, resumeOnboardingDraft, saveOnboardingDraft, toggleIntent, type OnboardingDraft, type OnboardingStep } from "@/lib/onboarding-team";
import { LocalModeScreen } from "@/ui/local-mode";
import type { TeamRole } from "@/lib/bridge";
import { AppLoader, CoworkerMark } from "@/ui/brand";
import type { SettingsSection } from "@/ui/openwork-settings";
import { VoiceContext } from "@/ui/use-voice";
import { useActivityInbox } from "@/ui/use-activity-inbox";
import { refreshFeatures, useFeatures } from "@/ui/use-features";
import { CustomizeCoworker, type CustomizeFocus } from "@/ui/customize-coworker";
import type { ActivityDocumentTarget } from "@/ui/activity-inbox";

const ActivityInbox = lazy(() => import("@/ui/activity-inbox").then((module) => ({ default: module.ActivityInbox })));
const OpenWorkSettings = lazy(() => import("@/ui/openwork-settings").then((module) => ({ default: module.OpenWorkSettings })));
const FactoryResetScreen = lazy(() => import("@/ui/factory-reset").then((module) => ({ default: module.FactoryResetScreen })));
const OnboardingReplay = lazy(() => import("@/ui/onboarding-replay").then((module) => ({ default: module.OnboardingReplay })));

/** Identity of a pushed account context; the server itself no-ops on a repeat. */
function sessionKey(session: DenSession): string {
  return `${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`;
}

type ScopedCoworkerActivity = { scope: WorkspacePreparationScope; activity: CoworkerActivity };
type CoworkerActivitySnapshots = Record<string, ScopedCoworkerActivity>;

function samePreparationScope(current: WorkspacePreparationScope | null | undefined, captured: WorkspacePreparationScope): boolean {
  return current?.runtimeKey === captured.runtimeKey && current.workspaceKey === captured.workspaceKey && current.configurationKey === captured.configurationKey;
}

function sameRuntimeInfo(current: RuntimeInfo | null, next: RuntimeInfo): boolean {
  if (!current || runtimeWorkspaceReadinessKey(current, "") !== runtimeWorkspaceReadinessKey(next, "")) return false;
  const workspaceIds = new Set([...Object.keys(current.workspaceReadinessRevisions ?? {}), ...Object.keys(next.workspaceReadinessRevisions ?? {})]);
  for (const workspaceId of workspaceIds) {
    if (runtimeWorkspaceReadinessKey(current, workspaceId) !== runtimeWorkspaceReadinessKey(next, workspaceId)) return false;
  }
  return current.engineError === next.engineError && current.appName === next.appName && current.version === next.version
    && current.coworkersDir === next.coworkersDir && current.denBaseUrl === next.denBaseUrl
    && current.deepLinkScheme === next.deepLinkScheme && current.deepLinksRegistered === next.deepLinksRegistered;
}

function activityForScope(entry: ScopedCoworkerActivity | undefined, scope: WorkspacePreparationScope): CoworkerActivity | null {
  if (!entry?.scope || entry.scope.runtimeKey !== scope.runtimeKey || entry.scope.workspaceKey !== scope.workspaceKey) return null;
  const activity = entry.activity;
  if (entry.scope.configurationKey !== scope.configurationKey
    && (["idle", "ready", "starting"].includes(activity.state) || (activity.state === "offline" && activity.label === "AI unavailable"))) {
    return { ...activity, state: "idle", label: "Available", detail: "", updatedAt: 0 };
  }
  return activity;
}

function reconcileActivitySnapshots(current: CoworkerActivitySnapshots, runtime: RuntimeInfo, coworkers: CoworkerSummary[], session: DenSession | null): CoworkerActivitySnapshots {
  const next: CoworkerActivitySnapshots = {};
  let changed = false;
  for (const coworker of coworkers) {
    const entry = current[coworker.slug];
    if (!entry?.scope) continue;
    const scope = workspacePreparationScope(runtime, coworker, session);
    const activity = activityForScope(entry, scope);
    if (!activity) { changed = true; continue; }
    if (samePreparationScope(entry.scope, scope)) next[coworker.slug] = entry;
    else { next[coworker.slug] = { scope, activity }; changed = true; }
  }
  return changed || Object.keys(current).length !== Object.keys(next).length ? next : current;
}

function mergeActivityReads(current: CoworkerActivitySnapshots, reads: Array<{ slug: string; scope: WorkspacePreparationScope; activity: CoworkerActivity | null }>, currentScope: (slug: string) => WorkspacePreparationScope | null): CoworkerActivitySnapshots {
  let next = current;
  for (const { slug, scope, activity } of reads) {
    if (!samePreparationScope(currentScope(slug), scope)) continue;
    if (!activity && !next[slug]) continue;
    if (next === current) next = { ...current };
    if (activity) next[slug] = { scope, activity };
    else delete next[slug];
  }
  return next;
}

function visibleCoworkerActivity(scope: WorkspacePreparationScope, polled: CoworkerActivity | null, live: CoworkerActivity | null, cloud: CoworkerActivity | null, attention: CoworkerActivity | null): CoworkerActivity {
  const candidates = [attention, live, cloud, polled];
  const activity = candidates.find((entry) => entry?.state === "attention")
    ?? candidates.find((entry) => entry?.state === "working" || entry?.state === "retrying")
    ?? candidates.find((entry) => entry?.state === "offline" || (entry?.state === "recent" && !["Ready", "Idle", "Available"].includes(entry.label)))
    ?? live ?? cloud ?? polled ?? null;
  const projected = projectWorkspaceReadiness(activity, workspaceReadinessCache.peek(scope));
  return { ...projected, ...(projected.last ?? polled?.last ? { last: projected.last ?? polled?.last } : {}), ...(polled?.recent ? { recent: polled.recent } : {}) };
}

class DeferredView extends Component<{ children: ReactNode; title: string; onBack: () => void; overlay?: boolean }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={`window-shell window-drag flex h-full min-w-0 flex-1 items-center justify-center p-6 ${this.props.overlay ? "absolute inset-0" : ""}`}>
        <div className="window-no-drag flex max-w-md flex-col items-center gap-4 text-center">
          <CoworkerMark size={64} />
          <p className="text-sm text-snow" role="alert">{this.props.title} could not open.</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={this.props.onBack}>Back</Button>
            <Button variant="primary" onClick={() => window.location.reload()}>Reload app</Button>
          </div>
        </div>
      </div>
    );
  }
}

function onboardingContext(session: DenSession | null): string {
  return session ? JSON.stringify([session.baseUrl, session.orgId, session.userEmail]) : "local";
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const runtimeRef = useRef(runtime);
  const runtimeObservation = useRef(0);
  const [bootReady, setBootReady] = useState(false);
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
  const selected = coworkers.find((coworker) => coworker.slug === selectedSlug) ?? null;
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
  const features = useFeatures();
  const calendar = useCalendarData(coworkers, session, Boolean(runtime) && features.calendar);
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
  /** The coworker whose Customize page is open, over the team view, which stays as it was underneath. */
  const [customizing, setCustomizing] = useState<{ slug: string; createdAt: string; focus?: CustomizeFocus; id: number } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(false);
  const [onboardingDraft, setOnboardingDraft] = useState<OnboardingDraft>(() => emptyOnboardingDraft());
  const onboardingDraftRef = useRef(onboardingDraft);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const accountKey = session ? sessionKey(session) : "local";
  const onboardingStep = onboardingStepFor(onboardingDraft);
  const updateOnboardingDraft = useCallback((next: OnboardingDraft | ((current: OnboardingDraft) => OnboardingDraft)) => {
    const resolved = typeof next === "function" ? next(onboardingDraftRef.current) : next;
    onboardingDraftRef.current = resolved;
    saveOnboardingDraft(window.sessionStorage, resolved);
    setOnboardingDraft(resolved);
  }, []);
  const setOnboardingStep = useCallback((step: OnboardingStep) => {
    updateOnboardingDraft((current) => ({ ...current, step }));
  }, [updateOnboardingDraft]);
  const finishOnboarding = useCallback(() => {
    updateOnboardingDraft(completeOnboardingDraft(onboardingDraftRef.current));
    setOnboardingReady(true);
  }, [updateOnboardingDraft]);
  const [teamCatalog, setTeamCatalog] = useState<TeamRole[]>([]);
  const [teamCatalogError, setTeamCatalogError] = useState("");
  const [teamCatalogReload, setTeamCatalogReload] = useState(0);
  const [teamError, setTeamError] = useState("");
  const [proposingTeam, setProposingTeam] = useState(false);
  const proposalGeneration = useRef(0);
  const [globalSettings, setGlobalSettings] = useState<SettingsSection | null>(null);
  const [globalSettingsMounted, setGlobalSettingsMounted] = useState(false);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [activityMounted, setActivityMounted] = useState(false);
  const [activityGroupRequest, setActivityGroupRequest] = useState<{ id: number; groupId: string; eventId: string; onOpened?: () => Promise<void> } | null>(null);
  const inbox = useActivityInbox(Boolean(runtime) && !factoryResetOpen);
  // A read-only tour, deliberately separate from first-run flags and persisted team drafts.
  const [replayOnboarding, setReplayOnboarding] = useState<"welcome" | "ai" | null>(null);
  const [activityBySlug, setActivityBySlug] = useState<CoworkerActivitySnapshots>({});
  const [liveActivityBySlug, setLiveActivityBySlug] = useState<CoworkerActivitySnapshots>({});
  const [attentionBySlug, setAttentionBySlug] = useState<CoworkerActivitySnapshots>({});
  /** OpenWork Connect (the `openwork-cloud` gateway) state per coworker, while signed in. */
  const [connectBySlug, setConnectBySlug] = useState<Record<string, ConnectState>>({});
  const connectTokenRef = useRef<{ sessionKey: string; token: ConnectToken } | null>(null);
  const accountEpochRef = useRef(0);
  const accountTransitionRef = useRef(false);
  const connectGenerationRef = useRef<{ key: string; generation: number } | null>(null);
  const [connectGeneration, setConnectGeneration] = useState(0);
  const connectedWorkspacesRef = useRef<Set<string>>(new Set());
  /** Automatic retries per coworker while the AI service is still coming up; cleared on success. */
  const connectRetryRef = useRef<Record<string, { attempts: number; timer: number }>>({});
  /** Cloud responsibilities Den is running right now, per coworker: "Running in OpenWork Cloud". */
  const [cloudRunBySlug, setCloudRunBySlug] = useState<CoworkerActivitySnapshots>({});
  const pushedSessionKeyRef = useRef("");
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const resetReturnFocusRef = useRef<HTMLElement | null>(null);
  const groupReadingRef = useRef(false);
  const activityReadingRef = useRef(new Map<string, WorkspacePreparationScope>());
  const activityRefreshRef = useRef<() => void>(() => {});

  const currentPreparationScope = useCallback((slug: string) => {
    const currentRuntime = runtimeRef.current;
    const coworker = coworkersRef.current.find((entry) => entry.slug === slug);
    return currentRuntime && coworker ? workspacePreparationScope(currentRuntime, coworker, sessionRef.current) : null;
  }, []);

  const reconcileActivities = useCallback((info: RuntimeInfo) => {
    const reconcile = (current: CoworkerActivitySnapshots) => reconcileActivitySnapshots(current, info, coworkersRef.current, sessionRef.current);
    setActivityBySlug(reconcile);
    setLiveActivityBySlug(reconcile);
    setAttentionBySlug(reconcile);
    setCloudRunBySlug(reconcile);
  }, []);

  const applyRuntime = useCallback((info: RuntimeInfo, expected?: RuntimeInfo, workspaceId = "", expectedSession?: DenSession | null): boolean => {
    if (expectedSession !== undefined && sessionRef.current !== expectedSession) return false;
    const current = runtimeRef.current;
    if (expected && current && current !== expected) {
      return runtimeWorkspaceReadinessKey(current, workspaceId) === runtimeWorkspaceReadinessKey(expected, workspaceId)
        && runtimeWorkspaceReadinessKey(info, workspaceId) === runtimeWorkspaceReadinessKey(current, workspaceId);
    }
    if (sameRuntimeInfo(current, info)) return true;
    runtimeObservation.current += 1;
    runtimeRef.current = info;
    reconcileActivities(info);
    setRuntime(info);
    return true;
  }, [reconcileActivities]);

  useEffect(() => {
    if (runtimeRef.current) reconcileActivities(runtimeRef.current);
    activityRefreshRef.current();
  }, [coworkers, session, runtime, reconcileActivities]);

  const bootGeneration = useRef(0);
  const boot = useCallback(async () => {
    const request = ++bootGeneration.current;
    const observation = runtimeObservation.current;
    const bootSession = sessionRef.current;
    try {
      // Optional features are read before the first screen, so nothing turned on appears late.
      const [list] = await Promise.all([coworkerBridge.coworkers.list(), refreshFeatures()]);
      const info = await coworkerBridge.runtimeInfo();
      // A fresh window runs no group turn, so any still recorded as running was cut off: settle it first.
      await coworkerBridge.groups.recoverInterrupted().catch(() => []);
      const groups = await coworkerBridge.groups.list();
      if (request !== bootGeneration.current || sessionRef.current !== bootSession) return;
      const currentSession = sessionRef.current;
      const restored = onboardingDraftForContext(currentSession && !currentSession.userEmail ? emptyOnboardingDraft() : loadOnboardingDraft(window.sessionStorage), onboardingContext(currentSession));
      const resumed = resumeOnboardingDraft(restored, list.length > 0);
      const saved: OnboardingDraft = currentSession && list.length === 0 && !resumed.completed && !onboardingStepFor(resumed) ? { ...resumed, step: "intents" } : resumed;
      const step = onboardingStepFor(saved);
      if (observation === runtimeObservation.current) applyRuntime(info);
      setBots(list);
      setGroups(groups);
      setSelectedSlug((current) =>
        current && list.some((coworker) => coworker.slug === current) ? current : (list[0]?.slug ?? ""),
      );
      updateOnboardingDraft(saved);
      setOnboardingReady(!step && (list.length > 0 || saved.completed === true));
      setCreating(step === "create");
      setBootError("");
      setBootReady(true);
    } catch (cause) {
      if (request === bootGeneration.current) setBootError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [applyRuntime, updateOnboardingDraft]);

  useEffect(() => {
    void boot();
    return coworkerBridge.onRuntimeChanged(applyRuntime);
  }, [applyRuntime, boot]);

  useEffect(() => {
    if (!runtime) return;
    let reading = false;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (reading || cancelled) return;
      reading = true;
      const observation = runtimeObservation.current;
      try {
        const info = await coworkerBridge.runtimeInfo();
        if (!cancelled && observation === runtimeObservation.current) applyRuntime(info);
      } catch { }
      finally { reading = false; }
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyRuntime, runtime?.serverUrl]);

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
    const observation = runtimeObservation.current;
    const account = sessionRef.current;
    const info = await coworkerBridge.runtimeInfo();
    if (observation === runtimeObservation.current && account === sessionRef.current) applyRuntime(info);
  }, [applyRuntime]);

  const restartRuntime = useCallback(async () => {
    const observation = runtimeObservation.current;
    const account = sessionRef.current;
    const info = await coworkerBridge.restartRuntime();
    if (observation === runtimeObservation.current && account === sessionRef.current) applyRuntime(info);
  }, [applyRuntime]);

  const receiveImportedTemplates = useCallback((result: CoworkerTemplateSync) => {
    const first = result.created[0];
    if (!first) return;
    setBots((current) => [...current, ...result.created.filter((item) => !current.some((known) => known.slug === item.slug))]);
    setSelectedSlug((current) => current || first.slug);
    // Coworkers arrived (an import, or the team an organization assigned): the person meets
    // them, unless they are in the middle of choosing a team of their own.
    const draft = onboardingDraftRef.current;
    const choosingOwnTeam = Boolean(onboardingStepFor(draft)) && (draft.intents.length > 0 || draft.drafts.length > 0);
    if (!choosingOwnTeam) {
      if (onboardingStepFor(draft)) updateOnboardingDraft(completeOnboardingDraft(draft));
      setOnboardingReady(true);
      setCreating(false);
    }
    void refreshRuntime();
  }, [refreshRuntime, updateOnboardingDraft]);

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
   * session and again after every sign-in; main returns a fresh account generation.
   */
  const pushSession = useCallback(async (next: DenSession): Promise<ProviderSyncRun & { accountGeneration?: number }> => {
    const epoch = accountEpochRef.current;
    pushedSessionKeyRef.current = sessionKey(next);
    try {
      const run = await coworkerBridge.den.setSession(providerSyncSession(next));
      if (epoch !== accountEpochRef.current || pushedSessionKeyRef.current !== sessionKey(next)) return run;
      connectGenerationRef.current = { key: sessionKey(next), generation: run.accountGeneration };
      setConnectGeneration(run.accountGeneration);
      setProviderSync(run);
      setTemplateSync(null);
      setTemplateError("");
      try {
        const result = await coworkerBridge.templates.sync({ userEmail: next.userEmail, automatic: true });
        if (epoch === accountEpochRef.current && pushedSessionKeyRef.current === sessionKey(next)) receiveTemplates(result);
      } catch (cause) {
        if (epoch === accountEpochRef.current && pushedSessionKeyRef.current === sessionKey(next)) setTemplateError(cause instanceof Error ? cause.message : "Your team's coworkers could not be loaded. Refresh them in Account settings.");
      }
      return run;
    } catch (cause) {
      const failed: ProviderSyncRun = { status: "failed", message: cause instanceof Error ? cause.message : String(cause) };
      if (epoch === accountEpochRef.current && pushedSessionKeyRef.current === sessionKey(next)) setProviderSync(failed);
      return failed;
    } finally {
      if (epoch === accountEpochRef.current && pushedSessionKeyRef.current === sessionKey(next)) void refreshRuntime();
    }
  }, [receiveTemplates, refreshRuntime]);

  useEffect(() => {
    if (!bootReady || !runtime || !session || pushedSessionKeyRef.current === sessionKey(session)) return;
    void pushSession(session);
  }, [bootReady, pushSession, runtime, session]);

  const clearAccountPresentation = useCallback(() => {
    runtimeObservation.current += 1;
    setActivityBySlug({});
    setLiveActivityBySlug({});
    for (const pending of Object.values(connectRetryRef.current)) window.clearTimeout(pending.timer);
    connectRetryRef.current = {};
    connectedWorkspacesRef.current.clear();
    connectTokenRef.current = null;
    setConnectBySlug({});
    setProviderSync(null);
    setTemplateSync(null);
    setTemplateError("");
    setAttentionBySlug({});
    setCloudRunBySlug({});
  }, []);

  const signInWithGrant = useCallback(async (grant: string, baseUrl?: string) => {
    if (!runtime || accountTransitionRef.current) return;
    accountTransitionRef.current = true;
    const firstRun = Boolean(onboardingStepFor(onboardingDraftRef.current)) || (!onboardingReady && coworkersRef.current.length === 0);
    setSignInBusy(true);
    setSignInError("");
    try {
      const next = await exchangeGrant(baseUrl ?? runtime.denBaseUrl, grant);
      accountEpochRef.current += 1;
      connectGenerationRef.current = null;
      const previous = onboardingDraftRef.current;
      const scoped = onboardingDraftForContext(next.userEmail ? previous : emptyOnboardingDraft(), onboardingContext(next));
      if (firstRun) {
        updateOnboardingDraft({ ...scoped, step: "intents" });
        setOnboardingReady(false);
      } else updateOnboardingDraft(scoped);
      clearAccountPresentation();
      writeDenSession(next);
      sessionRef.current = next;
      setSession(next);
      const run = await pushSession(next);
      if (run.accountGeneration === undefined) throw new Error(run.message || "The OpenWork account could not be applied. Try signing in again.");
      if (sessionRef.current === next) setConnecting(false);
    } catch (cause) {
      setSignInError(cause instanceof Error ? cause.message : String(cause));
      setConnecting(true);
    } finally {
      accountTransitionRef.current = false;
      setSignInBusy(false);
    }
  }, [clearAccountPresentation, onboardingReady, pushSession, runtime, updateOnboardingDraft]);

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
    if (accountTransitionRef.current) throw new Error("An account change is already in progress. Try again when it finishes.");
    accountTransitionRef.current = true;
    accountEpochRef.current += 1;
    connectGenerationRef.current = null;
    for (const pending of Object.values(connectRetryRef.current)) window.clearTimeout(pending.timer);
    connectRetryRef.current = {};
    try {
      // Main owns teardown across every workspace, including registrations
      // still pending in the native host. A rejection keeps this account visible.
      await coworkerBridge.den.clearSession();
      clearAccountPresentation();
      updateOnboardingDraft(onboardingDraftForContext(onboardingDraftRef.current, "local"));
      writeDenSession(null);
      sessionRef.current = null;
      setSession(null);
      pushedSessionKeyRef.current = "";
      await refreshRuntime();
    } finally {
      accountTransitionRef.current = false;
    }
  }, [clearAccountPresentation, refreshRuntime, updateOnboardingDraft]);

  const syncProviders = useCallback(async (): Promise<ProviderSyncRun> => {
    const key = pushedSessionKeyRef.current;
    try {
      const run = await coworkerBridge.den.syncProviders();
      if (pushedSessionKeyRef.current === key) setProviderSync(run);
      return run;
    } catch (cause) {
      const failed: ProviderSyncRun = { status: "failed", message: cause instanceof Error ? cause.message : String(cause) };
      if (pushedSessionKeyRef.current === key) setProviderSync(failed);
      return failed;
    } finally {
      if (pushedSessionKeyRef.current === key) void refreshRuntime();
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
    const epoch = accountEpochRef.current;
    const generation = connectGenerationRef.current;
    const isCurrentAccount = () => !accountTransitionRef.current && epoch === accountEpochRef.current
      && generation !== null && connectGenerationRef.current === generation && generation.key === key
      && sessionRef.current !== null && sessionKey(sessionRef.current) === key;
    if (!isCurrentAccount()) return;
    const targets = coworkers.filter((coworker) =>
      coworker.workspaceId
      && (!options.slug || coworker.slug === options.slug)
      && (options.force || !connectedWorkspacesRef.current.has(`${key}\u0000${runtime.teamWorkspaceId ?? coworker.workspaceId}`)),
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
        if (!isCurrentAccount()) return;
        connectTokenRef.current = { sessionKey: key, token };
      }
    } catch (cause) {
      if (!isCurrentAccount()) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setConnectBySlug((current) => {
        const next = { ...current };
        for (const coworker of targets) next[coworker.slug] = { status: "unavailable", message: `OpenWork could not issue a Connect token: ${message}` };
        return next;
      });
      return;
    }
    const minted = token;
    // The team shares one workspace: register the gateway once per workspace and
    // give every coworker in it the same outcome.
    const registrations = new Map<string, Promise<ConnectState>>();
    const register = (workspaceId: string) => {
      let pending = registrations.get(workspaceId);
      if (!pending) {
        pending = (async (): Promise<ConnectState> => {
          const payload = connectReconcilePayload({ workspaceId, session, token: minted, appVersion: runtime.version });
          try {
            if (!isCurrentAccount() || !generation) throw new Error("The OpenWork account changed.");
            if (!payload) throw new Error("OpenWork did not name a gateway for this organization.");
            const state = connectStateFromHealth(parseConnectHealth(await coworkerBridge.den.reconcileConnect(generation.generation, workspaceId, payload)));
            if (isCurrentAccount()) connectedWorkspacesRef.current.add(`${key}\u0000${workspaceId}`);
            return state;
          } catch (cause) {
            return { status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
          }
        })();
        registrations.set(workspaceId, pending);
      }
      return pending;
    };
    await Promise.all(targets.map(async (coworker) => {
      const state = await register(runtime.teamWorkspaceId ?? coworker.workspaceId);
      if (!isCurrentAccount()) return;
      setConnectBySlug((current) => ({ ...current, [coworker.slug]: state }));
      // Right after a coworker is created its AI service may still be starting, so the first
      // registration can land before the engine answers. Try again by itself a few times.
      const previous = connectRetryRef.current[coworker.slug]?.attempts ?? 0;
      if (state.status === "connected" || previous >= 6) {
        delete connectRetryRef.current[coworker.slug];
        return;
      }
      const attempts = previous + 1;
      const timer = window.setTimeout(() => { if (isCurrentAccount()) void syncConnect({ force: true, slug: coworker.slug }); }, Math.min(60_000, 5_000 * attempts));
      connectRetryRef.current[coworker.slug] = { attempts, timer };
    }));
  }, [coworkers, runtime, session]);

  useEffect(() => {
    if (!session || !runtime?.engineManaged) return;
    void syncConnect();
    // Tokens are short-lived: refresh before they lapse while the app stays open.
    const timer = window.setInterval(() => void syncConnect({ force: true, remint: true }), 20 * 60_000);
    return () => window.clearInterval(timer);
  }, [runtime?.engineManaged, session, syncConnect, connectGeneration, signInBusy]);

  const activityEnabled = Boolean(runtime) && bootReady && !factoryResetOpen;
  useEffect(() => {
    if (!activityEnabled) return;
    let cancelled = false;
    const readActivity = async (coworker: CoworkerSummary, info: RuntimeInfo, preparationScope: WorkspacePreparationScope): Promise<CoworkerActivity | null> => {
      const isCurrent = () => !cancelled && samePreparationScope(currentPreparationScope(coworker.slug), preparationScope);
      if (!isCurrent()) return null;
      if (!info.engineManaged) return { state: "offline", label: "AI unavailable", detail: "OpenCode should start right away.", updatedAt: 0 };
      const workspaceId = coworker.workspaceId || info.teamWorkspaceId;
      if (!workspaceId) return null;
      const workers = await coworkerBridge.workers.list(coworker.slug).catch(() => []);
      if (!isCurrent()) return null;
      const [threadActivity, localResponsibilities] = await Promise.all([
        readCoworkerActivity({
          serverUrl: info.serverUrl, workspaceId, token: info.ownerToken,
          owner: { slug: coworker.slug, createdAt: coworker.createdAt },
          conversationThreadId: coworker.conversationThreadId,
          workerThreadIds: workers.map((worker) => worker.threadId).filter(Boolean), preparationScope,
        }),
        coworkerBridge.localResponsibilities.list(coworker.slug).catch(() => []),
      ]);
      if (!isCurrent()) return null;
      if (threadActivity.state === "attention") return threadActivity;
      const deciding = workers.find((worker) => worker.status === "waiting" && worker.waitingFor === "decision");
      if (deciding) return {
        state: "attention", label: "Needs you", detail: `${deciding.name} needs a decision`, updatedAt: deciding.updatedAt,
        ...(coworker.conversationThreadId ? { threadId: coworker.conversationThreadId } : {}),
        ...(threadActivity.last ? { last: threadActivity.last } : {}), ...(threadActivity.recent ? { recent: threadActivity.recent } : {}),
      };
      const localRunning = localResponsibilities.find((item) => item.latestRun?.status === "running");
      const localSuccess = localResponsibilities
        .filter((item) => item.latestRun?.status === "succeeded")
        .sort((left, right) => (right.latestRun?.finishedAt ?? 0) - (left.latestRun?.finishedAt ?? 0))[0];
      const localSuccessAt = localSuccess?.latestRun?.finishedAt ?? 0;
      const latestActivity = localSuccess && localSuccessAt > (threadActivity.last?.updatedAt ?? 0)
        ? { title: localSuccess.name, updatedAt: localSuccessAt, threadId: localSuccess.latestRun?.threadId }
        : threadActivity.last;
      if (localRunning?.latestRun) return {
        state: "working", label: "Running locally", detail: localRunning.name, updatedAt: localRunning.latestRun.startedAt,
        ...(localRunning.latestRun.threadId ? { threadId: localRunning.latestRun.threadId } : {}),
        ...(latestActivity ? { last: latestActivity } : {}), ...(threadActivity.recent ? { recent: threadActivity.recent } : {}),
      };
      const localFailure = localResponsibilities
        .filter((item) => item.latestRun?.status === "failed")
        .sort((left, right) => (right.latestRun?.finishedAt ?? 0) - (left.latestRun?.finishedAt ?? 0))[0];
      if (localFailure?.latestRun) return {
        state: "attention", label: "Run failed", detail: localFailure.name, updatedAt: localFailure.latestRun.finishedAt ?? localFailure.latestRun.startedAt,
        ...(localFailure.latestRun.threadId ? { threadId: localFailure.latestRun.threadId } : {}),
        ...(latestActivity ? { last: latestActivity } : {}), ...(threadActivity.recent ? { recent: threadActivity.recent } : {}),
      };
      const now = Date.now();
      const upcoming = localResponsibilities
        .filter((item) => item.state === "active" && typeof item.nextDueAt === "number" && item.nextDueAt > now)
        .sort((left, right) => (left.nextDueAt ?? 0) - (right.nextDueAt ?? 0))[0];
      const withNext = upcoming?.nextDueAt ? { next: { name: upcoming.name, at: upcoming.nextDueAt } } : {};
      return { ...threadActivity, ...(latestActivity ? { last: latestActivity } : {}), ...withNext };
    };
    const refresh = () => {
      const info = runtimeRef.current;
      if (cancelled || !info) return;
      for (const coworker of coworkersRef.current) {
        const scope = workspacePreparationScope(info, coworker, sessionRef.current);
        if (samePreparationScope(activityReadingRef.current.get(scope.workspaceKey), scope)) continue;
        activityReadingRef.current.set(scope.workspaceKey, scope);
        void readActivity(coworker, info, scope).then((activity) => {
          if (!activity || cancelled || !samePreparationScope(currentPreparationScope(coworker.slug), scope)) return;
          setActivityBySlug((current) => mergeActivityReads(current, [{ slug: coworker.slug, scope, activity }], currentPreparationScope));
        }).catch(() => undefined).finally(() => {
          if (activityReadingRef.current.get(scope.workspaceKey) === scope) activityReadingRef.current.delete(scope.workspaceKey);
        });
      }
    };
    activityRefreshRef.current = refresh;
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => {
      cancelled = true;
      if (activityRefreshRef.current === refresh) activityRefreshRef.current = () => {};
      window.clearInterval(timer);
    };
  }, [activityEnabled, currentPreparationScope]);

  useEffect(() => {
    if (!session) {
      setAttentionBySlug({});
      setCloudRunBySlug({});
      return;
    }
    let cancelled = false;
    const den = createDenAutomationsClient(session);
    const refreshAttention = async () => {
      const info = runtimeRef.current;
      if (!info) return;
      const scopes = new Map<string, WorkspacePreparationScope>(coworkers.map((coworker) => [coworker.slug, workspacePreparationScope(info, coworker, session)]));
      try {
        const list = await den.list();
        const next: CoworkerActivitySnapshots = {};
        const running: CoworkerActivitySnapshots = {};
        for (const coworker of coworkers) {
          const scope = scopes.get(coworker.slug);
          if (!scope || !samePreparationScope(currentPreparationScope(coworker.slug), scope)) continue;
          const owned = list.items.filter(
            (entry) =>
              coworker.automations.includes(entry.automation.id) ||
              Boolean(coworker.workspaceId && entry.revision.workspaceId === coworker.workspaceId),
          );
          const attention = owned.find((entry) => entry.automation.state === "needs_attention");
          if (attention) {
            next[coworker.slug] = { scope, activity: { state: "attention", label: "Needs you", detail: attention.automation.needsAttentionReason?.message || attention.automation.name, updatedAt: 0 } };
          }
          const active = owned.find((entry) =>
            entry.latestRun !== null && ["queued", "claimed", "running"].includes(entry.latestRun.status),
          );
          if (active?.latestRun) {
            running[coworker.slug] = { scope, activity: {
              state: "working",
              label: active.latestRun.status === "running" ? "Running in OpenWork Cloud" : "Queued in OpenWork Cloud",
              detail: active.automation.name,
              updatedAt: active.latestRun.startedAt ?? active.latestRun.createdAt,
            } };
          }
        }
        if (!cancelled && sessionRef.current === session) {
          const reads = (entries: CoworkerActivitySnapshots) => Array.from(scopes, ([slug, scope]) => ({ slug, scope, activity: entries[slug]?.activity ?? null }));
          setAttentionBySlug((current) => mergeActivityReads(current, reads(next), currentPreparationScope));
          setCloudRunBySlug((current) => mergeActivityReads(current, reads(running), currentPreparationScope));
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
  }, [session, coworkers, currentPreparationScope]);

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
    setTeamCatalogError("");
    coworkerBridge.team.catalog()
      .then((catalog) => {
        if (!cancelled) setTeamCatalog(catalog);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setTeamCatalogError(`Team roles could not be loaded. ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [onboardingStep, teamCatalog.length, teamCatalogReload]);

  const addOwnCoworker = useCallback(() => {
    setOnboardingStep("create");
    setOnboardingReady(true);
    setCreating(true);
  }, [setOnboardingStep]);

  const proposeTeam = useCallback(async () => {
    if (proposingTeam) return;
    const draft = onboardingDraftRef.current;
    if (draft.drafts.length > 0) {
      setOnboardingStep("team");
      return;
    }
    const request = ++proposalGeneration.current;
    setProposingTeam(true);
    setTeamError("");
    try {
      const drafts = patternDrafts(await coworkerBridge.team.recommend(draft.intents), draft.patternId ?? "");
      const current = onboardingDraftRef.current;
      if (request !== proposalGeneration.current || current.draftId !== draft.draftId || onboardingStepFor(current) !== "intents"
        || current.patternId !== draft.patternId || current.intents.join("\u0000") !== draft.intents.join("\u0000")) return;
      updateOnboardingDraft({ ...current, drafts, step: "team" });
    } catch (cause) {
      if (request === proposalGeneration.current) setTeamError(`Your team could not be proposed. Retry Continue. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (request === proposalGeneration.current) setProposingTeam(false);
    }
  }, [proposingTeam, setOnboardingStep, updateOnboardingDraft]);

  const selectedPreparation = runtime && selected ? workspacePreparationScope(runtime, selected, session) : null;
  const updateSelectedLiveActivity = useCallback((activity: CoworkerActivity | null) => {
    if (!selectedSlug || !selectedPreparation) return;
    setLiveActivityBySlug((current) => mergeActivityReads(current, [{ slug: selectedSlug, scope: selectedPreparation, activity }], currentPreparationScope));
  }, [currentPreparationScope, selectedSlug, selectedPreparation?.runtimeKey, selectedPreparation?.workspaceKey, selectedPreparation?.configurationKey]);

  // Opening a conversation reads it: its activity leaves the unread list, the way
  // opening a thread clears its badge in a messaging app. Only while the chat is on screen.
  const openGroupId = groups.some((group) => group.id === selectedGroupId && (features.calendar || !group.eventId)) ? selectedGroupId : "";
  const readingSlug = openGroupId ? "" : selected?.slug ?? "";
  const readingCreatedAt = openGroupId ? "" : selected?.createdAt ?? "";
  const chatOnScreen = mainContent === "chat" && !globalSettings && !factoryResetOpen && !replayOnboarding && !customizing;
  const unreadInOpenChat = inbox.items.filter((item) => item.readAt === null && item.kind !== "event-reminder" && (openGroupId
    ? item.target.kind === "group" && item.target.groupId === openGroupId
    : item.target.kind === "private" && item.slug === readingSlug && item.coworkerCreatedAt === readingCreatedAt)).map((item) => item.id).join(",");
  const markOpenChatRead = inbox.markRead;
  useEffect(() => {
    if (!chatOnScreen || !unreadInOpenChat || document.visibilityState !== "visible") return;
    void markOpenChatRead(unreadInOpenChat.split(","), true).catch(() => undefined);
  }, [chatOnScreen, unreadInOpenChat, markOpenChatRead]);

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

  if (!runtime || !bootReady) {
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

  if (coworkers.length === 0 && calendar.loading && !onboardingStep && !creating) return <AppLoader />;

  if (!creating && ((onboardingStep && onboardingStep !== "create") || (coworkers.length === 0 && calendar.events.length === 0 && !onboardingReady))) {
    const teamCatalogNotice = teamCatalogError ? <div role="alert" className="window-no-drag flex shrink-0 items-center gap-3 px-6 py-3">
      <ErrorNote>{teamCatalogError}</ErrorNote>
      <Button variant="ghost" className="shrink-0 text-xs" onClick={() => setTeamCatalogReload((current) => current + 1)}>Retry loading roles</Button>
    </div> : null;
    if (onboardingStep === "team") {
      return (
        <div className="flex h-full flex-col"><div className="min-h-0 flex-1">
        <OnboardingTeam
          catalog={teamCatalog}
          draft={onboardingDraft}
          onChange={updateOnboardingDraft}
          onBack={() => setOnboardingStep("intents")}
          onCreated={(team, firstSlug) => {
            const first = team.find((coworker) => coworker.slug === firstSlug) ?? team[0];
            if (first) acknowledgeCoworker(first.slug, "wake");
            setBots((current) => [...current.filter((coworker) => !team.some((added) => added.slug === coworker.slug)), ...team]);
            setSelectedSlug((current) => first?.slug ?? current);
            finishOnboarding();
            void refreshRuntime();
          }}
        />
        </div>{teamCatalogNotice}</div>
      );
    }
    if (onboardingStep === "intents") {
      return (
        <div className="window-shell flex h-full flex-col">
          <fieldset disabled={proposingTeam} aria-busy={proposingTeam} className="min-h-0 min-w-0 flex-1">
            <OnboardingIntents
              catalog={teamCatalog}
              selected={onboardingDraft.intents}
              patternId={onboardingDraft.patternId ?? ""}
              onPattern={(patternId) => updateOnboardingDraft((current) => current.patternId === patternId ? current : { ...current, patternId, intents: workPattern(patternId)?.jobs.map((job) => job.roleId) ?? [], drafts: [] })}
              onToggle={(id) => updateOnboardingDraft((current) => ({ ...current, intents: toggleIntent(current.intents, id), drafts: [] }))}
              onContinue={() => void proposeTeam()}
              onOwn={addOwnCoworker}
              onBack={() => setOnboardingStep(session ? "welcome" : "local")}
            />
          </fieldset>
          {teamCatalogNotice}
          {teamError ? <div role="alert" className="window-no-drag shrink-0 px-6 py-3"><ErrorNote>{teamError}</ErrorNote></div> : null}
        </div>
      );
    }
    if (onboardingStep === "local") {
      return (
        <LocalModeScreen
          key={accountKey}
          runtime={runtime}
          session={session}
          onConnectAccount={() => setConnecting(true)}
          onRuntimeChanged={refreshRuntime}
          onBack={() => setOnboardingStep("welcome")}
          onContinue={() => setOnboardingStep("intents")}
        />
      );
    }
    return (
      <OnboardingWelcome
        onConnect={() => setConnecting(true)}
        onContinueLocally={() => setOnboardingStep("local")}
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

  // With Calendar off, an Event's conversation is hidden along with the Event.
  const shownGroup = (group: CoworkerGroupSummary) => features.calendar || !group.eventId;
  const liveGroups = groups.filter((group) => !group.archivedAt && shownGroup(group));
  const selectedGroup = groups.find((group) => group.id === selectedGroupId && shownGroup(group)) ?? null;
  const eventGroupIds = new Set(calendar.events.map((event) => event.groupId));
  const selectedEventTarget = selectedGroup ? groupEventTarget(selectedGroup, calendar.events, groupEventSource ?? undefined) : undefined;
  const selectedEvent = selectedEventTarget ? eventForTarget(calendar.events, calendar.eventRuns, selectedEventTarget) : undefined;
  const selectedEventLink = selectedEventTarget ? { id: selectedEventTarget.eventId, title: selectedEvent?.title ?? selectedGroup?.name ?? "Event" } : undefined;
  const visibleActivityBySlug: Record<string, CoworkerActivity> = {};
  for (const coworker of coworkers) {
    const scope = workspacePreparationScope(runtime, coworker, session);
    const activity = activityForScope(activityBySlug[coworker.slug], scope);
    const liveActivity = activityForScope(liveActivityBySlug[coworker.slug], scope);
    const cloudRun = activityForScope(cloudRunBySlug[coworker.slug], scope);
    const attention = activityForScope(attentionBySlug[coworker.slug], scope);
    const fallback: CoworkerActivity | null = !runtime.engineManaged
      ? { state: "offline", label: "AI unavailable", detail: "OpenCode should start right away.", updatedAt: 0 }
      : null;
    visibleActivityBySlug[coworker.slug] = visibleCoworkerActivity(scope, activity ?? fallback, liveActivity, cloudRun, attention);
  }

  function updateCoworkerInList(updated: CoworkerSummary) {
    setBots((current) => current.map((coworker) => (coworker.slug === updated.slug && coworker.createdAt === updated.createdAt ? updated : coworker)));
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

  function openCustomize(slug: string, focus?: CustomizeFocus) {
    const coworker = coworkersRef.current.find((member) => member.slug === slug);
    if (!coworker) return;
    navigationGeneration.current += 1;
    setCustomizing({ slug, createdAt: coworker.createdAt, ...(focus ? { focus } : {}), id: nextRequestId() });
  }

  function removeCoworkerFromList(slug: string) {
    const remaining = coworkers.filter((coworker) => coworker.slug !== slug);
    setBots(remaining);
    if (selectedSlug === slug) {
      setSelectedSlug(remaining[0]?.slug ?? "");
    }
  }

  const customizingCoworker = customizing ? coworkers.find((coworker) => coworker.slug === customizing.slug && coworker.createdAt === customizing.createdAt) ?? null : null;
  const workspaceActive = !globalSettings && !factoryResetOpen && !replayOnboarding && !customizingCoworker;
  const settingsActive = Boolean(globalSettings) && !factoryResetOpen && !replayOnboarding;
  const activityVisible = mainContent === "activity";
  const contentContext = activityVisible ? activityContext : mainContent;
  const calendarVisible = features.calendar && (contentContext === "calendar" || (contentContext === "chat" && !selected && !selectedGroup));
  const chatActive = workspaceActive && !calendarVisible;
  const calendarReminder = inbox.items.find((item) => item.kind === "event-reminder" && item.id === calendarRequest?.reminderId);

  return (
    <VoiceContext.Provider value={{ accountKey: session ? `${sessionKey(session)}\u0000${session.userEmail}` : "signed-out", openModels: () => openGlobalSettings("models"), signIn: () => setConnecting(true) }}>
    <div key={accountKey} className="window-shell relative flex h-full overflow-hidden" data-testid="coworker-shell">
      <div
        className={workspaceActive ? "flex min-w-0 flex-1" : "hidden"}
        data-testid="coworker-workspace"
        data-active={workspaceActive ? "true" : "false"}
      >
        {creating || (!selected && (!features.calendar || calendar.events.length === 0)) ? (
          // Creation takes the whole window: the team list returns once the coworker exists.
          <div key="create" className="flex min-w-0 flex-1">
            <NewCoworker
              runtime={runtime}
              session={session}
              team={coworkers}
              onAskTeam={(slug, prompt) => { setCreating(false); visitCoworker(slug, prompt); }}
              onCancel={selected || coworkers.length > 0 || calendar.events.length > 0 ? () => setCreating(false) : null}
              onCreated={(coworker) => {
                setCreating(false);
                if (onboardingStep === "create") finishOnboarding();
                addCoworkerToList(coworker);
                setSelectedSlug(coworker.slug);
                navigate("chat");
              }}
            />
          </div>
        ) : (
          <div key="team" className="flex min-w-0 flex-1">
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
              unreadActivity={inbox.items.filter((item) => item.readAt === null && (features.calendar || item.kind !== "event-reminder")).length}
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
                <DeferredView title="Activity" onBack={() => navigate("chat", true)}>
                <Suspense fallback={<div className="h-full flex-1"><AppLoader message="Opening activity" detail="" /></div>}>
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
                </DeferredView>
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
            {navigationNotice ? <NavigationNoticeDialog message={navigationNotice} onReturn={() => navigate("chat", true)} onDismiss={() => setNavigationNotice("")} /> : null}
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
                onChooseModel={(slug) => openCustomize(slug, "model")}
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
              onCustomize={(focus) => openCustomize(selected.slug, focus)}
            /> : null
            )}
            </div>
            {features.calendar ? <div className={calendarVisible ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <CalendarView active={workspaceActive && calendarVisible && !creatingGroup && !groupDetailsOpen} coworkers={coworkers} data={calendar} preferences={calendarPreferences} onPreferencesChange={setCalendarPreferences} request={calendarRequest}
                onExitActivity={activityVisible ? () => navigate("calendar", true) : undefined}
                activityReminder={calendarReminder ? { id: calendarReminder.id, read: calendarReminder.readAt !== null, busy: inbox.busy, onMarkRead: () => inbox.markRead([calendarReminder.id]) } : undefined}
                onEventSelectionChange={rememberCalendarEvent}
                onOpenConversation={openEventConversation} onOpenArtifact={openEventArtifact} onOpenResponsibility={(slug, threadId) => {
                if (!visitCoworker(slug)) return;
                setHomeRequest(threadId ? { id: nextRequestId(), slug, kind: "thread", threadId } : { id: nextRequestId(), slug, kind: "responsibilities" });
              }} />
            </div> : null}
            </div>
          </div>
        )}
      </div>
      {customizingCoworker && !globalSettings && !factoryResetOpen && !replayOnboarding ? (
        <div className="absolute inset-0 flex" data-testid="customize-coworker-pane">
          <CustomizeCoworker
            key={`${customizingCoworker.slug}:${customizing?.id}`}
            runtime={runtime}
            session={session}
            coworker={customizingCoworker}
            focus={customizing?.focus}
            onCoworkerChanged={updateCoworkerInList}
            onSyncProviders={syncProviders}
            onOpenAccount={() => openGlobalSettings("account")}
            onOpenModelDefaults={() => openGlobalSettings("model-defaults")}
            onDone={() => setCustomizing(null)}
          />
        </div>
      ) : null}
      {globalSettingsMounted ? (
        <div
          className={settingsActive ? "absolute inset-0 flex" : "hidden"}
          data-testid="openwork-settings-pane"
          data-active={settingsActive ? "true" : "false"}
        >
          <DeferredView title="Settings" onBack={closeGlobalSettings}>
          <Suspense fallback={<div className="flex-1"><AppLoader message="Opening settings" detail="" /></div>}>
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
          </DeferredView>
        </div>
      ) : null}
      {factoryResetOpen || replayOnboarding ? <DeferredView title={factoryResetOpen ? "Fresh start" : "Onboarding replay"} overlay onBack={() => { setFactoryResetOpen(false); setReplayOnboarding(null); }}>
      <Suspense fallback={<div className="absolute inset-0"><AppLoader message={factoryResetOpen ? "Opening fresh start" : "Opening onboarding replay"} detail="" /></div>}>
        {factoryResetOpen ? <FactoryResetScreen coworkers={coworkers} onBack={() => setFactoryResetOpen(false)} /> : null}
        {replayOnboarding ? <OnboardingReplay step={replayOnboarding} onStep={setReplayOnboarding} runtime={runtime} session={session} onExit={() => {
          setReplayOnboarding(null);
          setGlobalSettings(null);
        }} /> : null}
      </Suspense>
      </DeferredView> : null}
    </div>
    </VoiceContext.Provider>
  );
}

/**
 * Why a move to another place did not happen (unsaved settings, a document in
 * the middle of an edit): a small centered dialog, so it is seen wherever the
 * person is looking, with the way back and a dismiss.
 */
function NavigationNoticeDialog({ message, onReturn, onDismiss }: { message: string; onReturn: () => void; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }} onKeyDown={(event) => { if (event.key === "Escape") onDismiss(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="navigation-notice-text" className="w-full max-w-sm rounded-2xl border border-line bg-panel p-4 shadow-[0_24px_64px_rgb(0_0_0/0.5)]" data-testid="navigation-notice">
        <p id="navigation-notice-text" className="text-sm leading-relaxed text-snow">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" className="text-xs" onClick={onDismiss}>Dismiss</Button>
          <Button autoFocus variant="primary" className="text-xs" onClick={onReturn}>Return to chat</Button>
        </div>
      </div>
    </div>
  );
}
