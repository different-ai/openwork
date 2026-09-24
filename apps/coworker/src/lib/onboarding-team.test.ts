import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import type { CoworkerSummary, RuntimeInfo, TeamDraft, TeamRole } from "./bridge.ts";
import type { DenSession } from "./den.ts";
import { DEFAULT_MODEL_DEFAULTS, normalizeModelDefaults, type ModelDefaults } from "./model-defaults.ts";
import { connectedModelCatalog, createWorkspaceReadinessCache, projectWorkspaceReadiness, runtimeWorkspaceReadinessKey, workspacePreparationScope, type CoworkerActivity, type WorkspacePreparationScope } from "./threads.ts";
import { matchesModelSearch } from "./model-intelligence.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";
import {
  ONBOARDING_DRAFT_KEY,
  clearOnboardingDraft,
  chooseOnboardingModel,
  completeOnboardingDraft,
  connectOnboardingProvider,
  onboardingDraftForContext,
  onboardingModelReview,
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

test("model review preserves exact role choices, Automatic, and BYOK scope across reloads and missing catalogs", () => {
  const storage = memoryStorage();
  const catalog = modelCatalog();
  const settings = normalizeModelDefaults({ conversation: { model: "unavailable/exact", modelVariant: "unoffered" } });
  let current: OnboardingDraft = { ...emptyOnboardingDraft(), contextKey: "local", step: "models", intents: ["research"], drafts: [draft(CATALOG[0]!)] };
  current = connectOnboardingProvider(current, "openai");
  const initial = onboardingModelReview(current, catalog, settings);
  assert.deepEqual(initial.defaults.conversation, settings.conversation);
  assert.equal(initial.previews.conversation.state, "unavailable");
  for (const choice of [initial.defaults.thinking, initial.defaults.delivery, initial.defaults.facilitator]) assert.equal(choice.model, "openai/gpt-5.6-luna");
  assert.equal(current.modelChoices, undefined, "recommendations do not save choices before review");

  current = chooseOnboardingModel(current, "delivery", { model: "anthropic/claude-sonnet", modelVariant: "unoffered" });
  current = chooseOnboardingModel(current, "thinking", { model: "", modelVariant: "high" });
  saveOnboardingDraft(storage, current);
  assert.deepEqual(loadOnboardingDraft(storage), current);
  const unavailable = onboardingModelReview(loadOnboardingDraft(storage), { models: [] }, settings);
  assert.deepEqual(unavailable.defaults.conversation, settings.conversation);
  assert.deepEqual(unavailable.defaults.delivery, current.modelChoices?.delivery);
  assert.deepEqual(unavailable.defaults.thinking, { model: "", modelVariant: "high" });
  assert.equal(unavailable.previews.delivery.state, "unavailable");

  const reconnected = connectOnboardingProvider(loadOnboardingDraft(storage), "anthropic");
  const reviewed = onboardingModelReview(reconnected, catalog, settings);
  assert.deepEqual(reviewed.defaults.conversation, settings.conversation);
  assert.deepEqual(reviewed.defaults.delivery, current.modelChoices?.delivery);
  assert.deepEqual(reviewed.defaults.thinking, { model: "", modelVariant: "high" }, "choosing Automatic stays editable rather than being re-pinned");
  assert.equal(reviewed.defaults.facilitator.model, "anthropic/claude-sonnet");
  const accepted: OnboardingDraft = { ...reconnected, modelChoices: reviewed.defaults, modelsReviewed: true, step: "team" };
  saveOnboardingDraft(storage, accepted);
  assert.equal(onboardingStepFor(loadOnboardingDraft(storage)), "team");
  assert.deepEqual(onboardingModelReview(connectOnboardingProvider(loadOnboardingDraft(storage), "openai"), catalog, DEFAULT_MODEL_DEFAULTS).defaults, reviewed.defaults);
  assert.deepEqual(settings.conversation, { model: "unavailable/exact", modelVariant: "unoffered" });
  assert.equal(onboardingStepFor({ ...accepted, modelsReviewed: false }), "models");
  assert.deepEqual(onboardingDraftForContext(accepted, "account-one").modelChoices, accepted.modelChoices, "local choices survive connecting Cloud");
  const otherAccount = onboardingDraftForContext({ ...accepted, contextKey: "account-one" }, "account-two");
  assert.equal(otherAccount.modelChoices, undefined);
  assert.equal(otherAccount.providerId, undefined);
  assert.deepEqual(otherAccount.drafts, [], "an old account's draft does not cross the context boundary");
});

test("completed and existing explicit setups do not replay role review, but an active connection still must", () => {
  const storage = memoryStorage();
  const fresh = { ...emptyOnboardingDraft(), contextKey: "local" };
  assert.equal(resumeOnboardingDraft(fresh, false, DEFAULT_MODEL_DEFAULTS), fresh);
  assert.equal(resumeOnboardingDraft(fresh, false, normalizeModelDefaults({ conversation: { model: "openai/gpt-5.6-luna" } })), fresh);
  const defaults = onboardingModelReview(connectOnboardingProvider(fresh, "openai"), modelCatalog(), DEFAULT_MODEL_DEFAULTS).defaults;
  const existing = resumeOnboardingDraft(fresh, false, defaults);
  assert.equal(existing.modelsReviewed, true);
  assert.equal(onboardingStepFor(existing), "");
  const pending: OnboardingDraft = { ...fresh, step: "models" };
  assert.equal(resumeOnboardingDraft(pending, true, defaults), pending, "assigned coworkers cannot stand in for reviewing this connection");
  const finished = completeOnboardingDraft({ ...pending, modelChoices: defaults, drafts: [draft(CATALOG[0]!)] });
  saveOnboardingDraft(storage, finished);
  const restored = loadOnboardingDraft(storage);
  assert.equal(onboardingStepFor(restored), "");
  assert.equal(restored.modelsReviewed, true);
  assert.deepEqual(restored.drafts, []);
  assert.equal(restored.modelChoices, undefined, "later Settings edits are not overwritten by an old completed draft");
  assert.equal(resumeOnboardingDraft(restored, true, DEFAULT_MODEL_DEFAULTS), restored);
  const reviewed: OnboardingDraft = { ...pending, step: "intents", providerId: "openai", modelsReviewed: true };
  assert.equal(connectOnboardingProvider(reviewed, "openai"), reviewed, "a duplicate connection notification does not reopen review");
});

test("the BYOK saved callback records its provider before a delayed or failed catalog refresh", async () => {
  const source = await callbackSource("../ui/local-providers.tsx", "  const changed = ", "\n  async function connect(");
  const script = await transform(`(() => { const changed = ${source}; return { changed, savedProvider }; })()`, { loader: "ts", target: "es2022" });
  const storage = memoryStorage();
  let current: OnboardingDraft = { ...emptyOnboardingDraft(), step: "local" };
  const refresh = deferred<void>();
  const refreshed = deferred<void>();
  let catalogNotified = false;
  let catalogProviderId: string | undefined;
  let failRefresh = false;
  const callbacks: { changed: (providerId?: string) => Promise<void>; savedProvider: (line: string, providerId: string) => void } = runInNewContext(script.code, {
    useCallback: (callback: unknown) => callback,
    setAdding: ignore,
    setRowState: ignore,
    onProviderConnected: (providerId: string) => { current = connectOnboardingProvider(current, providerId); saveOnboardingDraft(storage, current); },
    onModelsChanged: (providerId?: string) => { catalogProviderId = providerId; catalogNotified = true; refreshed.resolve(); },
    refresh: () => failRefresh ? Promise.reject(new Error("Catalog unavailable")) : refresh.promise,
  });
  callbacks.savedProvider("Key saved. Models not checked.", "openai");
  assert.equal(loadOnboardingDraft(storage).providerId, "openai");
  assert.equal(catalogNotified, false);
  refresh.resolve();
  await refreshed.promise;
  assert.equal(catalogNotified, true, "existing settings consumers refresh after the connection catalog is read");
  assert.equal(catalogProviderId, "openai");
  failRefresh = true;
  await assert.rejects(callbacks.changed("anthropic"), /Catalog unavailable/);
  assert.equal(loadOnboardingDraft(storage).providerId, "anthropic");
});

test("model review uses the coordinator catalog and keeps valid state through failed and superseded reads", async () => {
  const source = await callbackSource("../ui/app-model-defaults.tsx", "  const refresh = useCallback(", ", [draft.contextKey, draft.providerId, onRuntimeChanged, onSyncProviders, scope, session]);");
  const script = await transform(`(${source})`, { loader: "ts", target: "es2022" });
  const scopeSource = await callbackSource("../ui/app-model-defaults.tsx", "function onboardingCatalogScope", "\n\nexport function OnboardingModelDefaults");
  const scopeScript = await transform(`(function onboardingCatalogScope${scopeSource})`, { loader: "ts", target: "es2022" });
  const catalogScope: (runtime: RuntimeInfo, session: DenSession | null, draft: Pick<OnboardingDraft, "contextKey" | "providerId">, workspaceId: string) => string = runInNewContext(scopeScript.code, { runtimeWorkspaceReadinessKey });
  const info = runtimeFixture();
  const catalog = modelCatalog();
  const defaults = normalizeModelDefaults({ conversation: { model: "unavailable/exact", modelVariant: "high" } });
  type Snapshot = { scope: string; workspaceId: string; defaults: ModelDefaults; catalog: typeof catalog | null; checkedAt?: number };
  const snapshot: { current: Snapshot | null } = { current: null };
  const scope = catalogScope(info, null, { contextKey: "local" }, "");
  const scopeRef = { current: scope };
  const calls: string[] = [];
  let reading = deferred<typeof catalog>();
  let readStarted = deferred<void>();
  let error = "";
  const sandbox = {
    generation: { current: 0 }, scopeRef, scope, session: null, draft: { contextKey: "local" },
    mounted: { current: true }, runtimeSnapshotRef: { current: info }, onboardingCatalogScope: catalogScope,
    snapshotRef: snapshot, pendingReads: { current: 0 }, catalogRead: { current: null }, AbortController, AbortSignal, PENDING_CATALOG_READ_TIMEOUT_MS: 10_000,
    setLoading: ignore, setReadError: (value: string) => { error = value; },
    setSnapshot: (next: Snapshot | ((previous: Snapshot | null) => Snapshot)) => { snapshot.current = typeof next === "function" ? next(snapshot.current) : next; },
    onSyncProviders: () => { assert.fail("initial review reads a catalog, not a provider probe"); },
    onRuntimeChanged: (runtime: RuntimeInfo, expected: RuntimeInfo, workspaceId: string, account: DenSession | null) => {
      assert.equal(runtime, info);
      assert.equal(expected, info);
      assert.equal(workspaceId, "coordinator");
      assert.equal(account, null);
      return true;
    },
    coworkerBridge: {
      coordinator: { ensure: async () => { calls.push("coordinator"); return { workspaceId: "coordinator" }; } },
      settings: { get: async () => { calls.push("settings"); return { modelDefaults: defaults }; } },
      runtimeInfo: async () => info,
    },
    createCoworkerThreads: (input: { workspaceId: string }) => {
      assert.equal(input.workspaceId, "coordinator");
      return { listModelCatalog: () => { calls.push("catalog"); readStarted.resolve(); return reading.promise; } };
    },
  };
  const refresh: () => Promise<void> = runInNewContext(script.code, sandbox);
  const initial = refresh();
  await readStarted.promise;
  assert.deepEqual(snapshot.current?.defaults, defaults, "saved IDs and efforts are visible while the catalog is delayed");
  reading.resolve(catalog);
  await initial;
  assert.deepEqual(calls, ["coordinator", "settings", "catalog"]);
  assert.equal(snapshot.current?.catalog, catalog);
  assert.deepEqual(snapshot.current?.defaults, defaults);
  assert.equal(snapshot.current?.scope, catalogScope(info, null, sandbox.draft, "coordinator"));
  sandbox.scope = scopeRef.current = catalogScope(info, null, sandbox.draft, "coordinator");
  const unrelated = { ...info, workspaceReadinessRevisions: { another: 1 } };
  assert.equal(catalogScope(unrelated, null, sandbox.draft, "coordinator"), sandbox.scope);
  assert.notEqual(catalogScope({ ...info, workspaceReadinessRevisions: { coordinator: 1 } }, null, sandbox.draft, "coordinator"), sandbox.scope);

  reading = deferred();
  readStarted = deferred();
  const failed = refresh();
  await readStarted.promise;
  reading.reject(new Error("Catalog unavailable"));
  await failed;
  assert.match(error, /choices are kept/);
  assert.equal(snapshot.current?.catalog, catalog);
  assert.deepEqual(snapshot.current?.defaults, defaults);

  reading = deferred();
  readStarted = deferred();
  const superseded = refresh();
  await readStarted.promise;
  scopeRef.current = "different-account";
  reading.resolve({ ...catalog, models: [] });
  await superseded;
  assert.notEqual(snapshot.current?.scope, scopeRef.current);
  assert.equal(snapshot.current?.catalog, catalog, "a late result cannot replace the last valid view in another context");
});

test("pending catalogs converge through bounded read-only checks and stop on completion, error, or unmount", async () => {
  const refreshSource = await callbackSource("../ui/app-model-defaults.tsx", "  const refresh = useCallback(", ", [draft.contextKey, draft.providerId, onRuntimeChanged, onSyncProviders, scope, session]);");
  const refreshScript = await transform(`(${refreshSource})`, { loader: "ts", target: "es2022" });
  const scopeSource = await callbackSource("../ui/app-model-defaults.tsx", "function onboardingCatalogScope", "\n\nexport function OnboardingModelDefaults");
  const scopeScript = await transform(`(function onboardingCatalogScope${scopeSource})`, { loader: "ts", target: "es2022" });
  const catalogScope: (runtime: RuntimeInfo, session: DenSession | null, draft: Pick<OnboardingDraft, "contextKey" | "providerId">, workspaceId: string) => string = runInNewContext(scopeScript.code, { runtimeWorkspaceReadinessKey });
  const info = runtimeFixture();
  const session: DenSession = { baseUrl: "", orgId: "fixture", token: "", userName: "", userEmail: "", orgName: "" };
  const draft: OnboardingDraft = { ...emptyOnboardingDraft(), contextKey: "fixture", providerId: "openai", step: "models" };
  const defaults = onboardingModelReview(draft, modelCatalog(), DEFAULT_MODEL_DEFAULTS).defaults;
  const waiting = { ...modelCatalog(), cloud: { hasSession: true, lastRun: null, providers: [], skippedProviders: [], reloadPending: true } };
  const settled = { ...waiting, cloud: { ...waiting.cloud, reloadPending: false } };
  const scope = catalogScope(info, session, draft, "coordinator");
  const snapshot = { current: { scope, workspaceId: "coordinator", defaults, catalog: waiting, checkedAt: 1 } };
  const pendingReads = { current: 0 };
  const mounted = { current: true };
  const catalogRead: { current: AbortController | null } = { current: null };
  const generation = { current: 0 };
  const deadlines: AbortController[] = [];
  let result: ReturnType<typeof modelCatalog> = waiting;
  let error = "", reads = 0;
  let heldRuntime: ReturnType<typeof deferred<RuntimeInfo>> | null = null;
  const refresh: (options?: { sync?: boolean; observe?: boolean }) => Promise<void> = runInNewContext(refreshScript.code, {
    snapshotRef: snapshot, pendingReads, catalogRead, generation, mounted, scope, scopeRef: { current: scope },
    runtimeSnapshotRef: { current: info }, draft, session, onboardingCatalogScope: catalogScope,
    AbortController, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: (ms: number) => { assert.equal(ms, 10_000); const controller = new AbortController(); deadlines.push(controller); return controller.signal; } },
    PENDING_CATALOG_READ_TIMEOUT_MS: 10_000, setLoading: ignore, setReadError: (message: string) => { error = message; },
    setSnapshot: (next: typeof snapshot.current) => { snapshot.current = next; },
    onRuntimeChanged: () => true,
    onSyncProviders: () => { assert.fail("automatic observations must not sync providers"); },
    coworkerBridge: {
      coordinator: { ensure: () => { assert.fail("automatic observations reuse the existing coordinator"); } },
      settings: { get: () => { assert.fail("automatic observations reuse saved defaults"); }, update: () => { assert.fail("automatic observations never save choices"); } },
      runtimeInfo: () => heldRuntime ? heldRuntime.promise : Promise.resolve(info),
    },
    createCoworkerThreads: (options: { workspaceId: string }) => {
      assert.equal(options.workspaceId, "coordinator");
      return { listModelCatalog: async (signal: AbortSignal) => { assert.equal(signal.aborted, false); reads += 1; return result; } };
    },
  });
  const observerSource = await callbackSource("../ui/app-model-defaults.tsx", "  useEffect(() => {\n    if (current?.catalog && !pending)", "\n  }, [current?.catalog, pending, loading, saving, readError, refresh]);");
  const observerScript = await transform(`(() => { if (current?.catalog && !pending)${observerSource}\n})`, { loader: "ts", target: "es2022" });
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const running: { current: Promise<void> | null } = { current: null };
  const observerContext = {
    current: snapshot.current, pending: true, loading: false, saving: false, readError: "", pendingReads,
    PENDING_CATALOG_READ_LIMIT: 5, PENDING_CATALOG_RECHECK_MS: 2_000,
    refresh: (options: { observe?: boolean; sync?: boolean }) => { assert.deepEqual(Object.keys(options), ["observe"]); running.current = refresh(options); return running.current; },
    window: { setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 2_000); timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); } },
  };
  const observe: () => (() => void) | undefined = runInNewContext(observerScript.code, observerContext);
  const schedule = () => {
    observerContext.current = snapshot.current;
    observerContext.pending = snapshot.current.catalog.cloud.reloadPending;
    observerContext.readError = error;
    return observe();
  };
  const tick = () => {
    const timer = timers.entries().next().value;
    assert.ok(timer);
    timers.delete(timer[0]);
    timer[1]();
    assert.ok(running.current);
    return running.current;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cleanup = schedule();
    result = attempt === 2 ? settled : waiting;
    await tick();
    cleanup?.();
  }
  assert.equal(reads, 3);
  assert.equal(snapshot.current.catalog.cloud.reloadPending, false);
  assert.equal(snapshot.current.defaults, defaults);
  schedule();
  assert.equal(timers.size, 0);
  assert.equal(pendingReads.current, 0);

  snapshot.current = { ...snapshot.current, catalog: waiting };
  result = waiting;
  const cancelledTimer = schedule();
  assert.equal(timers.size, 1);
  cancelledTimer?.();
  assert.equal(timers.size, 0);
  for (let attempt = 0; attempt < 5; attempt += 1) { const cleanup = schedule(); await tick(); cleanup?.(); }
  schedule();
  assert.equal(timers.size, 0);
  assert.equal(reads, 8, "the observer stops after five reads even if the backend remains pending");

  snapshot.current = { ...snapshot.current, catalog: settled };
  schedule();
  snapshot.current = { ...snapshot.current, catalog: waiting };
  result = { ...waiting, cloud: null };
  const failedCheck = schedule();
  await tick();
  failedCheck?.();
  assert.equal(snapshot.current.catalog.cloud.reloadPending, true, "an absent status is not confirmed completion");
  assert.match(error, /status is unverified/);
  schedule();
  assert.equal(timers.size, 0);

  error = "";
  heldRuntime = deferred();
  const timedRead = refresh({ observe: true });
  deadlines.at(-1)?.abort(new Error("Read deadline reached"));
  await timedRead;
  assert.match(error, /Read deadline reached/);
  heldRuntime.resolve(info);
  heldRuntime = deferred();
  const cancelledRead = refresh({ observe: true });
  const beforeUnmount = snapshot.current;
  const lifecycleSource = await callbackSource("../ui/app-model-defaults.tsx", "  useEffect(() => {\n    if (!current?.catalog) void refresh();", "\n  }, [refresh]);");
  const lifecycleScript = await transform(`(() => { ${lifecycleSource}\n})`, { loader: "ts", target: "es2022" });
  const lifecycle: () => () => void = runInNewContext(lifecycleScript.code, { generation, catalogRead });
  const unmount = lifecycle();
  mounted.current = false;
  unmount();
  await cancelledRead;
  heldRuntime.resolve(info);
  assert.equal(snapshot.current, beforeUnmount);
  assert.equal(timers.size, 0);
});

