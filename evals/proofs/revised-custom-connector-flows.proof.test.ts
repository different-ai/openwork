import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { revisedCustomConnectorFlows, DEMO_CLIENT, DEMO_SECRET, DEMO_KEY } from "../worlds/revised-custom-connector-flows.ts";

const test = spec.world(revisedCustomConnectorFlows, { timeout: 600_000, needs: { commands: ["bun", "pnpm"], placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

test("an admin connects their own OAuth app, tests a readable result, and connects key, header and anonymous servers", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const observed = probe.on(world.web);

  await step("the admin enters their own app credentials beside the exact callback and connects in one action", async () => {
    await admin.navigate(world.setupUrl("own", "Private projects"));
    await admin.see({ label: "Client ID" }, { timeoutMs: 90_000 });
    await admin.see({ text: "Callback URL" });
    await admin.type({ label: "Client ID" }, DEMO_CLIENT);
    await admin.type({ label: "Client secret" }, DEMO_SECRET);
    await admin.click({ role: "checkbox", label: "Request read" });
    await admin.click({ role: "button", label: "Connect" });
    await admin.see({ text: "Finish signing in to Private projects" }, { timeoutMs: 30_000 });
    const tab = await probe.eventually(() => world.signInTab(), { within: 30_000, label: "real provider consent tab", until: value => Boolean(value) });
    if (!tab) throw new Error("No provider consent tab");
    try {
      const person = user.on(tab);
      await person.see({ role: "heading", label: "Approve OpenWork access" }, { timeoutMs: 30_000 });
      const saved = (await world.connections()).find((entry) => entry.name === "Private projects");
      const requested = world.authorizationScopes();
      evidence.recordAssertionEvidence("Connect preserves the reviewed read-only scope selection in the saved app and provider request", `saved requestedScopes=${JSON.stringify(saved?.requestedScopes)}; authorize scopes=${JSON.stringify(requested)}; token exchanges before approval=${world.exchanges()}`, JSON.stringify(saved?.requestedScopes) === '["read"]' && JSON.stringify(requested) === '[["read"]]' && world.exchanges() === 0);
      expect(saved?.requestedScopes).toEqual(["read"]);
      expect(requested).toEqual([["read"]]);
      expect(world.exchanges()).toBe(0);
      await admin.screenshot();
      await person.click({ role: "button", label: "Approve access" });
      await probe.eventually(() => world.exchanges(), { within: 30_000, label: "confidential client token exchange", until: count => count === 1 });
    } finally { tab.client.close(); }
  });

  await step("after signing in, the connector is connected and sharing is the only remaining decision", async () => {
    await admin.see({ role: "heading", label: "Private projects" }, { timeoutMs: 60_000 });
    await admin.see({ text: "Connected" });
    await admin.see({ text: "Who can use it" });
    await admin.notSee({ text: /passed all 4 checks/ });
    evidence.recordAssertionEvidence("OAuth used the entered confidential client and did not auto-register another app", `successful exchanges=${world.exchanges()}; automatic registration attempts=${world.registrationAttempts()}`, world.exchanges() === 1 && world.registrationAttempts() === 0);
    expect(world.registrationAttempts()).toBe(0);
    await admin.screenshot();
    await admin.click({ role: "button", label: "Add Private projects" });
    await admin.see({ text: "Private projects is ready" }, { timeoutMs: 30_000 });
  });

  await step("a real tool call shows the meaningful profile first and keeps raw metadata under Technical details", async () => {
    const row = (await world.connections()).find((entry) => entry.name === "Private projects");
    if (typeof row?.id !== "string") throw new Error("Saved connector missing");
    await admin.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${row.id}`);
    await admin.click({ role: "button", label: "More for Private projects" });
    await admin.click({ text: "Test tools" });
    await admin.see({ role: "button", label: "Run tool" }, { timeoutMs: 30_000 });
    await admin.click({ role: "button", label: "Run tool" });
    await admin.see({ text: /demo-account/ }, { timeoutMs: 30_000 });
    await admin.see({ text: "Tool completed" });
    await admin.notSee({ text: /data:image\/png;base64/ });
    evidence.recordAssertionEvidence("The real read result is visible without embedded icon data taking its place", `upstream tools/call count=${world.calls()}; profile visible; binary metadata collapsed`, world.calls() === 1);
    expect(world.calls()).toBe(1);
    await admin.screenshot();
  });

  await step("the API-key route validates a shared key and connects without OAuth", async () => {
    await admin.navigate(world.setupUrl("key", "Key projects"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ role: "button", label: "Continue" });
    await admin.see({ label: "API key" }, { timeoutMs: 30_000 });
    await admin.type({ label: "API key" }, DEMO_KEY);
    await admin.click({ role: "button", label: "Save key" });
    await admin.see({ role: "heading", label: "Key projects" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Connected" });
    evidence.recordAssertionEvidence("The server received the correct Bearer key, not another OAuth grant", `authenticated API-key requests=${world.keyAuthenticated()}; OAuth exchanges=${world.exchanges()}`, world.keyAuthenticated() > 0 && world.exchanges() === 1);
    expect(world.keyAuthenticated()).toBeGreaterThan(0);
    await admin.screenshot();
    await admin.click({ role: "button", label: "Add Key projects" });
  });

  await step("a required custom header is checked before connecting without a browser sign-in", async () => {
    await admin.navigate(world.setupUrl("header", "Header projects"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ role: "radio", label: "No browser sign-in" });
    await admin.click({ role: "button", label: "Add header" });
    await admin.type({ label: "Header 1 name" }, "X-Example-Key");
    await admin.type({ label: "Header 1 value" }, DEMO_KEY);
    await admin.click({ testId: "connector-discovery-summary" });
    await admin.click({ role: "button", label: "Check again" });
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ role: "button", label: "Check connection" });
    await admin.see({ role: "heading", label: "Header projects" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Connected" });
    evidence.recordAssertionEvidence("The upstream requires the custom header; this is not an anonymous fallback", `authenticated header requests=${world.headerAuthenticated()}; OAuth exchanges=${world.exchanges()}`, world.headerAuthenticated() > 0 && world.exchanges() === 1);
    expect(world.headerAuthenticated()).toBeGreaterThan(0);
    await admin.screenshot();
    await admin.click({ role: "button", label: "Add Header projects" });
  });

  await step("a truly anonymous MCP connects without asking for any credentials", async () => {
    await admin.navigate(world.setupUrl("public", "Public projects"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.see({ role: "radio", label: "No browser sign-in" });
    await admin.notSee({ label: "Client ID" });
    await admin.click({ role: "button", label: "Check connection" });
    await admin.see({ role: "heading", label: "Public projects" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Connected" });
    const rows = await world.connections();
    const row = rows.find((entry) => entry.name === "Public projects");
    evidence.recordAssertionEvidence("Anonymous access remains distinct from OAuth and keys", `authType=${String(row?.authType)}; OAuth exchanges=${world.exchanges()}`, row?.authType === "none" && world.exchanges() === 1);
    expect(row?.authType).toBe("none");
    await admin.screenshot();
    await admin.click({ role: "button", label: "Add Public projects" });
  });

  await step("editing during a delayed anonymous save cannot resurrect the unfinished connector", async () => {
    await admin.navigate(world.setupUrl("late-public", "Unfinished public"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ role: "button", label: "Check connection" });
    await probe.eventually(() => world.heldRuntime("late-public"), { within: 20_000, label: "the real create request is pending validation", until: count => count > 0 });
    await probe.eventually(async () => (await world.connections()).some((entry) => entry.name === "Unfinished public"), { within: 15_000, label: "the pending row exists before Edit", until: value => value });
    const pending = (await world.connections()).find((entry) => entry.name === "Unfinished public");
    const pendingId = pending?.id;
    if (typeof pendingId !== "string") throw new Error("Pending public connection missing");
    await admin.click({ testId: "connector-edit-setup" });
    await admin.see({ testId: "connector-route" }, { timeoutMs: 20_000 });
    expect((await world.connections()).some((entry) => entry.name === "Unfinished public")).toBe(true);
    world.releaseRuntime("late-public");
    await probe.eventually(() => world.completedSave("Unfinished public") && world.completedDelete(pendingId), { within: 20_000, label: "original save response and cleanup DELETE both completed", until: value => value });
    await probe.eventually(async () => !(await world.connections()).some((entry) => entry.name === "Unfinished public"), { within: 20_000, label: "canceled late response cleaned up", until: value => value });
    const drafts = (await world.connections()).filter((entry) => entry.name === "Unfinished public").length;
    evidence.recordAssertionEvidence("Edit invalidates every create path, not just OAuth", `held validations=${world.heldRuntime("late-public")}; create POSTs=${world.createPosts("Unfinished public")}; original save completed=${world.completedSave("Unfinished public")}; cleanup DELETE completed=${world.completedDelete(pendingId)}; leftover drafts=${drafts}`, world.heldRuntime("late-public") === 1 && world.createPosts("Unfinished public") === 1 && world.completedDelete(pendingId) && drafts === 0);
    expect(drafts).toBe(0);
    expect(world.heldRuntime("late-public")).toBe(1);
    expect(world.createPosts("Unfinished public")).toBe(1);
    await admin.screenshot();
  });

  await step("canceling a delayed header-auth save leaves no hidden connection behind", async () => {
    await admin.navigate(world.setupUrl("late-header", "Unfinished header"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ role: "radio", label: "No browser sign-in" });
    await admin.click({ role: "button", label: "Add header" });
    await admin.type({ label: "Header 1 name" }, "X-Example-Key");
    await admin.type({ label: "Header 1 value" }, DEMO_KEY);
    await admin.click({ role: "button", label: "Check connection" });
    await probe.eventually(() => world.heldRuntime("late-header"), { within: 20_000, label: "header-auth create is pending validation", until: count => count > 0 });
    await probe.eventually(async () => (await world.connections()).some((entry) => entry.name === "Unfinished header"), { within: 15_000, label: "the pending header row exists before Cancel", until: value => value });
    const pending = (await world.connections()).find((entry) => entry.name === "Unfinished header");
    const pendingId = pending?.id;
    if (typeof pendingId !== "string") throw new Error("Pending header connection missing");
    await admin.click({ role: "button", label: "Cancel" });
    await admin.notSee({ testId: "connector-route" });
    expect((await world.connections()).some((entry) => entry.name === "Unfinished header")).toBe(true);
    world.releaseRuntime("late-header");
    await probe.eventually(() => world.completedSave("Unfinished header") && world.completedDelete(pendingId), { within: 20_000, label: "header save response and cleanup DELETE completed", until: value => value });
    await probe.eventually(async () => !(await world.connections()).some((entry) => entry.name === "Unfinished header"), { within: 20_000, label: "late header create cleaned up", until: value => value });
    const drafts = (await world.connections()).filter((entry) => entry.name === "Unfinished header").length;
    evidence.recordAssertionEvidence("Cancel fences late credential-bearing creates", `held validations=${world.heldRuntime("late-header")}; create POSTs=${world.createPosts("Unfinished header")}; original save completed=${world.completedSave("Unfinished header")}; cleanup DELETE completed=${world.completedDelete(pendingId)}; leftover drafts=${drafts}`, world.heldRuntime("late-header") === 1 && world.createPosts("Unfinished header") === 1 && world.completedDelete(pendingId) && drafts === 0);
    expect(drafts).toBe(0);
    expect(world.heldRuntime("late-header")).toBe(1);
    expect(world.createPosts("Unfinished header")).toBe(1);
    await admin.screenshot();
  });

  await step("retrying a failed save retains the reviewed client and scope selection", async () => {
    await admin.navigate(world.setupUrl("retry", "Retry projects"));
    await admin.see({ label: "Client ID" }, { timeoutMs: 30_000 });
    await admin.type({ label: "Client ID" }, DEMO_CLIENT);
    await admin.type({ label: "Client secret" }, DEMO_SECRET);
    await admin.click({ role: "checkbox", label: "Request read" });
    await admin.click({ role: "button", label: "Connect" });
    await admin.see({ text: "Synthetic connection save interruption. Try again." }, { timeoutMs: 30_000 });
    expect(world.injectedFailures()).toBe(1);
    expect((await world.connections()).some((entry) => entry.name === "Retry projects")).toBe(false);
    await admin.click({ role: "button", label: "Check connection again" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 30_000, label: "retry provider consent", until: value => Boolean(value) });
    if (!tab) throw new Error("No retry consent tab");
    try {
      const person = user.on(tab);
      await person.see({ role: "heading", label: "Approve OpenWork access" }, { timeoutMs: 30_000 });
      const saved = (await world.connections()).find((entry) => entry.name === "Retry projects");
      const scopes = world.authorizationScopes().at(-1);
      evidence.recordAssertionEvidence("The failed save did not restore broader discovery defaults on retry", `injected failed saves=${world.injectedFailures()}; saved requestedScopes=${JSON.stringify(saved?.requestedScopes)}; actual authorize scopes=${JSON.stringify(scopes)}`, world.injectedFailures() === 1 && JSON.stringify(saved?.requestedScopes) === '["read"]' && JSON.stringify(scopes) === '["read"]');
      expect(saved?.requestedScopes).toEqual(["read"]);
      expect(scopes).toEqual(["read"]);
      await person.click({ role: "button", label: "Approve access" });
      await probe.eventually(() => world.exchanges(), { within: 30_000, label: "retry token exchange", until: count => count === 2 });
    } finally { tab.client.close(); }
    await admin.see({ role: "heading", label: "Retry projects" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Connected" });
    await admin.screenshot();
  });
});
