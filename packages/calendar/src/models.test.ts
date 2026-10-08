import { describe, expect, test } from "bun:test";
import { automationModelOptions, findAutomationModelOption } from "@openwork/types/automation-models";

// The Calendar on both surfaces offers models from this list; the desktop editor uses the same one.
describe("the models an Automation can use", () => {
  const providers = [
    { id: "lpr_anthropic", source: "models_dev", providerId: "anthropic", name: "Anthropic", models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }] },
    { id: "lpr_openwork", source: "openwork", providerId: "openwork", name: "OpenWork", models: [] },
  ];

  test("cloud lists the cloud default first and never the free desktop starter", () => {
    const options = automationModelOptions(providers, { includeFreeStarter: false, includeCloudDefault: true });
    expect(options[0]).toMatchObject({ providerId: "openwork-cloud", modelId: "default", accessKind: "cloud_default", logoProviderId: "openwork" });
    expect(options.some((option) => option.accessKind === "free")).toBe(false);
  });

  test("a provider's models keep its record id for saving and its catalog id for the logo", () => {
    const options = automationModelOptions(providers, { includeFreeStarter: false });
    const claude = findAutomationModelOption(options, { providerId: "lpr_anthropic", modelId: "claude-sonnet-4-5" });
    expect(claude).toMatchObject({ providerName: "Anthropic", modelName: "Claude Sonnet 4.5", logoProviderId: "anthropic", accessKind: "authorized_custom" });
    expect(options.every((option) => option.accessKind !== "cloud_default")).toBe(true);
  });

  test("the desktop list starts with the free starter, then OpenWork's own models", () => {
    const options = automationModelOptions(providers);
    expect(options[0]?.accessKind).toBe("free");
    expect(options.findIndex((option) => option.accessKind === "openwork_managed")).toBeLessThan(options.findIndex((option) => option.accessKind === "authorized_custom"));
  });
});
