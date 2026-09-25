import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import type { CoworkerSummary, RuntimeInfo, TeamDraft, TeamRole } from "./bridge.ts";
import type { DenSession } from "./den.ts";
import { connectedModelCatalog, createWorkspaceReadinessCache, projectWorkspaceReadiness, runtimeWorkspaceReadinessKey, workspacePreparationScope, type CoworkerActivity, type WorkspacePreparationScope } from "./threads.ts";
import { matchesModelSearch } from "./model-intelligence.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";
import {
  ONBOARDING_DRAFT_KEY,
  clearOnboardingDraft,
  completeOnboardingDraft,
  onboardingStepFor,
  draftsToCreate,
  emptyOnboardingDraft,
  loadOnboardingDraft,
  removeDraft,
  renameDraft,
  resumeOnboardingDraft,
  saveOnboardingDraft,
  type OnboardingDraft,
} from "./onboarding-team.ts";

const CATALOG: TeamRole[] = [
  { id: "research", defaultName: "Scout", role: "Research and synthesis", pitch: "Digging in", mission: "I dig.", avatarColor: "blue", avatarGlasses: "round", personality: "curious" },
  { id: "writing", defaultName: "Editor", role: "Writing and content", pitch: "Drafts", mission: "I write.", avatarColor: "violet", avatarGlasses: "square", personality: "thoughtful" },
  { id: "operations", defaultName: "Ops", role: "Operations and scheduling", pitch: "Schedules", mission: "I schedule.", avatarColor: "mint", avatarGlasses: "round", personality: "meticulous" },
];

