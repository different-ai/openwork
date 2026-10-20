import { expect } from "vitest";
import { spec, type User } from "@openwork/testkit";
import { liveOwnedModelSignIn, serverOwnedModelSignIn } from "../worlds/native-model-signin.ts";

for (const worldFactory of [serverOwnedModelSignIn, liveOwnedModelSignIn]) {
  const test = spec.world(worldFactory, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun"] } });
  test(`a member confirms their exact native model after loopback OAuth with ${worldFactory === liveOwnedModelSignIn ? "live" : "server"} synchronization, without signing in twice`, async ({ world, user, probe, step, evidence }) => {
    const selected = async () => (await probe.dom('button[aria-label="Change model"]')).elements.map(item => item.text).join(" ");
    let original = "";
    let consentUser: User | undefined;
    await step("before: the member requests an assigned model that still needs their own sign-in", async () => {
      // This is the same open app through a genuine owner transition, not a
      // cold-live pending-row assertion or a seeded renderer selection.
      await user.click({ text: "Provider sign-in request" });
      await user.see("composer", { editable: true, timeoutMs: 45_000 });
      expect(await probe.hash()).toContain(world.sessionId);
      await user.click("Change model");
      await user.click({ testId: `model-option-${world.baselineModel.providerID}-${world.baselineModel.modelID}` });
      original = await selected();
      await user.click("Change model");
      await user.click({ testId: `model-option-${world.targetModel.providerID}-${world.targetModel.modelID}` });
      await user.see({ role: "heading", label: "Log in to this provider to use the models" });
      expect(await selected()).toBe(original);
      expect(await world.memberAuthorizationReady()).toBe(false);
      expect(await world.nativeHasRequestedModel()).toBe(false);
      evidence.recordAssertionEvidence("The real host owns the expected synchronization mode while the requested model is genuinely unauthorized", `native=${world.nativeVersion}; effective live owner=${world.live}; exact pending alias=${world.targetModel.providerID}/${world.targetModel.modelID}; original choice retained`, (await selected()) === original);
      await user.screenshot();
    });
    await step("the member opens the genuine browser bridge and approves the loopback provider", async () => {
      await user.click({ role: "button", label: "Login" });
      const tab = await probe.eventually(() => world.consentTab(), { within: 30_000, label: "the real Den provider sign-in tab", until: value => Boolean(value) });
      if (!tab) throw new Error("The genuine provider sign-in tab did not open");
      consentUser = user.on(tab);
      await consentUser.see({ role: "button", label: "Continue to Google" });
      await consentUser.click({ role: "button", label: "Continue to Google" });
      await consentUser.see({ role: "heading", label: "Loopback provider consent" });
      // Only the browser's native catalog read fails. The host/engine itself
      // remains real and will be observed independently after authorization.
      world.failCurrentCatalog(true);
      expect(await selected()).toBe(original);
      evidence.recordAssertionEvidence("OAuth starts through the real host once, and approval is still the member's decision", `host OAuth starts=${world.witness().oauthStarts}; loopback authorization requests=${world.witness().authorizations}; no model preference committed`, world.witness().oauthStarts === 1 && world.witness().authorizations === 1);
      await consentUser.screenshot();
      await consentUser.click({ role: "button", label: "Approve fixture access" });
    });
    await step("a real native model becomes available but a failed fresh read cannot falsely confirm the selection", async () => {
      await probe.eventually(() => world.memberAuthorizationReady(), { within: 30_000, label: "real Den accepts the signed OAuth identity", until: value => value });
      try {
        await probe.eventually(() => world.nativeHasRequestedModel(), { within: 45_000, label: "the real native engine advertises the exact authorized alias", until: value => value });
      } catch (error) {
        const diagnostic = await world.diagnostics().catch(() => ({ error: "native diagnostics unavailable" }));
        throw new Error(`${error instanceof Error ? error.message : String(error)}; real host/provider witness=${JSON.stringify(diagnostic)}`);
      }
      await user.see({ role: "button", label: "Refresh models" }, { timeoutMs: 45_000 });
      await user.see({ text: "Couldn't verify the current model list. Refresh models to check again." });
      expect(await selected()).toBe(original);
      const witness = world.witness();
      expect(witness.tokenExchanges).toBe(1); expect(witness.jwksReads).toBeGreaterThan(0); expect(witness.rejectedExchanges).toBe(0);
      expect(witness.failedReads).toBeGreaterThan(0); expect(witness.oauthStarts).toBe(1);
      evidence.recordAssertionEvidence("PKCE and signed identity verification succeeded in Den and the native model exists, but the UI does not use a stale catalog", `token exchanges=${witness.tokenExchanges}; JWKS reads=${witness.jwksReads}; failed current reads=${witness.failedReads}; host starts=${witness.oauthStarts}; original choice retained`, (await selected()) === original && witness.failedReads > 0);
      await user.screenshot();
    });
    await step("after: Refresh models confirms the requested identity without another OAuth start", async () => {
      world.failCurrentCatalog(false);
      await user.click({ role: "button", label: "Refresh models" });
      await probe.eventually(() => probe.dom('[role="dialog"]'), { within: 30_000, label: "verification closes only after the current catalog succeeds", until: value => value.elements.length === 0 });
      await user.notSee({ role: "heading", label: "Verify model access" });
      await user.click("Change model");
      const checked = await probe.dom(`${world.row(world.targetModel)}[data-checked="true"]`);
      const allChecked = await probe.dom('[data-testid="composer-model-picker"] [data-model-key][data-checked="true"]');
      // Recent is an intentional shortcut to the same provider row. Every
      // selected representation must be this identity, not a different model.
      expect(checked.elements.length).toBeGreaterThan(0);
      expect(allChecked.elements).toHaveLength(checked.elements.length);
      expect(checked.elements.every(row => !row.text.includes("Sign-in required"))).toBe(true);
      // Reselecting the verified native option must not reopen stale Login.
      await user.click({ testId: `model-option-${world.targetModel.providerID}-${world.targetModel.modelID}` });
      await user.notSee({ role: "heading", label: "Log in to this provider to use the models" });
      expect(await world.memberAuthorizationReady()).toBe(true); expect(await world.nativeHasRequestedModel()).toBe(true);
      const witness = world.witness(); expect(witness.oauthStarts).toBe(1); expect(witness.tokenExchanges).toBe(1);
      const other = await probe.api(world.other, "/v1/inference-providers?scope=usable", { headers: { "x-openwork-org-id": world.organizationId } });
      expect(other.response.ok).toBe(true);
      expect(JSON.stringify(other.body)).not.toContain(world.targetModel.modelID);
      evidence.recordAssertionEvidence("Only the exact requested alias is selected after a successful current read, without a second Login or another member's access", `all ${allChecked.elements.length} selected Recent/provider representations match the requested identity; host OAuth starts=${witness.oauthStarts}; token exchanges=${witness.tokenExchanges}; other member has no requested alias`, checked.elements.length > 0 && allChecked.elements.length === checked.elements.length && witness.oauthStarts === 1 && witness.tokenExchanges === 1);
      await user.screenshot();
      await user.press("Escape");
    });
  });
}
