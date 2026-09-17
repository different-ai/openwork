import { expect } from "vitest";
import { browserScript, spec, type Seed, type Target } from "@openwork/testkit";

async function repickComposer(seed: Seed) {
  const app = await seed.desktop({ name: "session-model-repick" });
  const otherWorkspacePath = seed.tmpPath("repick-other");
  const otherWorkspace = await seed.workspace(app, otherWorkspacePath, { create: true });
  const otherSession = await seed.session(app, { title: "Other workspace sentinel" });
  const workspacePath = seed.tmpPath("repick-current");
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  const sessions = await seed.sessions(app, ["Repick target", "Matching peer", "Archived sentinel", "Unrelated model sentinel"]);
  return { app, workspace, workspacePath, otherWorkspace, otherWorkspacePath, otherSession, sessions };
}

const test = spec.world(repickComposer, {
  timeout: 360_000,
  needs: { commands: ["pnpm", "bun"], placement: "local" },
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "Verify device-local composer selections in an isolated Electron profile without changing engine bindings.",
  },
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected fixture object");
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected fixture string");
  return value;
}

test("unavailable composer uses the ordinary model picker unless scoped repick is opted in", async ({ world, user, agent, probe, evidence }) => {
  const target = world.sessions[0];
  if (!target) throw new Error("Missing isolated target session");
  await agent.run("session.open", { sessionId: target.sessionId });
  await user.see("composer", { editable: true });
  const seeded = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
  const unavailable = record(seeded.unavailableModel);
  const available = record(seeded.availableModel);
  const initialPreferences = record(await probe.storage("openwork.preferences"));
  expect(record(initialPreferences.featureFlags).unavailableModelRepick).not.toBe(true);

  await user.click({ role: "button", label: "Change model" });
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
  expect(record(selections[target.sessionId]).model).not.toEqual(unavailable);
  expect(await probe.storage("openwork.preferences")).toEqual(initialPreferences);
  evidence.recordAssertionEvidence(
    "Unavailable sessions use the established picker by default",
    "A stale session opened the ordinary model picker with its existing unavailable-model guidance. Choosing its real catalog option replaced only that session's local selection; the experimental scoped dialog never appeared and preferences stayed unchanged.",
    true,
  );
});