function draft(role: TeamRole, name = role.defaultName): TeamDraft {
  return { roleId: role.id, name, role: role.role, mission: role.mission, avatarColor: role.avatarColor, avatarGlasses: role.avatarGlasses, personality: role.personality };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("the draft survives a reload and a torn store, and clears when the team exists", () => {
  const storage = memoryStorage();
  assert.equal(loadOnboardingDraft(storage).drafts.length, 0, "nothing stored yet gives a fresh draft");
  const fresh = emptyOnboardingDraft();
  assert.match(fresh.draftId, /^draft_/);
  const saved = { ...fresh, intents: ["research"], drafts: [draft(CATALOG[0]!, "Nova")], createdSlugs: ["nova"] };
  saveOnboardingDraft(storage, saved);
  assert.deepEqual(loadOnboardingDraft(storage), saved);
  storage.data.set(ONBOARDING_DRAFT_KEY, "{not json");
  assert.notEqual(loadOnboardingDraft(storage).draftId, saved.draftId, "a torn store starts over rather than failing");
  storage.data.set(ONBOARDING_DRAFT_KEY, JSON.stringify({ draftId: "draft_x", drafts: [{ nope: true }, draft(CATALOG[1]!)], intents: ["writing", 3] }));
  const partial = loadOnboardingDraft(storage);
  assert.deepEqual(partial.drafts.map((item) => item.name), ["Editor"], "malformed drafts are dropped");
  assert.deepEqual(partial.intents, ["writing"]);
  clearOnboardingDraft(storage);
  assert.equal(storage.data.has(ONBOARDING_DRAFT_KEY), false);
  assert.equal(loadOnboardingDraft(null).drafts.length, 0, "no storage at all still works");
});

test("renaming refuses a collision and removal keeps at least one coworker", () => {
  const drafts = [draft(CATALOG[0]!), draft(CATALOG[1]!)];
  assert.deepEqual(renameDraft(drafts, 0, "editor", CATALOG).map((item) => item.name), ["Scout", "Editor"], "a taken name is refused");
  assert.deepEqual(removeDraft(drafts, 1).map((item) => item.name), ["Scout"]);
  assert.deepEqual(removeDraft([draft(CATALOG[0]!)], 0).map((item) => item.name), ["Scout"], "the last coworker stays");
});

test("a retry creates only what an earlier attempt did not", () => {
  const drafts = [draft(CATALOG[0]!, "Nova"), draft(CATALOG[1]!), draft(CATALOG[2]!)];
  assert.deepEqual(draftsToCreate(drafts, ["nova"], []).map((item) => item.name), ["Editor", "Ops"]);
  assert.deepEqual(draftsToCreate(drafts, [], ["editor"]).map((item) => item.name), ["Nova", "Ops"], "a coworker that already exists on disk is skipped too");
  assert.deepEqual(draftsToCreate(drafts, ["nova", "editor", "ops"], []), []);
});

function modelCatalog() {
  return connectedModelCatalog(fixtureCatalog({
    connected: ["openai", "anthropic"],
    all: [
      fixtureProvider({ id: "openai", name: "OpenAI", models: {
        "gpt-5.6-luna": { name: "GPT-5.6 Luna", capabilities: { reasoning: true }, variants: { low: {}, high: {} } },
        "gpt-6-astra": { name: "GPT-6 Astra", capabilities: { reasoning: true }, variants: { low: {}, high: {} } },
      } }),
      fixtureProvider({ id: "anthropic", name: "Anthropic", models: {
        "claude-sonnet": { name: "Claude Sonnet", capabilities: { reasoning: true }, variants: { low: {}, high: {} } },
      } }),
    ],
  }));
}

async function callbackSource(path: string, start: string, end: string): Promise<string> {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "the executable UI callback is present");
  return source.slice(from + start.length, to);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const ignore = () => {};

function runtimeFixture(): RuntimeInfo {
  return { appName: "Fixture", version: "test", serverUrl: "", ownerToken: "", coworkersDir: "/fixture", denBaseUrl: "", deepLinkScheme: "fixture", deepLinksRegistered: false, engineManaged: true, engineError: "", readinessKey: "runtime", workspaceReadinessRevisions: {} };
}

function coworkerFixture(slug: string): CoworkerSummary {
  return { slug, path: `/fixture/${slug}`, name: slug, role: "", mission: "", avatarColor: "blue", avatarGlasses: "round", personality: "neutral", roleId: "", suggestedBy: null, workspaceId: `ws_${slug}`, conversationThreadId: "", model: "openai/gpt-5.6-luna", modelVariant: "", modelChosenBy: "person", modelMode: "fixed", useAppModelDefaults: true, effortPreference: "balanced", automations: [], createdAt: "original" };
}

type ActivitySnapshots = Record<string, { scope: WorkspacePreparationScope; activity: CoworkerActivity }>;
type AppReadinessFixture = {
  sameRuntimeInfo: (current: RuntimeInfo | null, next: RuntimeInfo) => boolean;
  samePreparationScope: (current: WorkspacePreparationScope | null | undefined, captured: WorkspacePreparationScope) => boolean;
  activityForScope: (entry: ActivitySnapshots[string] | undefined, scope: WorkspacePreparationScope) => CoworkerActivity | null;
  reconcileActivitySnapshots: (current: ActivitySnapshots, runtime: RuntimeInfo, coworkers: CoworkerSummary[], session: DenSession | null) => ActivitySnapshots;
  mergeActivityReads: (current: ActivitySnapshots, reads: Array<{ slug: string; scope: WorkspacePreparationScope; activity: CoworkerActivity | null }>, currentScope: (slug: string) => WorkspacePreparationScope | null) => ActivitySnapshots;
  visibleCoworkerActivity: (scope: WorkspacePreparationScope, polled: CoworkerActivity | null, live: CoworkerActivity | null, cloud: CoworkerActivity | null, attention: CoworkerActivity | null) => CoworkerActivity;
};

async function appReadinessFixture(cache: ReturnType<typeof createWorkspaceReadinessCache>): Promise<AppReadinessFixture> {
  const source = await callbackSource("../App.tsx", "type ScopedCoworkerActivity = ", "\nclass DeferredView");
  const script = await transform(`(() => { type ScopedCoworkerActivity = ${source}; return { sameRuntimeInfo, samePreparationScope, activityForScope, reconcileActivitySnapshots, mergeActivityReads, visibleCoworkerActivity }; })()`, { loader: "ts", target: "es2022" });
  return runInNewContext(script.code, { runtimeWorkspaceReadinessKey, workspacePreparationScope, projectWorkspaceReadiness, workspaceReadinessCache: cache });
}

test("onboarding has no model step, finishes once, and an existing team never replays it", () => {
  const storage = memoryStorage();
  const fresh = { ...emptyOnboardingDraft(), contextKey: "local" };
  assert.equal(resumeOnboardingDraft(fresh, false), fresh, "a new person starts at the welcome");
  assert.equal(onboardingStepFor({ ...fresh, intents: ["research"] }), "intents", "chosen work leads straight to the team");
  const choosing: OnboardingDraft = { ...fresh, step: "intents", intents: ["research"] };
  assert.equal(resumeOnboardingDraft(choosing, true), choosing, "a person mid-way keeps their place");
  saveOnboardingDraft(storage, completeOnboardingDraft({ ...choosing, drafts: [draft(CATALOG[0]!)] }));
  const restored = loadOnboardingDraft(storage);
  assert.equal(onboardingStepFor(restored), "");
  assert.equal(restored.completed, true);
  assert.deepEqual(restored.drafts, []);
  assert.equal(resumeOnboardingDraft(fresh, true).completed, true, "coworkers that already exist stand for a finished onboarding");
});

test("a saved connection re-reads the catalog before settings hear about it, and a failed read is reported", async () => {
  const source = await callbackSource("../ui/local-providers.tsx", "  const changed = ", "\n  async function connect(");
  const script = await transform(`(() => { const changed = ${source}; return { changed, savedProvider }; })()`, { loader: "ts", target: "es2022" });
  const refresh = deferred<void>();
  const refreshed = deferred<void>();
  let catalogNotified = false;
  let catalogProviderId: string | undefined;
  let failRefresh = false;
  const callbacks: { changed: (providerId?: string) => Promise<void>; savedProvider: (line: string, providerId: string) => void } = runInNewContext(script.code, {
    useCallback: (callback: unknown) => callback,
    setAdding: ignore,
    setRowState: ignore,
    onModelsChanged: (providerId?: string) => { catalogProviderId = providerId; catalogNotified = true; refreshed.resolve(); },
    refresh: () => failRefresh ? Promise.reject(new Error("Catalog unavailable")) : refresh.promise,
  });
  callbacks.savedProvider("Key saved. Models not checked.", "openai");
  assert.equal(catalogNotified, false);
  refresh.resolve();
  await refreshed.promise;
  assert.equal(catalogNotified, true, "existing settings consumers refresh after the connection catalog is read");
  assert.equal(catalogProviderId, "openai");
  failRefresh = true;
  await assert.rejects(callbacks.changed("anthropic"), /Catalog unavailable/);
});

test("arriving coworkers finish onboarding unless the person is choosing a team of their own", async () => {
  const syncSource = await callbackSource("../App.tsx", "  useEffect(() => {\n    if (!bootReady", "\n  }, [bootReady, pushSession, runtime, session]);");
  const syncScript = await transform(`(() => { if (!bootReady${syncSource}\n})`, { loader: "ts", target: "es2022" });
  let pushes = 0;
  const syncContext = { bootReady: false, runtime: runtimeFixture(), session: { baseUrl: "", orgId: "fixture", token: "", userName: "", userEmail: "", orgName: "" }, pushedSessionKeyRef: { current: "" }, sessionKey: () => "fixture", pushSession: async () => { pushes += 1; } };
  const sync: () => void = runInNewContext(syncScript.code, syncContext);
  sync();
  assert.equal(pushes, 0, "runtime events cannot install templates before onboarding state is restored");
  syncContext.bootReady = true;
  sync();
  assert.equal(pushes, 1);
  const source = await callbackSource("../App.tsx", "  const receiveImportedTemplates = useCallback(", ", [refreshRuntime, updateOnboardingDraft]);");
  const script = await transform(`(${source})`, { loader: "ts", target: "es2022" });
  const storage = memoryStorage();
  const onboardingDraftRef: { current: OnboardingDraft } = { current: { ...emptyOnboardingDraft(), step: "intents", intents: ["research"], contextKey: "local" } };
  let ready = false;
  let selected = "";
  let team: Array<{ slug: string }> = [];
  const receive: (result: { created: Array<{ slug: string }> }) => void = runInNewContext(script.code, {
    onboardingDraftRef, onboardingStepFor, completeOnboardingDraft,
    setBots: (update: (current: typeof team) => typeof team) => { team = update(team); },
    setSelectedSlug: (update: (current: string) => string) => { selected = update(selected); },
    setOnboardingReady: (value: boolean) => { ready = value; }, setCreating: ignore,
    updateOnboardingDraft: (next: OnboardingDraft) => { onboardingDraftRef.current = next; saveOnboardingDraft(storage, next); },
    refreshRuntime: async () => {},
  });
  receive({ created: [{ slug: "assigned" }] });
  assert.equal(team.length, 1);
  assert.equal(selected, "assigned");
  assert.equal(ready, false, "a person choosing a team of their own keeps choosing");
  assert.equal(onboardingStepFor(onboardingDraftRef.current), "intents");
  onboardingDraftRef.current = { ...emptyOnboardingDraft(), step: "welcome", contextKey: "local" };
  receive({ created: [{ slug: "later-assigned" }] });
  assert.equal(team.length, 2);
  assert.equal(ready, true, "otherwise the person meets the coworkers that arrived");
  assert.equal(onboardingStepFor(loadOnboardingDraft(storage)), "");
  assert.equal(loadOnboardingDraft(storage).completed, true);
});

test("the picker runs token-wise gpt luna search against its actual catalog filter", async () => {
  const source = await callbackSource("../ui/model-picker.tsx", "  const visible = ", "\n  const groups = ");
  const script = await transform(source, { loader: "ts", target: "es2022" });
  const visible: ReturnType<typeof modelCatalog>["models"] = runInNewContext(script.code, { catalog: modelCatalog(), workerModel: false, query: "gpt luna", matchesModelSearch });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.modelId, "gpt-5.6-luna");
});