test("assigned templates cannot skip an in-progress model review", async () => {
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
  const onboardingDraftRef: { current: OnboardingDraft } = { current: { ...emptyOnboardingDraft(), step: "models", contextKey: "local" } };
  let ready = false;
  let selected = "";
  let team: Array<{ slug: string }> = [];
  const receive: (result: { created: Array<{ slug: string }> }) => void = runInNewContext(script.code, {
    onboardingDraftRef, onboardingStepFor, onboardingDraftForContext,
    onboardingContext: () => "local", sessionRef: { current: null }, coworkersRef: { current: [] },
    setBots: (update: (current: typeof team) => typeof team) => { team = update(team); },
    setSelectedSlug: (update: (current: string) => string) => { selected = update(selected); },
    setOnboardingReady: (value: boolean) => { ready = value; }, setCreating: ignore,
    updateOnboardingDraft: (next: OnboardingDraft) => { onboardingDraftRef.current = next; saveOnboardingDraft(storage, next); },
    refreshRuntime: async () => {},
  });
  receive({ created: [{ slug: "assigned" }] });
  assert.equal(team.length, 1);
  assert.equal(selected, "assigned");
  assert.equal(ready, false);
  assert.equal(onboardingStepFor(loadOnboardingDraft(storage)), "models");
  onboardingDraftRef.current = completeOnboardingDraft(onboardingDraftRef.current);
  saveOnboardingDraft(storage, onboardingDraftRef.current);
  ready = true;
  receive({ created: [{ slug: "later-assigned" }] });
  assert.equal(team.length, 2);
  assert.equal(ready, true);
  assert.equal(onboardingStepFor(loadOnboardingDraft(storage)), "", "late assigned templates do not repeat a completed review");
});