test("opted-in scoped repick reproduces confirm-time failure for a busy target and an offline runtime", async ({ world, user, agent, probe, evidence }) => {
  const [busy, offline] = world.sessions;
  if (!busy || !offline) throw new Error("Missing isolated failure fixtures");
  await user.click({ testId: "account-status-menu" });
  await user.click("Settings");
  await user.click("Advanced");
  await user.click({ testId: "unavailable-model-repick-flag" });
  await user.click("Back to app");

  const fault = async (mode: "gate" | "offline" | "restore") => {
    await probe.eval(browserScript((inputMode) => {
      const key = "__openworkRepickOriginalFetch";
      const modeKey = "__openworkRepickStatusMode";
      if (inputMode === "restore") {
        const saved = Reflect.get(window, key);
        if (typeof saved === "function") Reflect.set(window, "fetch", saved);
        Reflect.deleteProperty(window, key);
        Reflect.deleteProperty(window, modeKey);
        return;
      }
      if (inputMode === "offline") {
        Reflect.set(window, modeKey, "offline");
        return;
      }
      const original = window.fetch.bind(window);
      Reflect.set(window, key, original);
      Reflect.set(window, modeKey, "pass");
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/session/status")) {
          return new Promise<Response>((resolve, reject) => window.setTimeout(() => {
            if (Reflect.get(window, modeKey) === "offline") reject(new Error("Fixture workspace runtime offline"));
            else resolve(original(input, init));
          }, 1_000));
        }
        return original(input, init);
      };
    }, [mode]));
  };
  const seed = async (sessionId: string) => {
    await agent.run("session.open", { sessionId });
    await user.see("composer", { editable: true });
    const result = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
    if (await probe.has("Eval Unavailable Model A is no longer available") || await probe.has("Eval Unavailable Model B is no longer available")) {
      await user.click({ role: "button", label: "Close" });
    }
    return result;
  };

  const busySeed = await seed(busy.sessionId);
  const busyAvailable = record(busySeed.availableModel);
  const busySelections = await probe.storage("openwork.sessionModels.v1");
  await agent.run("session.model_picker.open");
  await user.see({ text: /^Eval Unavailable Model [AB] is no longer available$/ });
  await user.click({ role: "combobox", label: "Models" });
  await user.click({ role: "option", label: `${string(busyAvailable.title)} (${string(busyAvailable.providerName)})` });
  await user.see({ role: "button", label: "Save for 1 session" });
  await fault("gate");
  await user.click({ role: "button", label: "Save for 1 session" });
  await agent.run("eval.session_sidebar.seed_active");
  await user.see("Could not save this selection. Check the refreshed models, then try again.");
  expect(await probe.storage("openwork.sessionModels.v1")).toEqual(busySelections);
  await user.screenshot();
  await fault("restore");
  await user.click({ role: "button", label: "Close" });
  await user.notSee({ text: /^Eval Unavailable Model [AB] is no longer available$/ });

  const offlineSeed = await seed(offline.sessionId);
  const offlineAvailable = record(offlineSeed.availableModel);
  const offlineSelections = await probe.storage("openwork.sessionModels.v1");
  await agent.run("session.model_picker.open");
  await user.see({ text: /^Eval Unavailable Model [AB] is no longer available$/ });
  await user.click({ role: "combobox", label: "Models" });
  await user.click({ role: "option", label: `${string(offlineAvailable.title)} (${string(offlineAvailable.providerName)})` });
  await user.see({ role: "button", label: "Save for 1 session" });
  await fault("gate");
  await user.click({ role: "button", label: "Save for 1 session" });
  await fault("offline");
  await user.see("Could not save this selection. Check the refreshed models, then try again.");
  expect(await probe.storage("openwork.sessionModels.v1")).toEqual(offlineSelections);
  await user.screenshot();
  await fault("restore");
  evidence.recordAssertionEvidence(
    "Opted-in scoped replacement fails closed when busy or offline state begins after preview",
    "Both targets first reached an enabled Save action. A synthetic busy activity state and an offline authoritative-status request then began before confirmation; each reproduced the generic save failure and changed no local session selection.",
    true,
  );
});