test("root runtime events and five-second polling preserve unrelated activity and fence older runtime snapshots", async () => {
  const cache = createWorkspaceReadinessCache();
  const helpers = await appReadinessFixture(cache);
  const first = coworkerFixture("first"), second = coworkerFixture("second");
  const original = runtimeFixture();
  const runtimeRef: { current: RuntimeInfo | null } = { current: original };
  const sessionRef: { current: DenSession | null } = { current: null };
  const runtimeObservation = { current: 0 };
  const firstScope = workspacePreparationScope(original, first, null);
  const secondScope = workspacePreparationScope(original, second, null);
  const ready: CoworkerActivity = { state: "ready", label: "Ready", detail: "", updatedAt: 0 };
  const working: CoworkerActivity = { state: "working", label: "Working", detail: "Accepted task", updatedAt: 1 };
  const state: Record<"polled" | "live" | "attention" | "cloud", ActivitySnapshots> = {
    polled: { first: { scope: firstScope, activity: ready }, second: { scope: secondScope, activity: ready } },
    live: { first: { scope: firstScope, activity: working }, second: { scope: secondScope, activity: ready } }, attention: {}, cloud: {},
  };
  const setter = (key: keyof typeof state) => (update: (current: ActivitySnapshots) => ActivitySnapshots) => { state[key] = update(state[key]); };
  const reconcileSource = await callbackSource("../App.tsx", "  const reconcileActivities = useCallback(", ", []);");
  const reconcileScript = await transform(`(${reconcileSource})`, { loader: "ts", target: "es2022" });
  const reconcileActivities: (info: RuntimeInfo) => void = runInNewContext(reconcileScript.code, {
    reconcileActivitySnapshots: helpers.reconcileActivitySnapshots, coworkersRef: { current: [first, second] }, sessionRef,
    setActivityBySlug: setter("polled"), setLiveActivityBySlug: setter("live"), setAttentionBySlug: setter("attention"), setCloudRunBySlug: setter("cloud"),
  });
  let publications = 0;
  const applySource = await callbackSource("../App.tsx", "  const applyRuntime = useCallback(", ", [reconcileActivities]);");
  const applyScript = await transform(`(${applySource})`, { loader: "ts", target: "es2022" });
  const applyRuntime: (info: RuntimeInfo, expected?: RuntimeInfo, workspaceId?: string, expectedSession?: DenSession | null) => boolean = runInNewContext(applyScript.code, {
    runtimeRef, runtimeObservation, sessionRef, reconcileActivities, sameRuntimeInfo: helpers.sameRuntimeInfo, runtimeWorkspaceReadinessKey, setRuntime: () => { publications += 1; },
  });
  const eventRef: { current: ((info: RuntimeInfo) => void) | null } = { current: null };
  const eventSource = await callbackSource("../App.tsx", "  useEffect(() => {\n    void boot();", "\n  }, [applyRuntime, boot]);");
  const eventScript = await transform(`(() => { void boot(); ${eventSource}\n})`, { loader: "ts", target: "es2022" });
  const register: () => () => void = runInNewContext(eventScript.code, { boot: async () => {}, applyRuntime, coworkerBridge: { onRuntimeChanged: (listener: (info: RuntimeInfo) => void) => { eventRef.current = listener; return ignore; } } });
  const unlisten = register();
  const pollRef: { current: (() => Promise<void>) | null } = { current: null };
  let response = deferred<RuntimeInfo>();
  const pollSource = await callbackSource("../App.tsx", "  useEffect(() => {\n    if (!runtime) return;\n    let reading = false;", "\n  }, [applyRuntime, runtime?.serverUrl]);");
  const pollScript = await transform(`(() => { if (!runtime) return; let reading = false; ${pollSource}\n})`, { loader: "ts", target: "es2022" });
  const startPolling: () => () => void = runInNewContext(pollScript.code, {
    runtime: original, runtimeObservation, applyRuntime, coworkerBridge: { runtimeInfo: () => response.promise },
    window: { setInterval: (callback: () => Promise<void>, delay: number) => { assert.equal(delay, 5_000); pollRef.current = callback; return 1; }, clearInterval: ignore },
  });
  const stopPolling = startPolling();
  try {
    await cache.get(firstScope, async () => {}).wait();
    await cache.get(secondScope, async () => {}).wait();
    assert.ok(eventRef.current && pollRef.current);
    const unchangedPolled = state.polled, unchangedLive = state.live;
    eventRef.current({ ...original, workspaceReadinessRevisions: { ws_first: 0 } });
    assert.equal(publications, 0);
    assert.equal(state.polled, unchangedPolled);
    assert.equal(state.live, unchangedLive);
    const changed = { ...original, workspaceReadinessRevisions: { ws_first: 1 } };
    eventRef.current(changed);
    assert.equal(publications, 1);
    assert.equal(state.polled.second, unchangedPolled.second);
    assert.equal(state.live.second, unchangedLive.second);
    assert.equal(state.polled.first?.activity.label, "Available");
    assert.equal(state.live.first?.activity, working, "real work is not cleared by next-turn configuration changes");
    const currentFirst = workspacePreparationScope(changed, first, null);
    assert.equal(helpers.visibleCoworkerActivity(currentFirst, ready, null, null, null).label, "Available", "old Ready text is not current proof");
    assert.equal(helpers.visibleCoworkerActivity(secondScope, ready, null, null, null).label, "Ready");
    const waiting: CoworkerActivity = { ...working, state: "attention", label: "Needs you" };
    const starting: CoworkerActivity = { ...ready, state: "starting", label: "Starting AI" };
    assert.equal(helpers.visibleCoworkerActivity(currentFirst, waiting, starting, null, null).state, "attention");
    assert.equal(helpers.visibleCoworkerActivity(currentFirst, working, starting, null, null).state, "working");
    assert.equal(helpers.visibleCoworkerActivity(secondScope, { ...ready, state: "offline", label: "Not responding" }, ready, null, null).state, "offline");

    const next = { ...changed, workspaceReadinessRevisions: { ws_first: 1, ws_second: 1 } };
    const pendingPoll = pollRef.current();
    response.resolve(next);
    await pendingPoll;
    assert.equal(runtimeRef.current, next);
    assert.equal(publications, 2);
    assert.equal(state.polled.second?.activity.label, "Available");
    response = deferred();
    const stalePoll = pollRef.current();
    const newest = { ...next, workspaceReadinessRevisions: { ws_first: 2, ws_second: 1 } };
    eventRef.current(newest);
    response.resolve(changed);
    await stalePoll;
    assert.equal(runtimeRef.current, newest, "a late poll cannot undo an event's scoped revision");
    assert.equal(applyRuntime(changed, changed, "coordinator", null), true);
    assert.equal(runtimeRef.current, newest, "an unrelated newer revision survives the onboarding callback");
    assert.equal(applyRuntime(changed, changed, first.workspaceId, null), false);
    sessionRef.current = { baseUrl: "", orgId: "another", token: "", userName: "", userEmail: "", orgName: "" };
    assert.equal(applyRuntime(newest, newest, "coordinator", null), false, "a former account's callback cannot publish runtime state");
    assert.equal(helpers.activityForScope(state.live.first, workspacePreparationScope(newest, first, sessionRef.current)), null);
  } finally { unlisten(); stopPolling(); cache.dispose(); }
});

