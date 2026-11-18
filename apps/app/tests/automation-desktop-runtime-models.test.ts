import { expect, test } from "bun:test";
import type { DenOrgLlmProvider } from "../src/app/lib/den.ts";
import type { ProviderListItem } from "../src/app/types.ts";
import {
  automationModelOptions,
  automationProviderCatalog,
  resolveProposalModel,
} from "../src/react-app/domains/automations/automation-model-options.ts";

function runtimeProvider(id: string, name: string, models: string[]) {
  return {
    id,
    name,
    models: Object.fromEntries(models.map((model) => [model, { id: model, providerID: id, name: `${name} ${model}` }])),
  } as unknown as ProviderListItem;
}

const team = { id: "lpr_team", providerId: "anthropic", name: "Team", source: "custom", models: [{ id: "team-model", name: "Team model" }] } as unknown as DenOrgLlmProvider;

test("a desktop offers the models connected only on it when the organization provides none (#6482)", () => {
  const catalog = automationProviderCatalog([
    runtimeProvider("nvidia", "NVIDIA", ["llama"]),
    runtimeProvider("opencode-go", "OpenCode Go", ["kimi"]),
    runtimeProvider("ipr_gateway", "AI Gateway", ["gpt"]),
  ]);
  const options = automationModelOptions([], { includeFreeStarter: false, catalog });
  expect(options.map((option) => `${option.providerId}/${option.modelId}`)).toEqual(["ipr_gateway/gpt", "nvidia/llama", "opencode-go/kimi"]);
  expect(options.every((option) => option.accessKind === "desktop_runtime")).toBe(true);
  expect(options.find((option) => option.providerId === "nvidia")?.providerName).toBe("NVIDIA");
});

test("Den's own providers stay Den's, and retired Zen is never offered from the runtime", () => {
  const catalog = automationProviderCatalog([
    runtimeProvider("lpr_team", "Team", ["team-model", "unassigned"]),
    runtimeProvider("opencode", "OpenCode Zen", ["big-pickle"]),
    runtimeProvider("openwork", "OpenWork", ["unknown"]),
  ]);
  const options = automationModelOptions([team], { includeFreeStarter: false, catalog });
  expect(options.map((option) => `${option.providerId}/${option.modelId}`)).toEqual(["lpr_team/team-model"]);
  expect(options[0]?.accessKind).toBe("authorized_custom");
});

test("Cloud placement, which has no desktop catalog, never offers desktop-only models", () => {
  expect(automationModelOptions([team], { includeFreeStarter: false })).toHaveLength(1);
});

test("a proposal on a desktop with only local providers resolves to a local model", () => {
  const catalog = automationProviderCatalog([runtimeProvider("google", "Google", ["gemini"])]);
  const resolved = resolveProposalModel(undefined, [], { includeFreeStarter: false, catalog });
  expect(resolved).toEqual({ model: { providerId: "google", modelId: "gemini", variant: null }, resolution: "default" });
  expect(resolveProposalModel({ providerId: "google", modelId: "gemini" }, [], { includeFreeStarter: false, catalog }).resolution).toBe("exact");
});