test("bulk repick refreshes and requires reconfirmation when matching membership grows", async ({ world, user, agent, probe, evidence }) => {
  const [target, peer, newlyMatching] = world.sessions;
  if (!target || !peer || !newlyMatching) throw new Error("Missing isolated target-set fixtures");
  await user.click({ testId: "account-status-menu" });
  await user.click("Settings");
  await user.click("Advanced");
  await user.click({ testId: "unavailable-model-repick-flag" });
  await user.click("Back to app");

  const dismissRepick = async () => {
    if (await probe.has("Eval Unavailable Model A is no longer available") || await probe.has("Eval Unavailable Model B is no longer available")) {
      await user.click({ role: "button", label: "Close" });
    }
  };
  const seed = async (sessionId: string) => {
    await dismissRepick();
    await agent.run("session.open", { sessionId });
    await user.see("composer", { editable: true });
    const result = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
    await dismissRepick();
    return result;
  };

  const targetSeed = await seed(target.sessionId);
  const unavailable = record(targetSeed.unavailableModel);
  const available = record(targetSeed.availableModel);
  for (const session of [peer, newlyMatching]) {
    let result = await seed(session.sessionId);
    if (record(result.unavailableModel).modelID !== unavailable.modelID) result = await seed(session.sessionId);
    expect(result.unavailableModel).toEqual(unavailable);
  }
  await agent.run("session.archive", { sessionId: newlyMatching.sessionId, archived: true });
  await agent.run("session.open", { sessionId: target.sessionId });
  await agent.run("session.model_picker.open");
  await user.click({ role: "combobox", label: "Models" });
  await user.click({ role: "option", label: `${string(available.title)} (${string(available.providerName)})` });
  await user.click({ text: "All 2 matching sessions in this workspace (unarchived)" });
  await user.see({ role: "button", label: "Save for 2 sessions" });
  const before = await probe.storage("openwork.sessionModels.v1");

  await agent.run("session.archive", { sessionId: newlyMatching.sessionId, archived: false });
  await user.click({ role: "button", label: "Save for 2 sessions" });
  await user.see("Matching sessions changed from 2 to 3. Review the refreshed list, then confirm again.");
  await user.notSee("Could not save this selection. Check the refreshed models, then try again.");
  await user.see("All 3 matching sessions in this workspace (unarchived)");
  await user.see({ role: "button", label: "Save for 3 sessions" });
  expect((await probe.dom('[role="dialog"] li')).elements.map((element) => element.text).sort()).toEqual(
    [target.title, peer.title, newlyMatching.title].sort(),
  );
  expect(await probe.storage("openwork.sessionModels.v1")).toEqual(before);
  await user.screenshot();

  await user.click({ role: "button", label: "Save for 3 sessions" });
  await user.see({ text: /Saved for next send/ });
  const replacement = { providerID: string(available.providerID), modelID: string(available.modelID) };
  const selections = record(await probe.storage("openwork.sessionModels.v1"));
  for (const session of [target, peer, newlyMatching]) {
    expect(record(selections[session.sessionId])).toEqual({ model: replacement, variant: null });
  }
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "Changed bulk membership refreshes without silently adding targets",
    "The confirmed set grew from two to three after preview. The first save wrote nothing, displayed the refreshed three-session scope and required a second explicit confirmation before applying the local next-send choice to all three.",
    true,
  );
});