test("sidebar reads bind preparation scope, keep independent reads alive, and reject late identity or configuration results", async () => {
  const cache = createWorkspaceReadinessCache();
  const helpers = await appReadinessFixture(cache);
  const first = coworkerFixture("first"), second = coworkerFixture("second");
  const runtimeRef = { current: runtimeFixture() };
  const coworkersRef = { current: [first, second] };
  const sessionRef: { current: DenSession | null } = { current: null };
  const currentPreparationScope = (slug: string) => {
    const owner = coworkersRef.current.find((coworker) => coworker.slug === slug);
    return owner ? workspacePreparationScope(runtimeRef.current, owner, sessionRef.current) : null;
  };
  const requests: Array<{ workspaceId: string; scope: WorkspacePreparationScope; response: ReturnType<typeof deferred<CoworkerActivity>> }> = [];
  let started = deferred<void>();
  let committed = deferred<void>();
  const activityRefreshRef = { current: ignore };
  const state: { current: ActivitySnapshots } = { current: {} };
  const source = await callbackSource("../App.tsx", "  useEffect(() => {\n    if (!activityEnabled) return;", "\n  }, [activityEnabled, currentPreparationScope]);");
  const script = await transform(`(() => { if (!activityEnabled) return; ${source}\n})`, { loader: "ts", target: "es2022" });
  const start: () => () => void = runInNewContext(script.code, {
    activityEnabled: true, runtimeRef, coworkersRef, sessionRef, currentPreparationScope, activityRefreshRef,
    activityReadingRef: { current: new Map<string, WorkspacePreparationScope>() }, workspacePreparationScope,
    samePreparationScope: helpers.samePreparationScope, mergeActivityReads: helpers.mergeActivityReads,
    coworkerBridge: { workers: { list: async () => [] }, localResponsibilities: { list: async () => [] } },
    readCoworkerActivity: (options: { workspaceId: string; preparationScope: WorkspacePreparationScope }) => {
      const response = deferred<CoworkerActivity>();
      requests.push({ workspaceId: options.workspaceId, scope: options.preparationScope, response });
      started.resolve();
      return response.promise;
    },
    setActivityBySlug: (update: (current: ActivitySnapshots) => ActivitySnapshots) => { state.current = update(state.current); committed.resolve(); },
    window: { setInterval: (_callback: () => void, delay: number) => { assert.equal(delay, 4_000); return 1; }, clearInterval: ignore },
  });
  const stop = start();
  try {
    await started.promise;
    const oldFirst = requests.find((request) => request.workspaceId === first.workspaceId);
    const other = requests.find((request) => request.workspaceId === second.workspaceId);
    assert.ok(oldFirst && other);
    assert.equal(helpers.samePreparationScope(currentPreparationScope(first.slug), oldFirst.scope), true);
    runtimeRef.current = { ...runtimeRef.current, workspaceReadinessRevisions: { [first.workspaceId]: 1 } };
    started = deferred();
    activityRefreshRef.current();
    await started.promise;
    assert.equal(requests.length, 3, "an unrelated in-flight read is not cancelled or duplicated");
    const updatedFirst = requests[2];
    assert.ok(updatedFirst);
    const ready: CoworkerActivity = { state: "ready", label: "Ready", detail: "", updatedAt: 0 };
    const working: CoworkerActivity = { state: "working", label: "Working", detail: "Current work", updatedAt: 1 };
    other.response.resolve(working);
    await committed.promise;
    assert.equal(state.current.second?.activity.state, "working");
    assert.equal(state.current.second?.activity.detail, working.detail);
    committed = deferred();
    updatedFirst.response.resolve(working);
    await committed.promise;
    const accepted = state.current.first;
    oldFirst.response.resolve(ready);
    await oldFirst.response.promise;
    await Promise.resolve();
    assert.equal(state.current.first, accepted, "the old workspace revision cannot replace its newer observation");

    const captured = updatedFirst.scope;
    const variants: WorkspacePreparationScope[] = [
      workspacePreparationScope({ ...runtimeRef.current, readinessKey: "replacement-runtime" }, first, null),
      workspacePreparationScope(runtimeRef.current, { ...first, createdAt: "replacement" }, null),
      workspacePreparationScope(runtimeRef.current, { ...first, effortPreference: "light" }, null),
    ];
    for (const scope of variants) {
      assert.equal(helpers.mergeActivityReads(state.current, [{ slug: first.slug, scope: captured, activity: ready }], () => scope), state.current);
      assert.equal(helpers.mergeActivityReads(state.current, [{ slug: first.slug, scope: captured, activity: null }], () => scope), state.current, "old unmount callbacks cannot clear a new scope");
    }
    coworkersRef.current = [{ ...first, createdAt: "replacement" }, second];
    const replacement = currentPreparationScope(first.slug);
    assert.ok(replacement);
    assert.equal(helpers.activityForScope(accepted, replacement), null);
    const retained = helpers.reconcileActivitySnapshots(state.current, runtimeRef.current, coworkersRef.current, null);
    assert.equal(retained.first, undefined);
    assert.equal(retained.second, state.current.second);
    const empty: ActivitySnapshots = {};
    const missing = coworkerFixture("constructor");
    assert.equal(helpers.reconcileActivitySnapshots(empty, runtimeRef.current, [missing], null), empty);
    assert.equal(helpers.activityForScope(empty[missing.slug], replacement), null);
  } finally { stop(); cache.dispose(); }
});

