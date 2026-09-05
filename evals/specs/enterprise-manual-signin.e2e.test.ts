import { expect } from "vitest";
import { readDenClientState, spec, type User } from "@openwork/testkit";
import { enterpriseManualSigninWorld } from "../worlds/enterprise-manual-signin.ts";

const test = spec.world(enterpriseManualSigninWorld);
const input: Parameters<User["type"]>[0] = { role: "textbox", label: "Workspace address or sign-in link" };

test("Enterprise activation explains and completes manual sign-in without a deep-link callback", async ({ world, user, probe, step, evidence }) => {
  await step("The activation field explains the manual fallback before sign-in", async () => {
    await user.see(input);
    await user.see({ text: /Browser not returning to OpenWork\? Paste the full sign-in link/ });
    await user.see({ text: /A code on its own is not supported here/ });
    expect((await readDenClientState(world.app)).authTokenPresent).toBe(false);
    await user.screenshot();
  });

  await step("A workspace address still asks for confirmation before browser handoff", async () => {
    await user.type(input, "https://workspace.example.test");
    await user.click("Continue");
    await user.see("Continue in browser");
    await user.notSee("Confirm and finish sign-in");
    expect((await readDenClientState(world.app)).authTokenPresent).toBe(false);
    await user.click("Back");
    await user.type(input, "", { replace: true });
  });

  await step("A pasted full sign-in link requires confirmation without signing in early", async () => {
    await user.click(input);
    await world.pasteLinkAndSubmit();
    await user.see("Confirm and finish sign-in");
    await user.notSee("Continue in browser");
    await user.notSee(input);
    expect((await readDenClientState(world.app)).authTokenPresent).toBe(false);
  });

  await step("Confirming the pasted link signs in and activates the confirmed server", async () => {
    await user.click("Confirm and finish sign-in");
    const state = await probe.eventually(() => readDenClientState(world.app), {
      within: 120_000,
      label: "manual sign-in completed",
      until: (value) => value.authTokenPresent,
    });
    expect(state.authTokenPresent).toBe(true);
    expect(await probe.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig").then(config =>
      config.baseUrl === ${JSON.stringify(world.den.ref.webUrl)} &&
      config.enterpriseActivation?.denBaseUrl === ${JSON.stringify(world.den.ref.webUrl)} &&
      Boolean(config.enterpriseActivation?.activatedAt)
    )`, { awaitPromise: true })).toBe(true);
    await user.notSee({ text: "Link this app to your organization" });
  });
  evidence.recordAssertionEvidence(
    "Manual Enterprise handoff is discoverable and completes without a deep-link callback",
    "The labeled field explains full links and excludes standalone codes. Workspace addresses retain browser confirmation. Pasted links require confirmation before any session exists, then create a session and persist activation for the confirmed synthetic server without invoking an OS callback.",
    true,
  );
});
