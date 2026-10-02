import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { skillEditorReauth } from "../worlds/skill-editor-reauth.ts";

const test = spec.world(skillEditorReauth, { timeout: 420_000 });
const draft = "Keep these synthetic unsaved instructions.";

test("skill edits survive blocked reauthentication and save once after verification", async ({ world, user, probe, evidence }) => {
  await user.see({ text: "Edit synthetic-recovery" }, { timeoutMs: 90_000 });
  await user.type({ placeholder: "# Instructions\\n\\nDescribe the complete workflow..." }, draft, { replace: true });
  await world.expire();
  await user.click("Save changes");
  await user.see("Continue with Google", { timeoutMs: 20_000 });
  await user.click("Continue with Google");
  await user.see({ text: "OpenWork could not open the sign-in window. Allow popups for OpenWork, then try again." });
  await world.duplicateSubmit();
  expect(await world.snapshot()).toEqual({ attempts: 1, writes: 0, verified: false, popupAttempts: 1, body: draft });
  await user.screenshot();
  evidence.recordAssertionEvidence("Blocked popup offers recovery, preserves the draft, and does not retry or duplicate the save", "Dialog offers allow-popups guidance; draft retained; one rejected attempt and zero writes", true);

  await user.click("Close security check");
  expect(await world.snapshot()).toEqual({ attempts: 1, writes: 0, verified: false, popupAttempts: 1, body: draft });
  await user.click("Save changes");
  await user.see("Verify password", { timeoutMs: 20_000 });
  await user.type({ label: "Password" }, world.den.admin.password, { replace: true });
  await user.click("Verify password");
  await user.see({ text: "Complete skill body" }, { timeoutMs: 30_000 });
  await user.see({ text: draft });
  const snapshot = await world.snapshot();
  expect(snapshot).toMatchObject({ attempts: 3, writes: 1, verified: true });
  const persisted = await probe.api(world.den.admin, `/v1/config-objects/${world.skillId}`);
  expect(JSON.stringify(persisted.body)).toContain(draft);
  evidence.recordAssertionEvidence("After cancel and explicit retry, password verification resumes the saved draft exactly once", "Two rejected attempts, one successful write; persisted skill contains the edited body", true);
  await user.screenshot();
});