test("an unavailable starting model is persisted exactly, never dropped after retries or replaced by a catalog recommendation", async () => {
  const source = await callbackSource("../ui/coworker-home.tsx", "  useEffect(() => {\n    if (coworker.model) {", "\n  }, [coworker.model, coworker.slug, coworker.workspaceId,");
  const script = await transform(`(() => { if (coworker.model) {${source}\n})`, { loader: "ts", target: "es2022" });
  const wanted = "unavailable/explicit";
  let pending = wanted;
  let error = "";
  let attempts = 0;
  const coworker = { slug: "fixture", workspaceId: "workspace", createdAt: "original", model: "" };
  const startingModelWrite: { current: Promise<typeof coworker> | null } = { current: null };
  let changed: typeof coworker | undefined;
  let settled = deferred<void>();
  const effect: () => () => void = runInNewContext(script.code, {
    coworker, runtime: { engineManaged: true }, startingModel: wanted, startingModelWrite,
    peekStartingModel: () => pending, takeStartingModel: () => { const previous = pending; pending = ""; return previous; },
    setStartingModel: ignore, setStartingModelError: (value: string) => { error = value; if (value) settled.resolve(); },
    onCoworkerChangedRef: { current: (updated: typeof coworker) => { changed = updated; settled.resolve(); } },
    coworkerBridge: { coworkers: { update: async (slug: string, patch: { model: string; modelVariant: string; modelChosenBy: string }) => {
      attempts += 1;
      assert.equal(slug, coworker.slug);
      assert.equal(patch.model, wanted);
      assert.equal(patch.modelChosenBy, "person");
      if (attempts <= 8) throw new Error("Save unavailable");
      return { ...coworker, ...patch };
    } } },
    createCoworkerThreads: () => { assert.fail("an explicit starting model does not depend on catalog availability"); },
    recommendModel: () => { assert.fail("an explicit starting model is never replaced automatically"); },
    window: { setTimeout: () => { assert.fail("a failed explicit choice waits for the person's retry"); }, clearTimeout: ignore },
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    settled = deferred();
    const cleanup = effect();
    await settled.promise;
    assert.equal(pending, wanted);
    assert.match(error, /starting model is kept/);
    cleanup();
  }
  settled = deferred();
  const cleanup = effect();
  await settled.promise;
  assert.equal(attempts, 9);
  assert.equal(pending, "");
  assert.equal(changed?.model, wanted);
  cleanup();
});
