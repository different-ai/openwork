import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotWorkspace } from "../worlds/workbot-workspace.ts";

const test = spec.world(workbotWorkspace, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("pending identity verification masks retained drafts and portals before the account response arrives", async ({ world, user, probe, step, evidence }) => {
  let completedReads = 0;
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: the original owner has an unsaved draft and a visible navigation portal", async () => {
    await user.navigate(`${world.url}documents`);
    await user.click({ role: "button", label: "Project brief.txt", nth: 0 });
    await user.click({ role: "button", label: /^Edit$/ });
    await user.type({ role: "textbox", label: "Document text" }, "Private draft during identity verification", { replace: true });
    await user.click({ role: "button", label: "Open workspace navigation" });
    await user.see({ role: "button", label: "Open Project brief.txt" });
    completedReads = world.identityReads().length;
    evidence.recordAssertionEvidence("The retained owner and its portal contain real local work", "An editable unsaved draft and its filename are visible before the session changes", (await probe.dom('[role="dialog"]')).elements.length === 1 && world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("a held identity response masks both surfaces before the new account is known", async () => {
    world.holdIdentity();
    world.useOtherIdentity();
    await world.reconnectAfterStaleMinute();
    await probe.eventually(() => world.pendingIdentities(), { within: 5000, label: "the real identity request is held before its response", until: count => count > 0 });
    await user.see({ text: "Checking sign-in. Retained documents are locked." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.notSee({ role: "button", label: "Open Project brief.txt" });
    await user.notSee({ text: "Project brief.txt" });
    expect(world.identityReads()).toHaveLength(completedReads);
    // Authorization masking removes editable controls, not the stateful editor owner.
    expect((await probe.dom('[data-workbot-retained-owner][hidden] .ow-document-editor')).elements).toHaveLength(1);
    expect((await probe.dom('[inert] [role="dialog"]')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Cached success cannot authorize a pending identity read", `Held identity requests=${world.pendingIdentities()}; completed reads remain ${completedReads}; editor and inert portal stay mounted but masked; writes=${world.documentWrites().length}`, world.pendingIdentities() > 0 && world.identityReads().length === completedReads && world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("after: the different account response keeps the previous owner locked", async () => {
    world.releaseIdentity();
    await user.see({ text: "The signed-in account or workspace changed. Retained documents are locked." });
    await user.notSee({ role: "textbox", label: "Document text" });
    await user.notSee({ role: "button", label: "Open Project brief.txt" });
    evidence.recordAssertionEvidence("Resolving another account never adopts the original draft", "The response names the other account, but neither its cached metadata nor draft is revealed", world.identityScopes().some(value => value.principalId === "user_other" && value.status === 200) && world.documentWrites().length === 0);
    await user.screenshot();
  });
  await step("the original owner restores the same draft only through fresh identity and file checks", async () => {
    world.restoreIdentity();
    await user.click({ role: "button", label: "Check sign-in" });
    await user.see({ role: "button", label: "Close workspace navigation" });
    await user.click({ role: "button", label: "Close workspace navigation" });
    await probe.eventually(() => probe.dom('[role="dialog"]'), { within: 5000, label: "the original retained portal closes normally after verification", until: layout => layout.elements.length === 0 });
    await user.click({ role: "button", label: "Check access and restore tabs" });
    await user.click({ role: "button", label: "Project brief.txt, unsaved changes" });
    await user.see({ role: "textbox", label: "Document text" }, { value: "Private draft during identity verification" });
    evidence.recordAssertionEvidence("Pending verification retains work without an implicit save", "The exact draft returns as unsaved after explicit checks; writes remain zero", world.documentWrites().length === 0);
    await user.screenshot();
  });
});
