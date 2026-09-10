import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { consentCases, mcpConnectionConsent } from "../worlds/mcp-connection-consent.ts";

const test = spec.world(mcpConnectionConsent, {
  timeout: 300_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("browser MCP consent preserves write, read-only and cancelled decisions without another gate", async ({ world, user, probe, step, evidence }) => {
  for (const entry of consentCases) {
    const flow = world.flows.find(flow => flow.id === entry.id);
    if (!flow) throw new Error(`Missing ${entry.id} client fixture`);
    const person = user.on(flow.web);
    const browser = probe.on(flow.web);
    await step(`${entry.id}: the OAuth endpoint leads through browser sign-in to consent`, async () => {
      await person.navigate(flow.authorizeUrl);
      await person.see({ role: "textbox", label: /email/i }, { timeoutMs: 90_000 });
      await person.type({ role: "textbox", label: /email/i }, world.den.admin.email);
      await person.click({ role: "button", text: /^next$/i });
      await person.see({ role: "textbox", label: /password/i }, { timeoutMs: 30_000 });
      await person.type({ role: "textbox", label: /password/i }, world.den.admin.password, { sensitive: true });
      await person.click({ role: "button", text: /^sign in$/i });
      await person.see({ role: "button", text: "Authorize and continue" }, { timeoutMs: 90_000 });
    });

    await step(`${entry.id}: requested access is understandable without another permission gate`, async () => {
      await person.see({ text: "Requested access" });
      if (entry.scope.includes("mcp:write")) {
        await person.see({ text: "Use connected tools and take actions that may create, change, or delete data." });
        await person.notSee({ text: "This client cannot run external tools or make changes." });
      } else {
        await person.see({ text: "Read information and discover available tools." });
        await person.see({ text: "This client cannot run external tools or make changes." });
        await person.notSee({ text: "Use connected tools and take actions that may create, change, or delete data." });
      }
      expect((await browser.dom('input[type="checkbox"], [role="checkbox"]')).elements).toHaveLength(0);
      await person.notSee({ text: "Requested scopes" });
      await person.notSee({ text: entry.scope });
      expect(world.callbacks(entry.id)).toHaveLength(0);
      expect((await browser.dom('input[name="mcp-organization"]')).elements).toHaveLength(2);
      await person.click({ text: world.selectedOrgName });
      await person.screenshot();
    });

    await step(`${entry.id}: one decision returns directly to the registered client`, async () => {
      await person.click({ role: "button", text: entry.accept ? /^Authorize and continue$/ : /^Cancel$/ });
      await person.see({ text: "Authorization returned to client" }, { timeoutMs: 30_000 });
      const callbacks = world.callbacks(entry.id);
      expect(callbacks).toHaveLength(1);
      const returned = callbacks[0];
      expect(returned.state).toBe(flow.state);
      if (!entry.accept) {
        expect(returned.hasCode).toBe(false);
        expect(returned.error).toBe("access_denied");
        expect(returned.exchange).toBeNull();
        evidence.recordAssertionEvidence("Cancel grants no authorization code", "One trusted Cancel click returned access_denied with the original state and no code; no token exchange was attempted.", true);
        return;
      }
      expect(returned.error).toBeNull();
      expect(returned.hasCode).toBe(true);
      const exchange = returned.exchange;
      if (!exchange) throw new Error("The browser callback did not trigger its client's token exchange");
      expect(exchange.status).toBe(200);
      const granted = exchange.scope.split(/\s+/).sort();
      expect(granted).toEqual(entry.scope.split(" ").sort());
      expect(exchange.jwt).toBe(true);
      expect(exchange.tokenScope.split(/\s+/).sort()).toEqual(granted);
      expect(exchange.organizationId).toBe(world.selectedOrgId);
      expect(world.selectedOrgId).not.toBe(world.originalOrgId);
      expect(granted).not.toContain("mcp:app-host");
      if (entry.id === "read") expect(granted).not.toContain("mcp:write");
      evidence.recordAssertionEvidence(
        "One browser consent preserves requested access and workspace identity",
        `One trusted Authorize and continue click delivered one callback; PKCE exchange and JWT retained exactly ${granted.join(" ")} and the selected, not original, workspace. No additional approval or first-party scope was granted.`,
        true,
      );
    });
  }
});
