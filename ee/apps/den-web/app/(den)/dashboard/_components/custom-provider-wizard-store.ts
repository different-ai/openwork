/**
 * State for the four-step "Add a custom provider" wizard. One in-memory
 * Zustand store per wizard: moving between steps never loses anything, and
 * the key never reaches localStorage or the URL. Nothing is written to den-api
 * until Add.
 */

import { createStore } from "zustand/vanilla";
import { normalizeGatewayCustomBaseUrl, type GatewayCustomDiscoverResponse, type GatewayCustomTestResponse } from "@openwork/types/den/gateway-custom-providers";
import {
  applyTemplateSettings, checkSelectedModels, connectionError, EMPTY_MODEL_SETTINGS, mergeDiscoveredModels, resolveTestModelKey, testFailureTarget, testFingerprint,
  type ConnectionField, type ModelDraft, type ModelSettingsDraft, type ModelSettingsField,
} from "./custom-provider-models";

export const WIZARD_STEPS = [
  { step: 1, label: "Connection" },
  { step: 2, label: "Fetch models" },
  { step: 3, label: "Choose models" },
  { step: 4, label: "Test and add" },
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number]["step"];

export type WizardHighlight =
  | { kind: "field"; field: ConnectionField }
  | { kind: "model"; key: string; field: ModelSettingsField | null }
  | null;

export type WizardDiscovery =
  | { state: "idle" }
  | { state: "loading"; connection: string }
  | { state: "done"; connection: string; response: GatewayCustomDiscoverResponse }
  | { state: "error"; connection: string; message: string };

export type WizardTest =
  | { state: "idle" }
  | { state: "running"; fingerprint: string }
  | { state: "done"; fingerprint: string; result: GatewayCustomTestResponse };

export type WizardAccess = { orgWide: boolean; memberIds: string[]; teamIds: string[] };

export type WizardData = {
  step: WizardStep;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** A field or model to point at, with the message that sent the admin there. */
  highlight: WizardHighlight;
  message: string | null;
  discovery: WizardDiscovery;
  /** Ids the last answered fetch listed; only these can be flagged "no longer listed". Sent on create. */
  listedModelIds: string[];
  models: ModelDraft[];
  nextKey: number;
  /** The model whose settings are open. */
  expandedKey: string | null;
  testModelKey: string | null;
  test: WizardTest;
  access: WizardAccess;
};

export type WizardActions = {
  setName: (value: string) => void;
  setBaseUrl: (value: string) => void;
  setApiKey: (value: string) => void;
  setAccess: (value: WizardAccess) => void;
  goTo: (step: WizardStep) => void;
  /** Validates the current step; on success moves on, otherwise points at what to fix. Returns whether it moved. */
  next: () => boolean;
  back: () => void;
  discoveryStarted: (connection: string) => void;
  discoveryFinished: (connection: string, response: GatewayCustomDiscoverResponse) => void;
  discoveryFailed: (connection: string, message: string) => void;
  toggleModel: (key: string) => void;
  setAllSelected: (selected: boolean) => void;
  updateModel: (key: string, patch: Partial<ModelSettingsDraft>) => void;
  applyTemplate: (key: string, template: { id: string; name: string; settings: ModelSettingsDraft }) => void;
  setUpManually: (key: string) => void;
  addFromTemplate: (template: { id: string; name: string; settings: ModelSettingsDraft }) => void;
  addCustomModel: () => void;
  removeModel: (key: string) => void;
  setExpanded: (key: string | null) => void;
  setTestModel: (key: string) => void;
  testStarted: (fingerprint: string) => void;
  /** Keeps the result only if nothing changed while it ran; a failure sends the admin to the step that caused it. */
  testFinished: (fingerprint: string, result: GatewayCustomTestResponse) => void;
};

export type WizardState = WizardData & WizardActions;

