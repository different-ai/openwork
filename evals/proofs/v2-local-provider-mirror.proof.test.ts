import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { v2LocalProviderMirror } from "../worlds/v2-local-provider-mirror.ts";

const test = spec.world(v2LocalProviderMirror, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

const WITHIN = 60_000;

test("an owner's OpenRouter and Anthropic keys reach the new engine's model picker and AI Providers, which stays honest about sign-ins and Acme's provider rule", async ({ world, user, probe, step, evidence }) => {
  const pickerModels = async (providerId: string) => (await probe.dom(`[data-testid="composer-model-picker"] [data-model-key^="${providerId}:"]`)).elements.length;
  const row = async (providerId: string) => (await probe.dom(`[data-testid="local-provider-${providerId}"]`)).elements.map(element => element.text).join(" ");

  /** Open the chat's model picker and search it; opening it also asks the desktop to refresh providers. */
  async function searchPicker(query: string) {
    await user.navigate(world.composerUrl);
    await user.see("composer", { editable: true, timeoutMs: WITHIN });
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    await user.type({ label: "Search all models" }, query);
  }

  /** Reopen the picker until it agrees with `until`, as a person would after a change. */
  async function pickerUntil(label: string, until: (count: number) => boolean, provider = { id: "openrouter", name: "OpenRouter" }) {
    return probe.eventually(async () => {
      await searchPicker(provider.name);
      const count = await pickerModels(provider.id);
      if (!until(count)) await user.press("Escape");
      return count;
    }, { within: 120_000, label, until });
  }

  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  /** Settings › AI Providers › Connect a provider, paste a key, Save key: the path a person takes. */
  async function connectProvider(name: string, key: string) {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, name);
    await user.click({ role: "button", label: new RegExp(`^${name}`) });
    await user.type({ label: "API key" }, key);
    await user.click({ role: "button", label: "Save key" });
    await user.notSee({ role: "button", label: "Save key" }, { timeoutMs: WITHIN });
  }
  const connectOpenRouter = () => connectProvider("OpenRouter", world.openRouterKey);
  const engineStatus = async () => {
    const status = await probe.desktopApi("/experimental/engine-v2-preview/status");
    const body = typeof status.body === "object" && status.body !== null ? status.body : {};
    return {
      mirrored: "mirroredProviderIds" in body ? JSON.stringify(body.mirroredProviderIds) : "[]",
      skipped: "skippedProviderIds" in body ? JSON.stringify(body.skippedProviderIds) : "[]",
      reasons: "skippedProviders" in body ? JSON.stringify(body.skippedProviders) : "none",
    };
  };

  await step("without a rollout override, connecting OpenRouter reads Ready to use in AI Providers", async () => {
    await connectOpenRouter();
    const text = await probe.eventually(() => row("openrouter"), { within: WITHIN, label: "the OpenRouter row", until: value => value.includes("Ready to use") });
    const status = await engineStatus();
    expect(status.mirrored).toContain('"openrouter"');
    evidence.recordAssertionEvidence("AI Providers and the engine agree the key is ready", `${text}; engine mirrored ${status.mirrored}`, text.includes("Ready to use") && status.mirrored.includes('"openrouter"'));
    await user.screenshot();
  });

  await step("OpenRouter's models are in the new engine's model picker", async () => {
    const count = await pickerUntil("OpenRouter models in the picker", value => value > 0);
    expect(count).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The same key now lists OpenRouter's models on the new engine", `${count} OpenRouter models match "OpenRouter"`, count > 0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("a second key, Anthropic, is listed in AI Providers next to OpenRouter right after it is saved", async () => {
    await connectProvider("Anthropic", world.anthropicKey);
    await user.see({ testId: "local-provider-openrouter" }, { timeoutMs: WITHIN });
    // As a person does: no reload, no restart. A short wait covers rendering, not a later refresh.
    const anthropic = await probe.eventually(() => row("anthropic"), { within: 20_000, label: "the Anthropic row right after saving its key", until: value => value.includes("Ready to use") });
    const openRouter = await row("openrouter");
    const status = await engineStatus();
    expect(status.mirrored).toContain('"anthropic"');
    expect(anthropic).toContain("Ready to use");
    expect(openRouter).toContain("Ready to use");
    evidence.recordAssertionEvidence("Both providers added on this computer are listed as ready", `Anthropic: ${anthropic || "missing"} | OpenRouter: ${openRouter || "missing"} | engine mirrored ${status.mirrored}`, anthropic.includes("Ready to use") && openRouter.includes("Ready to use"));
    await user.screenshot();
  });

  await step("Anthropic's models are in the picker too", async () => {
    const count = await pickerUntil("Anthropic models in the picker", value => value > 0, { id: "anthropic", name: "Anthropic" });
    expect(count).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The second key lists its models on the new engine", `${count} Anthropic models match "Anthropic"`, count > 0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("a ChatGPT sign-in the new engine cannot use yet says so instead of Ready to use", async () => {
    await world.signInWithChatGpt();
    await user.navigate(world.settingsUrl);
    await user.see({ testId: "local-provider-openai" }, { timeoutMs: WITHIN });
    const text = await probe.eventually(() => row("openai"), { within: WITHIN, label: "the OpenAI row's state", until: value => value.includes("Not available on the new engine yet") });
    expect(text).not.toContain("Ready to use");
    const openRouter = await probe.eventually(() => row("openrouter"), { within: WITHIN, label: "the OpenRouter row's state", until: value => value.includes("Ready to use") });
    const { reasons } = await engineStatus();
    expect(reasons).toContain('{"id":"openai","reason":"oauth"}');
    evidence.recordAssertionEvidence("The sign-in is neutral and not ready; the OpenRouter key stays ready", `OpenAI: ${text} | OpenRouter: ${openRouter} | engine skipped: ${reasons}`, !text.includes("Ready to use") && openRouter.includes("Ready to use"));
    await user.screenshot();
  });

  await step("when Acme allows only its own providers, OpenRouter leaves the picker", async () => {
    await world.allowPersonalProviders(false);
    await user.reload();
    const count = await pickerUntil("OpenRouter gone from the picker", value => value === 0);
    expect(count).toBe(0);
    evidence.recordAssertionEvidence("The personal key no longer reaches the new engine", `${count} OpenRouter models listed`, count === 0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("AI Providers keeps the OpenRouter row with a lock that names who manages providers", async () => {
    await user.navigate(world.settingsUrl);
    const text = await probe.eventually(() => row("openrouter"), {
      within: WITHIN, label: "the locked OpenRouter row", until: value => value.includes(`${world.organizationName} manages AI providers`),
    });
    await user.see({ text: "Provider connections are managed by your organization administrator." });
    const locked = (await probe.dom('[data-testid="local-provider-openrouter"] svg.lucide-lock')).elements.length === 1;
    const connectLocked = (await probe.dom('button[disabled]:has(svg.lucide-lock)')).elements.some(element => element.text.includes("Connect a provider"));
    const { reasons } = await engineStatus();
    expect(text).not.toContain("Ready to use");
    expect(locked).toBe(true);
    expect(connectLocked).toBe(true);
    expect(reasons).toContain('{"id":"openrouter","reason":"policy"}');
    evidence.recordAssertionEvidence("Blocked, not missing: the row stays with a lock and the owner's name, and Connect a provider is locked", `${text}; lock=${locked}; Connect a provider locked=${connectLocked}; engine skipped ${reasons}`, locked && connectLocked);
    await user.screenshot();
  });

  await step("allowing personal providers again restores the saved key without reconnecting it", async () => {
    await world.allowPersonalProviders(true);
    await user.reload();
    const count = await pickerUntil("OpenRouter restored in the picker", value => value > 0);
    expect(count).toBeGreaterThan(0);
    await user.press("Escape");
    await user.navigate(world.settingsUrl);
    const text = await probe.eventually(() => row("openrouter"), {
      within: WITHIN, label: "the restored OpenRouter row", until: value => value.includes("Ready to use"),
    });
    evidence.recordAssertionEvidence("Policy refresh restores the saved key without another connection", `${count} OpenRouter models; ${text}`, count > 0 && text.includes("Ready to use"));
    await user.screenshot();
  });
});
