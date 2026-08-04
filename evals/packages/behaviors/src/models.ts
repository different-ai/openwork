import type { Surface } from "@openwork/cdp";
import type { DenSession } from "./den.ts";
import { denFetch } from "./den.ts";
import { evalIn, fill, waitFor } from "./desktop.ts";

const MODEL_DIALOG = '[data-slot="dialog-content"]';
const MODEL_SEARCH_INPUT = 'input[placeholder="Search providers and models..."]';

export interface ModelFacts {
  id: string;
  name: string;
  providerName: string;
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

async function executeControl(app: Surface, action: string, args?: unknown): Promise<unknown> {
  const result = await evalIn(
    app,
    `window.__openworkControl.execute(${JSON.stringify(action)}, ${JSON.stringify(args ?? null)})`,
    { awaitPromise: true },
  );
  if (!isRecord(result) || result.ok !== true) {
    throw new Error(`Desktop control action ${action} failed: ${isRecord(result) ? String(result.error ?? "unknown") : "unknown"}`);
  }
  return result.result;
}

async function openModelPicker(app: Surface): Promise<void> {
  const open = await evalIn(app, `Boolean(document.querySelector(${JSON.stringify(MODEL_SEARCH_INPUT)}))`);
  if (open !== true) {
    await waitFor(app, `window.__openworkControl?.listActions().some((entry) => entry.id === "session.model_picker.open" && entry.disabled === false)`, {
      timeoutMs: 30_000,
      label: "session.model_picker.open enabled",
    });
    await executeControl(app, "session.model_picker.open");
  }
  await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(MODEL_SEARCH_INPUT)}))`, {
    timeoutMs: 30_000,
    label: "Models dialog search input",
  });
}

function parseModels(value: unknown): ModelFacts[] {
  if (!Array.isArray(value)) throw new Error("Model picker did not return an array.");
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.providerName !== "string") return [];
    return [{
      id: entry.id,
      name: entry.name,
      providerName: entry.providerName,
      selected: entry.selected === true,
      selectable: entry.selectable === true,
    }];
  });
}

export async function readAvailableModels(app: Surface): Promise<ModelFacts[]> {
  await openModelPicker(app);
  await evalIn(app, `(() => {
    const dialog = document.querySelector(${JSON.stringify(MODEL_DIALOG)});
    if (!dialog) return false;
    const headers = [...dialog.querySelectorAll("button")].filter((button) => {
      const text = (button.textContent ?? "").replace(/\\s+/g, " ").trim();
      return /\\d+ models?$/.test(text);
    });
    for (const header of headers) {
      const group = header.parentElement?.parentElement;
      if (group && !group.querySelector("span.font-mono")) header.click();
    }
    return true;
  })()`);
  await waitFor(app, `(() => {
    const dialog = document.querySelector(${JSON.stringify(MODEL_DIALOG)});
    return Boolean(dialog && (dialog.querySelector("span.font-mono") || dialog.innerText.includes("No models")));
  })()`, { timeoutMs: 30_000, label: "model rows or empty state" });
  const value = await evalIn(app, `(() => {
    const dialog = document.querySelector(${JSON.stringify(MODEL_DIALOG)});
    if (!dialog) return [];
    return [...dialog.querySelectorAll("button")].flatMap((button) => {
      const id = button.querySelector("span.font-mono")?.textContent?.trim();
      if (!id) return [];
      const spans = [...button.querySelectorAll("span")];
      const name = spans.find((span) => !span.classList.contains("font-mono"))?.textContent?.trim() ?? id;
      let group = button.parentElement;
      while (group && !group.querySelector(':scope > div > button')) group = group.parentElement;
      const providerHeader = group?.querySelector(':scope > div > button');
      const providerName = providerHeader?.querySelector("span.text-dls-text")?.textContent?.trim()
        ?? providerHeader?.textContent?.replace(/\\d+ models?.*$/, "").trim()
        ?? "";
      return [{
        id,
        name,
        providerName,
        selected: button.className.includes("bg-green-3"),
        selectable: !button.disabled,
      }];
    });
  })()`);
  return parseModels(value);
}

export async function selectModel(app: Surface, name: string): Promise<ModelFacts> {
  await openModelPicker(app);
  await fill(app, MODEL_SEARCH_INPUT, name);
  await waitFor(app, `(() => {
    const dialog = document.querySelector(${JSON.stringify(MODEL_DIALOG)});
    return [...(dialog?.querySelectorAll("button") ?? [])].some((button) => {
      const id = button.querySelector("span.font-mono")?.textContent?.trim() ?? "";
      return !button.disabled && (id === ${JSON.stringify(name)} || (button.textContent ?? "").includes(${JSON.stringify(name)}));
    });
  })()`, { timeoutMs: 30_000, label: `selectable model ${name}` });
  const selected = await evalIn(app, `(() => {
    const dialog = document.querySelector(${JSON.stringify(MODEL_DIALOG)});
    const button = [...(dialog?.querySelectorAll("button") ?? [])].find((candidate) => {
      const id = candidate.querySelector("span.font-mono")?.textContent?.trim() ?? "";
      return !candidate.disabled && (id === ${JSON.stringify(name)} || (candidate.textContent ?? "").includes(${JSON.stringify(name)}));
    });
    if (!button) return null;
    const id = button.querySelector("span.font-mono")?.textContent?.trim() ?? "";
    const spans = [...button.querySelectorAll("span")];
    const title = spans.find((span) => !span.classList.contains("font-mono"))?.textContent?.trim() ?? id;
    let group = button.parentElement;
    while (group && !group.querySelector(':scope > div > button')) group = group.parentElement;
    const providerHeader = group?.querySelector(':scope > div > button');
    const providerName = providerHeader?.querySelector("span.text-dls-text")?.textContent?.trim()
      ?? providerHeader?.textContent?.replace(/\\d+ models?.*$/, "").trim()
      ?? "";
    button.click();
    return { id, name: title, providerName, selected: true, selectable: true };
  })()`);
  const models = parseModels(selected ? [selected] : []);
  const model = models[0];
  if (!model) throw new Error(`Could not select model ${name}.`);
  await waitFor(app, `!Boolean(document.querySelector(${JSON.stringify(MODEL_SEARCH_INPUT)}))`, {
    timeoutMs: 30_000,
    label: "Models dialog closed after selection",
  });
  const persisted = await evalIn(app, `(() => {
    try {
      const preferences = JSON.parse(localStorage.getItem("openwork.preferences") || "{}");
      return preferences?.defaultModel?.modelID === ${JSON.stringify(model.id)};
    } catch {
      return false;
    }
  })()`);
  return {
    ...model,
    selected: persisted === true,
  };
}

export async function recoverInvalidModelSelection(
  app: Surface,
  preferredModelId?: string,
): Promise<ModelFacts | null> {
  const models = await readAvailableModels(app);
  const model = models.find((candidate) => candidate.selectable && candidate.id === preferredModelId)
    ?? models.find((candidate) => candidate.selectable);
  if (model) {
    const selected = await selectModel(app, model.id);
    await waitFor(app, `(() => {
      const text = document.body.innerText;
      return !text.includes("Model no longer available")
        && !text.includes("The selected provider/model was not found in OpenCode provider catalog");
    })()`, { timeoutMs: 30_000, label: "invalid selected model cleared" });
    return selected;
  }

  await evalIn(app, `(() => {
    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    delete preferences.defaultModel;
    delete preferences.modelVariant;
    localStorage.setItem("openwork.preferences", JSON.stringify(preferences));
    setTimeout(() => location.reload(), 0);
    return true;
  })()`);
  await waitFor(app, "Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after clearing invalid selected model",
  });
  await waitFor(app, `(() => {
    const text = document.body.innerText;
    return !text.includes("Model no longer available")
      && !text.includes("The selected provider/model was not found in OpenCode provider catalog");
  })()`, { timeoutMs: 30_000, label: "invalid selected model absent after reset" });
  return null;
}

export async function readModelRecoveryState(app: Surface): Promise<ModelRecoveryFacts> {
  const value = await evalIn(app, `(() => {
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
      pickerOpen: Boolean(document.querySelector(${JSON.stringify(MODEL_DIALOG)})),
      runTaskEnabled: Boolean(run && !run.disabled),
      noticeHeight: notice ? Math.round(notice.getBoundingClientRect().height) : null,
      noticeWhiteSpace: message ? getComputedStyle(message).whiteSpace : null,
    };
  })()`);
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
  await waitFor(app, `(() => {
    const button = [...document.querySelectorAll("button")].find((entry) => {
      const text = entry.textContent ?? "";
      return text.includes("Your organization hasn't published any models for you yet.") && text.includes("Retry") && !entry.disabled;
    });
    if (!button) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "organization model Retry" });
}

export async function seedUnavailableModel(app: Surface): Promise<UnavailableModelSeed> {
  await waitFor(app, `window.__openworkControl?.listActions().some((entry) => entry.id === "eval.model_not_available.seed" && entry.disabled === false)`, {
    timeoutMs: 45_000,
    label: "eval.model_not_available.seed enabled",
  });
  const value = await executeControl(app, "eval.model_not_available.seed");
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