export const INITIAL_WIZARD: WizardData = {
  step: 1, name: "", baseUrl: "", apiKey: "", highlight: null, message: null,
  discovery: { state: "idle" }, listedModelIds: [], models: [], nextKey: 1, expandedKey: null, testModelKey: null,
  test: { state: "idle" }, access: { orgWide: true, memberIds: [], teamIds: [] },
};

/** Identifies the connection a discovery ran for; a different one needs a new fetch. */
export function connectionKey(state: Pick<WizardData, "baseUrl" | "apiKey">): string {
  return JSON.stringify([normalizeGatewayCustomBaseUrl(state.baseUrl) ?? state.baseUrl.trim(), state.apiKey.trim()]);
}

export function needsDiscovery(state: WizardData): boolean {
  return state.discovery.state === "idle" || state.discovery.state === "error" || state.discovery.connection !== connectionKey(state);
}

export function wizardTestModelKey(state: WizardData): string | null {
  return resolveTestModelKey(state.models, state.testModelKey);
}

export function wizardFingerprint(state: WizardData): string {
  return testFingerprint({ baseUrl: state.baseUrl, apiKey: state.apiKey, drafts: state.models, testModelKey: wizardTestModelKey(state) });
}

/** The last test passed with exactly what is on screen now. */
export function wizardTestPassed(state: WizardData): boolean {
  return state.test.state === "done" && state.test.result.ok && state.test.fingerprint === wizardFingerprint(state);
}

/** The last test result, only while it still describes what is on screen. */
export function currentTestResult(state: WizardData): GatewayCustomTestResponse | null {
  return state.test.state === "done" && state.test.fingerprint === wizardFingerprint(state) ? state.test.result : null;
}

function clearHighlightFor(state: WizardData, matches: (highlight: NonNullable<WizardHighlight>) => boolean): Pick<WizardData, "highlight" | "message"> {
  return state.highlight && matches(state.highlight) ? { highlight: null, message: null } : { highlight: state.highlight, message: state.message };
}

