import { browserScript } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { DenSession } from "./den.ts";
import { denFetch } from "./den.ts";
import { control, evalIn, fill, waitFor } from "./desktop.ts";

const MODEL_DIALOG = '[data-testid="all-models-picker"]';
const MODEL_SEARCH_INPUT = `${MODEL_DIALOG} input[aria-label="Search all models"]`;

export interface ModelFacts {
  id: string;
  name: string;
  providerName: string;
  providerId: string;
  selected: boolean;
  selectable: boolean;
}

export interface ModelRecoveryFacts {
  emptyMessageVisible: boolean;
  retryVisible: boolean;
  refreshVisible: boolean;
  connectProviderVisible: boolean;
  warningVisible: boolean;
  guidanceVisible: boolean;
  pickerOpen: boolean;
  runTaskEnabled: boolean;
  noticeHeight: number | null;
  noticeWhiteSpace: string | null;
}

export interface UnavailableModelSeed {
  unavailableModelId: string;
  availableModelId: string;
  availableModelName: string;
  availableProviderName: string;
}

export async function readCurrentOrganizationMemberId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const currentMember = isRecord(result.body) && isRecord(result.body.currentMember)
    ? result.body.currentMember
    : null;
  const memberId = currentMember && typeof currentMember.id === "string" ? currentMember.id : "";
  if (!result.response.ok || !memberId) {
    throw new Error(
      `Could not find ${session.email}'s organization membership: GET /v1/org returned HTTP ${result.response.status} ${result.text.slice(0, 500)}`,
    );
  }
  return memberId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function openModelPicker(app: Surface): Promise<void> {
  const open = await evalIn(app, browserScript((selector) => Boolean(document.querySelector(selector)), [MODEL_SEARCH_INPUT]));
  if (open !== true) {
    await waitFor(app, () => (window.__openworkControl?.listActions().some((entry) => entry.id === "session.model_picker.open" && entry.disabled === false)), {
      timeoutMs: 30_000,
      label: "session.model_picker.open enabled",
    });
    await control(app, "session.model_picker.open");
  }
  await waitFor(app, browserScript((MODEL_SEARCH_INPUT) => (Boolean(document.querySelector<HTMLElement>(MODEL_SEARCH_INPUT))), [MODEL_SEARCH_INPUT]), {
    timeoutMs: 30_000,
    label: "Models picker search input",
  });
}

/** Read the picker’s public row contract, not visual classes or provider groups.
 * Model IDs can contain slashes (and colons); the first colon separates the
 * provider from the model in data-model-key.
 */
export function modelPickerRows(selector: string): ModelFacts[] {
  const dialog = document.querySelector<HTMLElement>(selector);
  if (!dialog) return [];
  return [...dialog.querySelectorAll<HTMLElement>("[data-model-key]")].flatMap((row) => {
    const key = row.dataset.modelKey ?? "";
    const separator = key.indexOf(":");
    if (separator < 1 || separator === key.length - 1) return [];
    const label = row.querySelector<HTMLElement>('[data-slot="model-label"]');
    const name = label?.firstElementChild?.textContent?.trim();
    if (!name) return [];
    return [{
      id: key.slice(separator + 1),
      providerId: key.slice(0, separator),
      name,
      providerName: label?.children[1]?.textContent?.split(" · ")[0]?.trim() ?? "",
      selected: row.dataset.checked === "true",
      selectable: !row.hasAttribute("disabled") && !row.hasAttribute("data-disabled") && row.getAttribute("aria-disabled") !== "true",
    }];
  });
}

function parseModels(value: unknown): ModelFacts[] {
  if (!Array.isArray(value)) throw new Error("Model picker did not return an array.");
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.providerName !== "string" || typeof entry.providerId !== "string") return [];
    return [{
      id: entry.id,
      name: entry.name,
      providerName: entry.providerName,
      providerId: entry.providerId,
      selected: entry.selected === true,
      selectable: entry.selectable === true,
    }];
  });
}

async function pickerModels(app: Surface): Promise<ModelFacts[]> {
  return parseModels(await evalIn(app, browserScript(modelPickerRows, [MODEL_DIALOG])));
}

export async function readAvailableModels(app: Surface): Promise<ModelFacts[]> {
  await openModelPicker(app);
  await fill(app, MODEL_SEARCH_INPUT, "");
  await waitFor(app, browserScript((selector) => {
    const dialog = document.querySelector<HTMLElement>(selector);
    return Boolean(dialog && (dialog.querySelector("[data-model-key]") || dialog.querySelector('[data-testid="model-catalog-empty"]')));
  }, [MODEL_DIALOG]), { timeoutMs: 30_000, label: "model rows or empty state" });
  return pickerModels(app);
}