test("unavailable saved models and efforts stay intact while Continue is blocked until corrected", async () => {
  const unresolvedSource = await callbackSource("../ui/app-model-defaults.tsx", "  const unresolved = ", "\n  const pending = ");
  const unresolvedScript = await transform(`((draft, review) => { return ${unresolvedSource} })`, { loader: "ts", target: "es2022" });
  const purposes = Object.keys(DEFAULT_MODEL_DEFAULTS).map((id) => ({ id }));
  const unresolved: (draft: OnboardingDraft, review: ReturnType<typeof onboardingModelReview>) => boolean = runInNewContext(unresolvedScript.code, { PURPOSES: purposes });
  const labelSource = await callbackSource("../ui/app-model-defaults.tsx", "    const label = ", "\n    const effort = ");
  const labelScript = await transform(`((model, selection, preview) => { return ${labelSource} })`, { loader: "ts", target: "es2022" });
  const label: (model: ReturnType<typeof modelCatalog>["models"][number] | undefined, selection: ModelDefaults["conversation"], preview: ReturnType<typeof onboardingModelReview>["previews"]["conversation"]) => string = runInNewContext(labelScript.code, {});
  const submitSource = await callbackSource("../ui/app-model-defaults.tsx", "  async function continueWithModels() {", "\n\n  return (");
  const submitScript = await transform(`(async () => {${submitSource})`, { loader: "ts", target: "es2022" });
  const catalog = modelCatalog();
  for (const savedChoice of [
    { model: "ipr_saved/gwm_unavailable_exact_route", modelVariant: "high" },
    { model: "openai/gpt-5.6-luna", modelVariant: "unoffered" },
  ]) {
    const storage = memoryStorage();
    let draft: OnboardingDraft = { ...emptyOnboardingDraft(), step: "models", providerId: "openai", intents: ["research"] };
    saveOnboardingDraft(storage, draft);
    const original = JSON.stringify(draft);
    const savedDefaults = normalizeModelDefaults({ conversation: savedChoice });
    const review = onboardingModelReview(draft, catalog, savedDefaults);
    let writes = 0, completions = 0;
    const sandbox = {
      current: { catalog }, loading: false, savingRef: { current: false }, readError: "", pending: false,
      mounted: { current: true }, saveContextRef: { current: "review" }, saveContext: "review", review,
      unresolved: unresolved(draft, review), PURPOSES: purposes, setSaving: ignore, setSaveError: ignore,
      onChange: (update: (current: OnboardingDraft) => OnboardingDraft) => { draft = update(draft); saveOnboardingDraft(storage, draft); },
      onContinue: () => { completions += 1; },
      coworkerBridge: { settings: { update: async (patch: { modelDefaults: ModelDefaults }) => { writes += 1; return patch; } } },
    };
    const submit: () => Promise<void> = runInNewContext(submitScript.code, sandbox);
    assert.equal(sandbox.unresolved, true);
    assert.equal(review.previews.conversation.state, "unavailable");
    assert.deepEqual(review.defaults.conversation, savedChoice);
    assert.equal(label(undefined, savedChoice, review.previews.conversation), "Saved model");
    await submit();
    assert.equal(writes, 0);
    assert.equal(completions, 0);
    assert.equal(JSON.stringify(loadOnboardingDraft(storage)), original);
    assert.deepEqual(savedDefaults.conversation, savedChoice);
    draft = chooseOnboardingModel(draft, "conversation", { model: "openai/gpt-5.6-luna", modelVariant: "low" });
    sandbox.review = onboardingModelReview(draft, catalog, savedDefaults);
    sandbox.unresolved = unresolved(draft, sandbox.review);
    assert.equal(sandbox.unresolved, false);
    await submit();
    assert.equal(writes, 1);
    assert.equal(completions, 1);
    assert.equal(loadOnboardingDraft(storage).modelChoices?.conversation?.modelVariant, "low");
  }
  const withoutLuna = { ...catalog, models: catalog.models.filter((model) => model.modelId !== "gpt-5.6-luna") };
  const automatic = chooseOnboardingModel({ ...emptyOnboardingDraft(), providerId: "openai" }, "facilitator", { model: "", modelVariant: "" });
  const participantContext = onboardingModelReview(automatic, withoutLuna, DEFAULT_MODEL_DEFAULTS);
  assert.equal(participantContext.previews.facilitator.state, "context");
  assert.equal(unresolved(automatic, participantContext), false, "explicit Automatic can defer facilitator choice to group participants");
  const otherContext = chooseOnboardingModel(automatic, "thinking", { model: "", modelVariant: "" });
  participantContext.previews.thinking = { state: "context", detail: "Model context is not ready" };
  assert.equal(unresolved(otherContext, participantContext), true, "other roles cannot use the participant-context exception");
});

