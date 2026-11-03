import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ProviderListItem } from "../src/app/types";

GlobalRegistrator.register({ url: "http://localhost/" });
const { useModelBehavior } = await import("../src/react-app/domains/session/surface/use-model-behavior");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); await GlobalRegistrator.unregister(); });

const claude = { providerID: "ipr_claude", modelID: "gwm_opus" };
const gptFastMedium = "__openwork_fast_v1/variant/medium";

function providerList(models: Record<string, Record<string, unknown>>): { all: ProviderListItem[] } {
  const provider = { id: claude.providerID, name: "OW Anthropic", env: [], models: Object.fromEntries(Object.entries(models)
    .map(([id, variants]) => [id, { id, name: "Claude Opus 5.5", variants }])) };
  // Only the fields useModelBehavior reads are relevant to this test.
  return { all: [provider] as unknown as ProviderListItem[] };
}

async function render(input: Parameters<typeof useModelBehavior>[0]) {
  let result: ReturnType<typeof useModelBehavior> | undefined;
  function Probe() { result = useModelBehavior(input); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<Probe />); });
  await act(async () => { root.unmount(); });
  if (!result) throw new Error("hook did not render");
  return result;
}

test("a global setting the default model does not offer is never sent (Variant unavailable)", async () => {
  const result = await render({ providerList: providerList({ [claude.modelID]: { low: {}, medium: {}, high: {} } }),
    defaultModel: claude, modelVariant: gptFastMedium });
  expect(result.modelVariantValue).toBeNull();
  expect(result.modelVariantLabel).not.toContain("__openwork_fast");
});

test("a global setting the default model offers is kept", async () => {
  const result = await render({ providerList: providerList({ [claude.modelID]: { low: {}, medium: {}, high: {} } }),
    defaultModel: claude, modelVariant: "medium" });
  expect(result.modelVariantValue).toBe("medium");
});

test("a saved setting is kept while the catalog has not listed the model yet", async () => {
  const result = await render({ providerList: undefined, defaultModel: claude, modelVariant: gptFastMedium });
  expect(result.modelVariantValue).toBe(gptFastMedium);
});
