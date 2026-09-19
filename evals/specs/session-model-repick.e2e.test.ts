import { expect } from "vitest";
import { browserScript, spec, type Seed } from "@openwork/testkit";

async function repickWorld(seed: Seed) {
  const app = await seed.desktop({ name: "session-model-repick" });
  const workspace = await seed.workspace(app, seed.tmpPath("session-model-repick"), { create: true });
  const sessions = await seed.sessions(app, ["Repick target", "Remembered peer", "Fresh session", "Later match"]);
  return { app, workspace, sessions };
}

const test = spec.world(repickWorld, {
  timeout: 360_000,
  needs: { commands: ["pnpm", "bun"], placement: "local" },
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "Verify device-local model memory and the opt-in scoped replacement dialog in an isolated Electron profile.",
  },
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected string");
  return value;
}

test("the default picker advances the shared default while another session keeps its remembered model", async ({ world, user, agent, probe, evidence }) => {
  const [target, remembered] = world.sessions;
  if (!target || !remembered) throw new Error("Missing isolated sessions");
  const open = async (sessionId: string) => {
    await agent.run("session.open", { sessionId });
    await user.see("composer", { editable: true });
  };
  await open(remembered.sessionId);
  const rememberedSeed = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
  const rememberedSelection = record(record(await probe.storage("openwork.sessionModels.v1"))[remembered.sessionId]);

  await open(target.sessionId);
  const targetSeed = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
  const available = record(targetSeed.availableModel);
  const preferences = record(await probe.storage("openwork.preferences"));
  expect(record(preferences.featureFlags).unavailableModelRepick).not.toBe(true);

  await agent.run("session.model_picker.open");
  await user.see({ role: "heading", label: "Models" });
  await user.notSee({ text: /is no longer available$/ });
  await user.screenshot();
  await user.click({ text: string(available.providerName) });
  await user.click({ text: string(available.title) });

  const selections = record(await probe.storage("openwork.sessionModels.v1"));
  expect(record(selections[target.sessionId]).model).toEqual({
    providerID: string(available.providerID),
    modelID: string(available.modelID),
  });
  expect(record(selections[remembered.sessionId])).toEqual(rememberedSelection);
  expect(record(selections[remembered.sessionId]).model).toEqual(record(rememberedSeed.unavailableModel));
  expect(await probe.storage("openwork.defaultModel")).toBe(`${string(available.providerID)}/${string(available.modelID)}`);

  await user.click({ role: "button", label: "New session" });
  await user.see("composer", { editable: true });
  expect(await probe.eventually(() => probe.eval(browserScript((title) => (
    document.querySelector<HTMLButtonElement>('button[aria-label="Change model"]')?.textContent?.includes(title) === true
  ), [string(available.title)])), { within: 30_000, label: "fresh session inherits shared model" })).toBe(true);
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "The default-off picker preserves per-session memory while advancing the shared default",
    "The ordinary Models picker appeared because scoped replacement was not enabled. Its choice updated the target and shared default, a separate remembered session retained its unavailable provider/model ids, and a fresh unbound session displayed the new shared model.",
    true,
  );
});

test("the opted-in scoped dialog refreshes exact bulk membership and requires reconfirmation", async ({ world, user, agent, probe, evidence }) => {
  const [target, peer, , later] = world.sessions;
  if (!target || !peer || !later) throw new Error("Missing isolated sessions");
  await user.click({ testId: "account-status-menu" });
  await user.click("Settings");
  await user.click("Advanced");
  await user.see({ testId: "unavailable-model-repick-flag", label: "Show scoped replacement dialog" });
  await user.click({ testId: "unavailable-model-repick-flag" });
  expect(await probe.eventually(() => probe.storage("openwork.preferences", (value) => (
    typeof value === "object" && value !== null
      && typeof Reflect.get(value, "featureFlags") === "object"
      && Reflect.get(Reflect.get(value, "featureFlags"), "unavailableModelRepick") === true
  )), { within: 5_000, label: "scoped replacement flag enabled" })).toBe(true);
  await user.screenshot();
  await user.click("Back to app");

  const closeRepick = async () => {
    if (await probe.has("Eval Unavailable Model A is no longer available") || await probe.has("Eval Unavailable Model B is no longer available")) {
      await user.click({ role: "button", label: "Close" });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const seedUnavailable = async (sessionId: string) => {
    await closeRepick();
    await agent.run("session.open", { sessionId });
    await user.see("composer", { editable: true });
    const result = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
    await closeRepick();
    return result;
  };

  const targetSeed = await seedUnavailable(target.sessionId);
  const unavailable = record(targetSeed.unavailableModel);
  const available = record(targetSeed.availableModel);
  for (const session of [peer, later]) {
    let seeded = await seedUnavailable(session.sessionId);
    if (record(seeded.unavailableModel).modelID !== unavailable.modelID) seeded = await seedUnavailable(session.sessionId);
    expect(seeded.unavailableModel).toEqual(unavailable);
  }
  await agent.run("session.archive", { sessionId: later.sessionId, archived: true });
  await agent.run("session.open", { sessionId: target.sessionId });
  await agent.run("session.model_picker.open");
  await user.see({ text: /^Eval Unavailable Model [AB] is no longer available$/ });
  await user.click({ role: "combobox", label: "Models" });
  await user.click({ role: "option", label: `${string(available.title)} (${string(available.providerName)})` });
  await user.click({ text: "All 2 matching sessions in this workspace (unarchived)" });
  await user.see({ role: "button", label: "Save for 2 sessions" });
  const before = await probe.storage("openwork.sessionModels.v1");

  await agent.run("session.archive", { sessionId: later.sessionId, archived: false });
  await user.click({ role: "button", label: "Save for 2 sessions" });
  await user.see("Matching sessions changed from 2 to 3. Review the refreshed list, then confirm again.");
  await user.see({ role: "button", label: "Save for 3 sessions" });
  expect(await probe.storage("openwork.sessionModels.v1")).toEqual(before);
  expect((await probe.dom('[role="dialog"] li')).elements.map((element) => element.text).sort()).toEqual(
    [target.title, peer.title, later.title].sort(),
  );
  await user.screenshot();

  await user.click({ role: "button", label: "Save for 3 sessions" });
  await user.see({ text: /Saved for next send/ });
  const replacement = { providerID: string(available.providerID), modelID: string(available.modelID) };
  const selections = record(await probe.storage("openwork.sessionModels.v1"));
  for (const session of [target, peer, later]) {
    expect(record(selections[session.sessionId])).toEqual({ model: replacement, variant: null });
  }
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "Exact bulk scope drift is visible and cannot write before reconfirmation",
    "After the confirmed scope grew from two unarchived matches to three, the first save changed no local selections and displayed the refreshed identities. Only a second explicit confirmation saved the next-send replacement for those three sessions.",
    true,
  );
});