export function createWizardStore(initial: Partial<WizardData> = {}) {
  return createStore<WizardState>()((set, get) => {
    const makeKey = () => {
      const key = `m${get().nextKey}`;
      set((state) => ({ nextKey: state.nextKey + 1 }));
      return key;
    };
    const editModel = (key: string, change: (draft: ModelDraft) => ModelDraft) => set((state) => ({
      models: state.models.map((draft) => draft.key === key ? change(draft) : draft),
      ...clearHighlightFor(state, (highlight) => highlight.kind === "model" && highlight.key === key),
    }));

    return {
      ...INITIAL_WIZARD,
      ...initial,
      setName: (name) => set((state) => ({ name, ...clearHighlightFor(state, (highlight) => highlight.kind === "field" && highlight.field === "name") })),
      setBaseUrl: (baseUrl) => set((state) => ({ baseUrl, ...clearHighlightFor(state, (highlight) => highlight.kind === "field" && highlight.field === "baseUrl") })),
      setApiKey: (apiKey) => set((state) => ({ apiKey, ...clearHighlightFor(state, (highlight) => highlight.kind === "field" && highlight.field === "apiKey") })),
      setAccess: (access) => set({ access }),
      goTo: (step) => set({ step, highlight: null, message: null }),
      next: () => {
        const state = get();
        if (state.step === 1) {
          const problem = connectionError({ name: state.name, baseUrl: state.baseUrl, apiKey: state.apiKey, apiKeyRequired: true });
          if (problem) { set({ highlight: { kind: "field", field: problem.field }, message: problem.message }); return false; }
          set({ step: 2, highlight: null, message: null });
          return true;
        }
        if (state.step === 2) {
          if (state.discovery.state !== "done") return false;
          set({ step: 3, highlight: null, message: null });
          return true;
        }
        if (state.step === 3) {
          const check = checkSelectedModels(state.models);
          if (!check.ok) {
            set({ highlight: check.key ? { kind: "model", key: check.key, field: check.field } : null, message: check.message, expandedKey: check.key ?? state.expandedKey });
            return false;
          }
          set({ step: 4, highlight: null, message: null, testModelKey: wizardTestModelKey(state) });
          return true;
        }
        return false;
      },
      back: () => set((state) => ({ step: state.step === 4 ? 3 : state.step === 3 ? 2 : 1, highlight: null, message: null })),
      discoveryStarted: (connection) => set({ discovery: { state: "loading", connection } }),
      discoveryFinished: (connection, response) => {
        if (get().discovery.state !== "loading" || connectionKey(get()) !== connection) return;
        const models = mergeDiscoveredModels(get().models, response.models, response.status, { selectMatched: true, makeKey, previouslyListed: new Set(get().listedModelIds) });
        // An unavailable answer learned nothing, so the last listed ids stay.
        const listedModelIds = response.status === "unavailable" ? get().listedModelIds : [...new Set(response.models.map((entry) => entry.id))];
        set({ discovery: { state: "done", connection, response }, listedModelIds, models });
      },
      discoveryFailed: (connection, message) => {
        if (connectionKey(get()) !== connection) return;
        set({ discovery: { state: "error", connection, message } });
      },
      toggleModel: (key) => editModel(key, (draft) => ({ ...draft, selected: !draft.selected })),
      setAllSelected: (selected) => set((state) => ({ models: state.models.map((draft) => ({ ...draft, selected })), highlight: null, message: null })),
      updateModel: (key, patch) => editModel(key, (draft) => ({ ...draft, settings: { ...draft.settings, ...patch }, configured: true })),
      applyTemplate: (key, template) => editModel(key, (draft) => ({
        ...draft,
        settings: applyTemplateSettings(draft.settings, template.settings),
        origin: { kind: "template", templateId: template.id, templateName: template.name },
        configured: true,
        selected: true,
      })),
      setUpManually: (key) => {
        editModel(key, (draft) => ({ ...draft, configured: true, selected: true, origin: draft.origin.kind === "unknown" ? { kind: "custom" } : draft.origin }));
        set({ expandedKey: key });
      },
      addFromTemplate: (template) => {
        const key = makeKey();
        set((state) => ({
          models: [...state.models, { key, settings: template.settings, origin: { kind: "template", templateId: template.id, templateName: template.name }, selected: true, configured: true, missing: false }],
          expandedKey: key,
        }));
      },
      addCustomModel: () => {
        const key = makeKey();
        set((state) => ({ models: [...state.models, { key, settings: { ...EMPTY_MODEL_SETTINGS }, origin: { kind: "custom" }, selected: true, configured: true, missing: false }], expandedKey: key }));
      },
      removeModel: (key) => set((state) => ({
        models: state.models.filter((draft) => draft.key !== key),
        expandedKey: state.expandedKey === key ? null : state.expandedKey,
        ...clearHighlightFor(state, (highlight) => highlight.kind === "model" && highlight.key === key),
      })),
      setExpanded: (expandedKey) => set({ expandedKey }),
      setTestModel: (testModelKey) => set({ testModelKey }),
      testStarted: (fingerprint) => set({ test: { state: "running", fingerprint } }),
      testFinished: (fingerprint, result) => {
        const state = get();
        if (state.test.state !== "running" || state.test.fingerprint !== fingerprint || wizardFingerprint(state) !== fingerprint) return;
        set({ test: { state: "done", fingerprint, result } });
        if (result.ok) return;
        const target = testFailureTarget(result, wizardTestModelKey(state));
        if (target?.step === "connection") set({ step: 1, highlight: { kind: "field", field: target.field }, message: result.message });
        else if (target?.step === "model") set({ step: 3, highlight: { kind: "model", key: target.modelKey, field: null }, message: result.message, expandedKey: target.modelKey });
      },
    };
  });
}

export type WizardStore = ReturnType<typeof createWizardStore>;
