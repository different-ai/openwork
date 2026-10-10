import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { browserScript } from "@openwork/cdp";
import type { BrowserEvaluation, Surface } from "@openwork/cdp";
import { assertSelectedModel, readAvailableModels, selectModel } from "./models.ts";

let page: Window;
let clicks: string[];
let retainSelection: boolean;
const app: Surface = {
  handle: { name: "picker-fixture", kind: "chrome", hostKind: "fixture", cdpUrl: "http://127.0.0.1" },
  client: {
    send: async () => { throw new Error("Fixture must not dispatch CDP"); },
    close: () => {},
  },
};

function evaluate(expression: BrowserEvaluation): unknown {
  return typeof expression === "function" ? expression() : Reflect.apply(expression.callback, undefined, expression.args);
}

vi.mock("./desktop.ts", () => ({
  evalIn: async (_app: Surface, expression: BrowserEvaluation) => evaluate(expression),
  waitFor: async (_app: Surface, expression: BrowserEvaluation, options: { label: string }) => {
    const value = evaluate(expression);
    if (!value) throw new Error(`Timed out waiting for ${options.label}`);
    return value;
  },
  control: async (_app: Surface, action: string) => {
    expect(action).toBe("session.model_picker.open");
    openPicker();
  },
  fill: async (_app: Surface, selector: string, value: string) => {
    evaluate(browserScript((selector, value) => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement)) throw new Error("Missing fixture search");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, [selector, value]));
  },
}));

// Mirrors #5196's public picker contract: command items are not buttons,
// opaque IDs are not visible/searchable, and Pin is a nested button.
function openPicker() {
  page.document.querySelector('[data-testid="all-models-picker"]')?.remove();
  const dialog = page.document.createElement("div");
  dialog.dataset.testid = "all-models-picker";
  dialog.innerHTML = `<input aria-label="Search all models" placeholder="Search models…">
    <div data-testid="retained-selected-model" aria-disabled="true">Saved model no longer available here</div>`;
  const selected = page.localStorage.getItem("fixture.workspaceModel");
  const rows = [
    { provider: "ipr_fixture", id: "gwm_fixture", name: "Claude Haiku 4.5", description: "Fixture Gateway", disabled: false },
    { provider: "other", id: "gwm_fixture", name: "Claude Haiku 4.5", description: "Other Gateway", disabled: false },
    { provider: "local", id: "family/model:variant", name: "Local model", description: "Local provider · pinned by your org", disabled: false },
    { provider: "disabled", id: "disabled-model", name: "Disabled model", description: "Disabled provider", disabled: true },
    { provider: "openwork-free", id: "openai/gpt-6-luna", name: "Auto", description: "OpenWork picks the model", disabled: false },
  ];
  for (const model of rows) {
    const row = page.document.createElement("div");
    const key = `${model.provider}:${model.id}`;
    row.setAttribute("role", "option");
    row.dataset.modelKey = key;
    row.dataset.checked = String(selected === key);
    if (model.disabled) { row.setAttribute("aria-disabled", "true"); row.setAttribute("data-disabled", ""); }
    row.innerHTML = `<span data-slot="model-label"><span>${model.name}</span><span>${model.description}</span></span><button>Pin</button>`;
    row.addEventListener("click", () => {
      clicks.push(key);
      if (retainSelection) page.localStorage.setItem("fixture.workspaceModel", key);
      dialog.remove();
    });
    dialog.append(row);
  }
  const done = page.document.createElement("button");
  done.textContent = "Done";
  done.addEventListener("click", () => dialog.remove());
  dialog.append(done);
  page.document.body.append(dialog);
}

beforeEach(() => {
  page = new Window({ url: "http://fixture.openwork.test" });
  clicks = [];
  retainSelection = true;
  page.localStorage.setItem("openwork.preferences", JSON.stringify({ defaultModel: { providerID: "other", modelID: "gwm_fixture" } }));
  Reflect.set(page, "__openworkControl", { listActions: () => [{ id: "session.model_picker.open", disabled: false }] });
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", page.document);
  vi.stubGlobal("localStorage", page.localStorage);
  vi.stubGlobal("HTMLInputElement", page.HTMLInputElement);
  vi.stubGlobal("Event", page.Event);
});
afterEach(async () => { vi.unstubAllGlobals(); await page.happyDOM.close(); });

describe("current model picker behavior", () => {
  it("reads command rows, exact identities, checked state and disabled models without styling dependencies", async () => {
    page.localStorage.setItem("fixture.workspaceModel", "local:family/model:variant");
    const models = await readAvailableModels(app);
    expect(models).toHaveLength(5);
    expect(models[0]).toEqual({ id: "gwm_fixture", providerId: "ipr_fixture", name: "Claude Haiku 4.5", providerName: "Fixture Gateway", selected: false, selectable: true });
    expect(models[2]).toMatchObject({ id: "family/model:variant", providerId: "local", providerName: "Local provider", selected: true });
    expect(models[3]?.selectable).toBe(false);
    expect(clicks).toEqual([]);
  });

  it("selects an opaque model by exact provider ID and verifies workspace selection, not same-ID global preferences", async () => {
    const model = await selectModel(app, "gwm_fixture", { providerId: "ipr_fixture" });
    expect(model).toMatchObject({ providerId: "ipr_fixture", id: "gwm_fixture", selected: true });
    expect(clicks).toEqual(["ipr_fixture:gwm_fixture"]);
    expect(page.document.querySelector('[data-testid="all-models-picker"]')).toBeNull();
    expect(JSON.parse(page.localStorage.getItem("openwork.preferences") ?? "{}").defaultModel.providerID).toBe("other");
  });

  it("still accepts a friendly name scoped to a provider and slash-containing model IDs", async () => {
    expect(await selectModel(app, "Claude Haiku 4.5", { provider: "Fixture Gateway" })).toMatchObject({ providerId: "ipr_fixture", selected: true });
    expect(await selectModel(app, "local/family/model:variant")).toMatchObject({ id: "family/model:variant", selected: true });
  });

  it("rejects ambiguous names rather than picking the first matching provider", async () => {
    await expect(selectModel(app, "Claude Haiku 4.5")).rejects.toThrow("ambiguous");
    expect(clicks).toEqual([]);
  });

  it("does not select disabled rows or silently substitute Auto for a missing gateway", async () => {
    await expect(selectModel(app, "disabled-model")).rejects.toThrow("selectable model disabled-model");
    await expect(selectModel(app, "missing", { providerId: "ipr_fixture" })).rejects.toThrow("selectable model missing");
    expect(clicks).toEqual([]);
  });

  it("checks refresh persistence without reselecting or accepting a different provider with the same model ID", async () => {
    page.localStorage.setItem("fixture.workspaceModel", "other:gwm_fixture");
    await expect(assertSelectedModel(app, { providerId: "ipr_fixture", id: "gwm_fixture" })).rejects.toThrow("selected model ipr_fixture/gwm_fixture");
    await assertSelectedModel(app, { providerId: "other", id: "gwm_fixture" });
    expect(clicks).toEqual([]);
  });

  it("does not claim success when a click fails to change the actual current selection", async () => {
    retainSelection = false;
    await expect(selectModel(app, "gwm_fixture", { providerId: "ipr_fixture" })).rejects.toThrow("selected model ipr_fixture/gwm_fixture");
    expect(clicks).toEqual(["ipr_fixture:gwm_fixture"]);
  });
});