test("Continue alone saves reviewed role defaults and keeps them available after a failed save", async () => {
  const source = await callbackSource("../ui/app-model-defaults.tsx", "  async function continueWithModels() {", "\n\n  return (");
  const script = await transform(`(async () => {${source})`, { loader: "ts", target: "es2022" });
  const storage = memoryStorage();
  let current: OnboardingDraft = { ...emptyOnboardingDraft(), step: "models", providerId: "openai" };
  const review = onboardingModelReview(current, modelCatalog(), DEFAULT_MODEL_DEFAULTS);
  const writes: Array<{ modelDefaults: ModelDefaults }> = [];
  const first = deferred<{ modelDefaults: ModelDefaults }>();
  const late = deferred<{ modelDefaults: ModelDefaults }>();
  const generation = { current: 1 };
  const scopeRef = { current: "local" };
  const saveContextRef = { current: "local" };
  let accepted = false;
  let error = "";
  const submit: () => Promise<void> = runInNewContext(script.code, {
    current: { catalog: modelCatalog() }, loading: false, savingRef: { current: false }, readError: "", unresolved: false, pending: false,
    generation, scopeRef, scope: "local", review, mounted: { current: true }, saveContextRef, saveContext: "local",
    PURPOSES: Object.keys(DEFAULT_MODEL_DEFAULTS).map((id) => ({ id })),
    onChange: (update: (draft: OnboardingDraft) => OnboardingDraft) => { current = update(current); saveOnboardingDraft(storage, current); },
    setSaving: ignore, setSaveError: (value: string) => { error = value; },
    onContinue: () => { accepted = true; },
    coworkerBridge: { settings: { update: (patch: { modelDefaults: ModelDefaults }) => {
      writes.push(patch);
      generation.current += 1;
      scopeRef.current = `settings-revision-${writes.length}`;
      return writes.length === 1 ? first.promise : writes.length === 2 ? Promise.resolve({ modelDefaults: patch.modelDefaults }) : late.promise;
    } } },
  });
  assert.equal(writes.length, 0);
  const saving = submit();
  await submit();
  assert.equal(writes.length, 1, "a repeated Continue cannot write twice while saving");
  assert.deepEqual(Object.keys(writes[0] ?? {}), ["modelDefaults"], "background settings and disabled preferences are untouched");
  assert.deepEqual(loadOnboardingDraft(storage).modelChoices, review.defaults);
  first.reject(new Error("Settings unavailable"));
  await saving;
  assert.equal(accepted, false);
  assert.match(error, /reviewed choices are kept/);
  assert.equal(onboardingStepFor(loadOnboardingDraft(storage)), "models");
  await submit();
  assert.equal(accepted, true, "the save's own readiness revision does not demand another model review");
  assert.equal(writes.length, 2);
  accepted = false;
  const changedAccount = submit();
  saveContextRef.current = "another-account";
  late.resolve({ modelDefaults: review.defaults });
  await changedAccount;
  assert.equal(accepted, false, "a late receipt cannot navigate another account's onboarding");
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