test("unavailable composer repick defaults to this session, previews all, and saves only confirmed local scope without sending", async ({ world, user, agent, probe, step, evidence }) => {
  const [target, peer, archived, unrelated] = world.sessions;
  if (!target || !peer || !archived || !unrelated) throw new Error("Missing isolated session fixtures");
  const missing = { providerID: "lpr_eval-unavailable-provider", modelID: "eval-unavailable-model-a" };
  const owners = [
    ...world.sessions.map((session) => ({ ...session, workspaceId: world.workspace.workspaceId })),
    { ...world.otherSession, workspaceId: world.otherWorkspace.workspaceId },
  ];
  const repickTitle = { text: /^Eval Unavailable Model [AB] is no longer available$/ };
  await user.click({ testId: "account-status-menu" });
  await user.click("Settings");
  await user.click("Advanced");
  await user.see({ testId: "unavailable-model-repick-flag", label: "Show scoped replacement dialog" });
  await user.screenshot();
  await user.click({ testId: "unavailable-model-repick-flag" });
  expect(await probe.eventually(() => probe.storage("openwork.preferences", (value) => (
    typeof value === "object" && value !== null
      && typeof Reflect.get(value, "featureFlags") === "object"
      && Reflect.get(Reflect.get(value, "featureFlags"), "unavailableModelRepick") === true
  )), { within: 5_000, label: "scoped replacement flag enabled" })).toBe(true);
  await user.click("Back to app");
  const dismissRepick = async () => {
    if (await probe.has("Eval Unavailable Model A is no longer available") || await probe.has("Eval Unavailable Model B is no longer available")) {
      await user.click({ role: "button", label: "Close" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await user.notSee(repickTitle);
    }
  };
  const open = async (sessionId: string) => {
    await dismissRepick();
    await agent.run("session.open", { sessionId });
    await user.see("composer", { editable: true });
  };
  const seedUnavailable = async () => {
    const result = record(await agent.run("eval.model_not_available.seed", { scope: "both" }));
    await dismissRepick();
    return result;
  };
  const seedMissing = async (sessionId: string) => {
    await open(sessionId);
    let result = await seedUnavailable();
    if (record(result.unavailableModel).modelID !== missing.modelID) {
      result = await seedUnavailable();
    }
    expect(result.unavailableModel).toEqual(missing);
    expect(result.sessionId).toBe(sessionId);
    return record(result.availableModel);
  };
  const draft = "Keep this draft; replacing a model must not send it.";
  await open(target.sessionId);
  await user.type("composer", draft);
  await seedMissing(world.otherSession.sessionId);
  await seedMissing(archived.sessionId);
  await agent.run("session.archive", { sessionId: archived.sessionId, archived: true });
  await seedMissing(peer.sessionId);
  await open(unrelated.sessionId);
  const unrelatedSeed = await seedUnavailable();
  expect(unrelatedSeed.sessionId).toBe(unrelated.sessionId);
  expect(unrelatedSeed.unavailableModel).not.toEqual(missing);
  const available = await seedMissing(target.sessionId);
  const replacement = { providerID: string(available.providerID), modelID: string(available.modelID) };
  const initialSelections = record(await probe.storage("openwork.sessionModels.v1"));
  for (const session of [target, peer, archived, world.otherSession]) {
    expect(record(initialSelections[session.sessionId]).model).toEqual(missing);
  }
  expect(record(initialSelections[unrelated.sessionId]).model).toEqual(unrelatedSeed.unavailableModel);
  const initialPreferences = await probe.storage("openwork.preferences");
  const initialDefault = await probe.storage("openwork.defaultModel");
  const facts = async () => {
    const result = [];
    for (const owner of owners) {
      const prefix = `/workspace/${owner.workspaceId}/opencode/session/${owner.sessionId}`;
      const session = await probe.desktopApi(prefix);
      const transcript = await probe.desktopApi(`${prefix}/message`);
      expect(session.status).toBe(200);
      expect(record(session.body).id).toBe(owner.sessionId);
      expect(transcript.status).toBe(200);
      result.push({ sessionId: owner.sessionId, session: session.body, transcript: transcript.body });
    }
    return result;
  };
  const initialFacts = await facts();
  for (const fact of initialFacts) {
    expect(fact.transcript).toEqual([]);
    const archivedAt = record(record(fact.session).time).archived;
    if (fact.sessionId === archived.sessionId) expect(archivedAt).toBeGreaterThan(0);
    else expect(archivedAt ?? 0).toBe(0);
  }
  evidence.recordAssertionEvidence("Isolated engine session identities are readable", JSON.stringify({
    workspacePath: world.workspacePath,
    otherWorkspacePath: world.otherWorkspacePath,
    sessions: initialFacts.map((fact) => ({ sessionId: fact.sessionId, directory: record(fact.session).directory })),
  }), true);
  const choose = async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.see(repickTitle);
    await user.click({ role: "combobox", label: "Models" });
    await user.click({ role: "option", label: `${string(available.title)} (${string(available.providerName)})` });
    await user.see({ role: "combobox", label: "Models" }, { text: string(available.title) });
  };
  const confirm = (count: number): Target => ({ role: "button", label: `Save for ${count} session${count === 1 ? "" : "s"}` });
  const all = (count: number) => ({ text: `All ${count} matching session${count === 1 ? "" : "s"} in this workspace (unarchived)` });
  const checkUnchanged = async () => {
    expect(await probe.storage("openwork.preferences")).toEqual(initialPreferences);
    expect(await probe.storage("openwork.defaultModel")).toEqual(initialDefault);
    expect(await facts()).toEqual(initialFacts);
    await user.see("composer", { text: draft });
  };

  await step("opening unavailable session and previewing scopes never changes selection or sends", async () => {
    await open(peer.sessionId);
    await open(target.sessionId);
    await agent.run("session.model_picker.open");
    await user.see(repickTitle);
    await user.see("composer", { text: draft });
    await user.screenshot();
    await user.click({ role: "combobox", label: "Models" });
    await user.click({ role: "option", label: `${string(available.title)} (${string(available.providerName)})` });
    await user.see({ role: "combobox", label: "Models" }, { text: string(available.title) });
    await user.see(confirm(1));
    expect((await probe.dom('[role="dialog"] label:has([role="radio"][aria-checked="true"])')).elements.map((element) => element.text)).toEqual(["This session only"]);
    expect(await probe.storage("openwork.sessionModels.v1")).toEqual(initialSelections);
    await checkUnchanged();
    evidence.recordAssertionEvidence("Choosing a real replacement option does not send or persist it", "The real Models combobox displayed the clicked option and This session only was the sole checked scope. Every local override, default, engine session and transcript stayed unchanged, and the target draft remained intact before confirmation.", true);
    try {
      await user.see(all(2));
    } catch (cause) {
      const dialog = (await probe.dom('[role="dialog"]')).elements.map((element) => element.text);
      const directories = initialFacts.map((fact) => ({ sessionId: fact.sessionId, directory: record(fact.session).directory }));
      evidence.recordAssertionEvidence("Bulk preview contains both matching unarchived sessions", JSON.stringify({ dialog, workspacePath: world.workspacePath, directories }), false);
      throw new Error(`Bulk preview must contain target and peer. ${JSON.stringify({ dialog, workspacePath: world.workspacePath, directories })}`, { cause });
    }
    await user.screenshot();
    await user.reload();
    await choose();
    await user.click(all(2));
    await user.see(confirm(2));
    const preview = (await probe.dom('[role="dialog"] li')).elements.map((element) => element.text);
    expect(preview.sort()).toEqual([target.title, peer.title].sort());
    expect(preview).not.toContain(archived.title);
    expect(preview).not.toContain(unrelated.title);
    expect(preview).not.toContain(world.otherSession.title);
    expect(await probe.storage("openwork.sessionModels.v1")).toEqual(initialSelections);
    await checkUnchanged();
    await user.screenshot();
    await user.click({ text: "This session only" });
    await user.see(confirm(1));
  });

  await step("confirming this session persists only its selected override, not defaults or engine state", async () => {
    await user.click(confirm(1));
    await user.see({ text: /Saved for next send/ });
    const expected = { ...initialSelections, [target.sessionId]: { model: replacement, variant: null } };
    expect(await probe.storage("openwork.sessionModels.v1")).toEqual(expected);
    await user.click({ role: "button", label: "Close" });
    await checkUnchanged();
    await user.reload();
    await user.see("composer", { editable: true, text: draft });
    expect(await probe.storage("openwork.sessionModels.v1")).toEqual(expected);
    await checkUnchanged();
    await user.screenshot();
    evidence.recordAssertionEvidence("Single-session repick is explicit and device-local", "The real composer preview listed only two matching unarchived sessions. Confirming the default scope changed only the target override; the draft, engine sessions, transcripts and defaults remained unchanged after reload.", true);
  });

  await step("confirming all applies one replacement to two matching sessions and excludes sentinels", async () => {
    // Recreate the original unavailable local choice after proving single-scope
    // persistence, so this separate bulk action must update two sessions.
    await seedMissing(target.sessionId);
    await open(peer.sessionId);
    await choose();
    await user.see(confirm(1));
    await user.see(all(2));
    expect((await probe.dom('[role="dialog"] li')).elements).toEqual([]);
    await user.click(all(2));
    expect((await probe.dom('[role="dialog"] li')).elements.map((element) => element.text).sort()).toEqual([peer.title, target.title].sort());
    await user.click(confirm(2));
    await user.see({ text: /Saved for next send/ });
    expect(await probe.storage("openwork.sessionModels.v1")).toEqual({
      ...initialSelections,
      [target.sessionId]: { model: replacement, variant: null },
      [peer.sessionId]: { model: replacement, variant: null },
    });
    await user.click({ role: "button", label: "Close" });
    await open(target.sessionId);
    await checkUnchanged();
    evidence.recordAssertionEvidence("All-scope repick excludes archived, unrelated-model and other-workspace sessions", "Explicit all-scope confirmation changed both matching sessions (target and peer) in one UI action. Every engine session and transcript stayed identical; archived, unrelated-model and other-workspace local overrides and defaults were preserved, with no prompt sent.", true);
  });
});