export interface ModelSelectionOptions {
  provider?: string;
  /** Exact runtime provider ID; use this when seeding a particular gateway. */
  providerId?: string;
}

function matchingModels(models: ModelFacts[], name: string, options?: ModelSelectionOptions): ModelFacts[] {
  return models.filter((model) => model.selectable
    && (options?.provider === undefined || model.providerName === options.provider.trim())
    && (options?.providerId === undefined || model.providerId === options.providerId)
    && (model.id === name || model.name === name || `${model.providerId}/${model.id}` === name));
}

async function closeModelPicker(app: Surface): Promise<void> {
  await evalIn(app, browserScript((selector) => {
    const dialog = document.querySelector<HTMLElement>(selector);
    const done = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => (button.textContent ?? "").trim() === "Done");
    done?.click();
    return Boolean(done);
  }, [MODEL_DIALOG]), { reattachAttempts: 0 });
  await waitFor(app, browserScript((selector) => !document.querySelector(selector), [MODEL_DIALOG]), {
    timeoutMs: 30_000, label: "Models picker closed after selection",
  });
}

export async function selectModel(app: Surface, name: string, options?: ModelSelectionOptions): Promise<ModelFacts> {
  await openModelPicker(app);
  // Search titles, not opaque gateway IDs: the picker deliberately keeps those
  // out of its searchable display copy. Match the exact identity below.
  await fill(app, MODEL_SEARCH_INPUT, "");
  await waitFor(app, browserScript((selector, name, provider, providerId) => {
    return [...(document.querySelector(selector)?.querySelectorAll<HTMLElement>("[data-model-key]") ?? [])].some((row) => {
      const key = row.dataset.modelKey ?? "";
      const separator = key.indexOf(":");
      const id = key.slice(separator + 1);
      const rowProvider = key.slice(0, separator);
      const label = row.querySelector('[data-slot="model-label"]');
      const title = label?.firstElementChild?.textContent?.trim();
      const subtitle = label?.children[1]?.textContent?.split(" · ")[0]?.trim() ?? "";
      return separator > 0 && !row.hasAttribute("disabled") && !row.hasAttribute("data-disabled") && row.getAttribute("aria-disabled") !== "true"
        && (provider === undefined || subtitle === provider) && (providerId === undefined || rowProvider === providerId)
        && (id === name || title === name || `${rowProvider}/${id}` === name);
    });
  }, [MODEL_DIALOG, name, options?.provider?.trim(), options?.providerId]), {
    timeoutMs: 30_000, label: `selectable model ${name}`,
  });
  const matches = matchingModels(await pickerModels(app), name, options);
  if (matches.length > 1) throw new Error(`Model selection ${name} is ambiguous (${matches.length} selectable rows); specify a provider ID.`);
  const model = matches[0];
  if (!model) throw new Error(`Model ${name} became unavailable before selection.`);
  const clicked = await evalIn(app, browserScript((selector, key) => {
    const row = [...(document.querySelector(selector)?.querySelectorAll<HTMLElement>("[data-model-key]") ?? [])]
      .find((candidate) => candidate.dataset.modelKey === key);
    if (!row || row.hasAttribute("disabled") || row.hasAttribute("data-disabled") || row.getAttribute("aria-disabled") === "true") return false;
    row.click();
    return true;
  }, [MODEL_DIALOG, `${model.providerId}:${model.id}`]), { reattachAttempts: 0 });
  if (clicked !== true) throw new Error(`Model ${name} became unavailable before selection.`);
  await closeModelPicker(app);
  await assertSelectedModel(app, model);
  return { ...model, selected: true };
}

/** Check the current workspace/session selection without selecting it again. */
export async function assertSelectedModel(app: Surface, model: Pick<ModelFacts, "providerId" | "id">): Promise<void> {
  // Selection is scoped to the current session/workspace, not necessarily the
  // global preferences key. Reopening reads the product’s actual current model.
  await openModelPicker(app);
  await fill(app, MODEL_SEARCH_INPUT, "");
  await waitFor(app, browserScript((selector, key) => {
    return [...(document.querySelector(selector)?.querySelectorAll<HTMLElement>("[data-model-key]") ?? [])]
      .some((row) => row.dataset.modelKey === key && row.dataset.checked === "true"
        && !row.hasAttribute("disabled") && !row.hasAttribute("data-disabled") && row.getAttribute("aria-disabled") !== "true");
  }, [MODEL_DIALOG, `${model.providerId}:${model.id}`]), {
    timeoutMs: 30_000, label: `selected model ${model.providerId}/${model.id}`,
  });
  await closeModelPicker(app);
}

