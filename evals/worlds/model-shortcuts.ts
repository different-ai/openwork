import { browserScript, reload } from "@openwork/cdp";
import { CATALOG_FAST_VARIANT } from "@openwork/types/cloud-model-fast";
import { resolveEvalEngine, type Seed } from "@openwork/env";

import { configureProvider } from "./chat.ts";

/**
 * One workspace with three real catalog models behind a synthetic provider:
 * - "Fast witness" offers reasoning levels and Fast,
 * - "Reasoning witness" offers reasoning levels but no Fast,
 * - "Standard witness" offers neither.
 * The member also has a key saved earlier for "Retired witness", a model this
 * workspace no longer offers, so the failure path is real catalog state.
 */
export async function modelShortcutsWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  const providerId = "effort-witness";
  const modelId = "reasoning-model";
  const fastProviderId = "fast-witness";
  const fastModelId = "gpt-5.4";
  const mock = seed.mock({ isolatedProcessEnv: true });
  const workspacePath = seed.tmpPath("model-shortcuts");
  const app = await seed.appWeb({ name: "model-shortcuts", workspacePath, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing model shortcut provider witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, { provider: {
    [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Effort witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-effort-key" },
      models: {
        [modelId]: { name: "Reasoning witness", reasoning: true, variants: {
          low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" },
        } },
        standard: { name: "Standard witness", reasoning: false },
      },
    },
    [fastProviderId]: {
      npm: "@ai-sdk/openai", name: "Fast witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-fast-key" },
      models: { [fastModelId]: { name: "Fast witness", reasoning: true, variants: {
        high: { reasoningEffort: "high" },
        [CATALOG_FAST_VARIANT]: { disabled: true, openworkNativeFast: 1 },
      } } },
    },
  } }, engine);
  const session = await seed.session(app, { title: "Model shortcuts" });
  const retired = {
    id: "sc_retired",
    keys: "Mod+Alt+9",
    action: {
      type: "model.switch", providerID: providerId, modelID: "retired-model", effort: null, fast: false,
      modelTitle: "Retired witness", providerName: "Effort witness",
    },
  };
  await seed.evalIn(app, browserScript((stored) => {
    localStorage.setItem("openwork.shortcuts.v1", stored);
  }, [JSON.stringify({ version: 1, shortcuts: [retired] })]));
  await reload(app);
  // The chord a person presses depends on the OS: Cmd on macOS, Ctrl elsewhere.
  const mac = await seed.evalIn(app, () => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  return {
    app, engine, workspace, session, providerId, modelId, fastProviderId, fastModelId,
    /** Primary modifier for key presses on this platform. */
    mod: mac ? "Meta" : "Control",
    /** How the app labels Mod+Alt+n on this platform. */
    chord: (digit: number) => (mac ? `⌥⌘${digit}` : `Ctrl+Alt+${digit}`),
  };
}
