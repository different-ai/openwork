import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { initialAdminSetup } from "../worlds/initial-admin-setup.ts";

// No existing journey covers the private deployment's first-account form.
const test = spec.world(initialAdminSetup, { timeout: 420_000 });

test("initial administrator creation requires matching passwords before closing setup", async ({ world, user, probe, evidence }) => {
  const password = "Synthetic-owner-password-47!";
  await user.see({ label: /^Administrator email$/i }, { timeoutMs: 90_000 });
  await user.type({ label: /^Administrator email$/i }, world.email);
  await user.type({ label: /^One-time setup code$/i }, world.setupCode);
  await user.click({ role: "button", label: "Continue" });
  await user.see({ label: /^Confirm password$/i });
  await user.type({ label: /^Name$/i }, "Example Owner");
  await user.type({ label: /^Password$/i }, password);

  await user.click({ role: "button", label: "Create administrator" });
  expect(await world.confirmationState()).toMatchObject({ required: true, missing: true });
  expect(await world.status()).toMatchObject({ status: "available" });
  evidence.recordAssertionEvidence("Empty confirmation cannot create the first account", "Native required validation rejects empty confirmation; server setup remains available.", true);

  await user.type({ label: /^Confirm password$/i }, `${password}typo`);
  await user.click({ role: "button", label: "Create administrator" });
  await user.see({ text: "Passwords do not match. Enter the same password in both fields." });
  expect(await world.confirmationState()).toMatchObject({ invalid: "true", focused: true, role: "alert", error: "Passwords do not match. Enter the same password in both fields." });
  expect(await world.status()).toMatchObject({ status: "available" });
  expect(await world.signIn(password)).toBe(401);
  evidence.recordAssertionEvidence("A mismatch is announced and creates no owner", "Confirmation is focused, marked invalid, and associated with the alert. Setup remains available and sign-in fails.", true);
  await user.screenshot();

  await user.type({ label: /^Confirm password$/i }, password, { replace: true });
  await user.notSee({ text: "Passwords do not match. Enter the same password in both fields." });
  expect(await world.confirmationState()).toMatchObject({ invalid: "false" });
  await user.click({ role: "button", label: "Create administrator" });
  await probe.eventually(() => world.status(), { within: 30_000, label: "setup closes after account creation", until: (value) => typeof value === "object" && value !== null && "status" in value && value.status === "complete" });
  expect(await world.signIn(password)).toBe(200);
  expect(await world.signIn(`${password}typo`)).toBe(401);
  evidence.recordAssertionEvidence("Correcting confirmation creates the owner with the intended password", "Setup becomes complete, the intended password signs in, and the mistyped password is rejected.", true);
});