export async function recoverInvalidModelSelection(
  app: Surface,
  preferredModelId?: string,
): Promise<ModelFacts | null> {
  const models = await readAvailableModels(app);
  const model = models.find((candidate) => candidate.selectable && candidate.id === preferredModelId)
    ?? models.find((candidate) => candidate.selectable);
  if (model) {
    const selected = await selectModel(app, model.id, { providerId: model.providerId });
    await waitFor(app, () => {
      const text = document.body.innerText;
      return !text.includes("Model no longer available")
        && !text.includes("The selected provider/model was not found in OpenCode provider catalog");
    }, { timeoutMs: 30_000, label: "invalid selected model cleared" });
    return selected;
  }

  await evalIn(app, () => {
    let preferences: Record<string, unknown> = {};
    try { preferences = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    delete preferences.defaultModel;
    delete preferences.modelVariant;
    localStorage.setItem("openwork.preferences", JSON.stringify(preferences));
    setTimeout(() => location.reload(), 0);
    return true;
  });
  await waitFor(app, () => (Boolean(window.__openworkControl)), {
    timeoutMs: 60_000,
    label: "control API after clearing invalid selected model",
  });
  await waitFor(app, () => {
    const text = document.body.innerText;
    return !text.includes("Model no longer available")
      && !text.includes("The selected provider/model was not found in OpenCode provider catalog");
  }, { timeoutMs: 30_000, label: "invalid selected model absent after reset" });
  return null;
}

export async function readModelRecoveryState(app: Surface): Promise<ModelRecoveryFacts> {
  const value = await evalIn(app, browserScript((MODEL_DIALOG) => {
    const text = document.body.innerText;
    const emptyMessage = "Your organization hasn't published any models for you yet.";
    const notice = [...document.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes(emptyMessage) && (button.textContent ?? "").includes("Retry")
    );
    const message = notice?.querySelector("span");
    const run = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Run task");
    return {
      emptyMessageVisible: text.includes(emptyMessage),
      retryVisible: text.includes("Retry"),
      refreshVisible: text.includes("Refresh organization models"),
      connectProviderVisible: text.includes("Connect a provider"),
      warningVisible: text.includes("Model no longer available"),
      guidanceVisible: text.includes("The model you were using is no longer available, please select a different model for this session."),
      pickerOpen: Boolean(document.querySelector<HTMLElement>(MODEL_DIALOG)),
      runTaskEnabled: Boolean(run && !run.disabled),
      noticeHeight: notice ? Math.round(notice.getBoundingClientRect().height) : null,
      noticeWhiteSpace: message ? getComputedStyle(message).whiteSpace : null,
    };
  }, [MODEL_DIALOG]));
  if (!isRecord(value)) throw new Error("Model recovery state was not an object.");
  return {
    emptyMessageVisible: value.emptyMessageVisible === true,
    retryVisible: value.retryVisible === true,
    refreshVisible: value.refreshVisible === true,
    connectProviderVisible: value.connectProviderVisible === true,
    warningVisible: value.warningVisible === true,
    guidanceVisible: value.guidanceVisible === true,
    pickerOpen: value.pickerOpen === true,
    runTaskEnabled: value.runTaskEnabled === true,
    noticeHeight: typeof value.noticeHeight === "number" ? value.noticeHeight : null,
    noticeWhiteSpace: typeof value.noticeWhiteSpace === "string" ? value.noticeWhiteSpace : null,
  };
}

export async function retryOrganizationModels(app: Surface): Promise<void> {
  await waitFor(app, () => {
    const button = [...document.querySelectorAll("button")].find((entry) => {
      const text = entry.textContent ?? "";
      return text.includes("Your organization hasn't published any models for you yet.") && text.includes("Retry") && !entry.disabled;
    });
    if (!button) return false;
    button.click();
    return true;
  }, { timeoutMs: 30_000, label: "organization model Retry" });
}

export async function seedUnavailableModel(app: Surface): Promise<UnavailableModelSeed> {
  await waitFor(app, () => (window.__openworkControl?.listActions().some((entry) => entry.id === "eval.model_not_available.seed" && entry.disabled === false)), {
    timeoutMs: 45_000,
    label: "eval.model_not_available.seed enabled",
  });
  const value = await control(app, "eval.model_not_available.seed");
  if (!isRecord(value) || !isRecord(value.unavailableModel) || !isRecord(value.availableModel)) {
    throw new Error(`Unavailable-model seed returned malformed facts: ${JSON.stringify(value)}`);
  }
  return {
    unavailableModelId: stringField(value.unavailableModel.modelID),
    availableModelId: stringField(value.availableModel.modelID),
    availableModelName: stringField(value.availableModel.title),
    availableProviderName: stringField(value.availableModel.providerName),
  };
}
