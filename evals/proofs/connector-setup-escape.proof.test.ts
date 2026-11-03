import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { CLIENT_ID, connectorSetupEscape } from "../worlds/connector-setup-escape.ts";

const test = spec.world(connectorSetupEscape, { timeout: 600_000, needs: { commands: ["bun", "pnpm"], placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

const REFUSED = /refused to register OpenWork as an OAuth client/;

test("an admin whose provider refuses automatic sign-in adds their own OAuth app and finishes setup", async ({ world, user, probe, step, evidence }) => {
  await step("before: sign-in fails because the provider refuses to register OpenWork", async () => {
    await user.navigate(world.setupUrl("/mcp/escape", "Lab Projects"));
    await user.see({ role: "button", label: "Sign in with Lab Projects" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Sign in with Lab Projects" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 40_000, label: "sign-in tab", until: value => Boolean(value) });
    if (tab) { await user.on(tab).navigate("about:blank"); tab.client.close(); }
    await user.see({ text: REFUSED }, { timeoutMs: 40_000 });
    await user.see({ role: "button", label: "Use your own OAuth app" });
    await user.see({ role: "button", label: "Add anyway" });
    const connection = await world.connectionFor("/mcp/escape");
    evidence.recordAssertionEvidence("The provider refused registration and nothing is signed in", `registration attempts=${world.registrations()}; token exchanges=${world.exchanges()}; connection has OAuth app=${String(connection?.oauthClientId ?? null)}`, world.registrations() >= 1 && world.exchanges() === 0 && !connection?.oauthClientId);
    expect(world.registrations()).toBeGreaterThanOrEqual(1);
    expect(world.exchanges()).toBe(0);
    await user.screenshot();
  });

  await step("the admin adds the client ID and secret from their own OAuth app", async () => {
    await user.click({ role: "button", label: "Use your own OAuth app" });
    await user.type({ placeholder: "Client ID" }, CLIENT_ID);
    await user.type({ label: "Client secret" }, "exp-escape-synthetic-secret");
    await user.screenshot();
    await user.click({ role: "button", label: "Save changes" });
    await user.see({ text: "Lab Projects opens in a new tab. Come back here when you are done." }, { timeoutMs: 30_000 });
    await user.notSee({ text: REFUSED });
    await user.see({ role: "button", label: "Sign in with Lab Projects" });
    const saved = await probe.eventually(() => world.connectionFor("/mcp/escape"), { within: 20_000, label: "OAuth app saved", until: row => row?.oauthClientId === CLIENT_ID });
    const all = await world.connections();
    evidence.recordAssertionEvidence("The OAuth app is saved on the same connector", `oauthClientId=${String(saved?.oauthClientId)}; has secret=${String(saved?.oauthClientHasSecret)}; connectors at this address=${all.filter(row => row.url === `${world.origin}/mcp/escape`).length}`, saved?.oauthClientId === CLIENT_ID && saved?.oauthClientHasSecret === true && all.filter(row => row.url === `${world.origin}/mcp/escape`).length === 1);
    expect(saved).toMatchObject({ oauthClientId: CLIENT_ID, oauthClientHasSecret: true });
    await user.screenshot();
  });

  await step("after: signing in with that OAuth app passes every check", async () => {
    await user.click({ role: "button", label: "Sign in with Lab Projects" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 40_000, label: "authorization page", until: value => Boolean(value) });
    if (!tab) throw new Error("Authorization tab missing");
    try {
      const person = user.on(tab);
      await person.see({ role: "heading", label: "Approve OpenWork sign-in" }, { timeoutMs: 40_000 });
      await person.click({ role: "button", label: "Approve access" });
      await probe.eventually(() => world.exchanges(), { within: 40_000, label: "one token exchange", until: count => count === 1 });
    } finally { tab.client.close(); }
    await user.see({ text: "Lab Projects passed all 4 checks" }, { timeoutMs: 60_000 });
    const tokenRequests = world.requests.filter(request => request.path === "/token");
    evidence.recordAssertionEvidence("Sign-in used the admin's OAuth app", `token requests=${JSON.stringify(tokenRequests.map(({ clientId, secretSent }) => ({ clientId, secretSent })))}; authenticated tools/list=${world.requests.some(request => request.rpc === "tools/list" && request.authorized)}`, tokenRequests.length === 1 && tokenRequests[0]?.clientId === CLIENT_ID && tokenRequests[0]?.secretSent === true);
    expect(tokenRequests).toEqual([expect.objectContaining({ clientId: CLIENT_ID, secretSent: true })]);
    await user.screenshot();
  });
});

test("an admin adds a connector anyway when a check fails and finishes it later", async ({ world, user, probe, step, evidence }) => {
  await step("before: the failed sign-in check leaves only Cancel and Add anyway", async () => {
    await user.navigate(world.setupUrl("/mcp/anyway", "Lab Deploys"));
    await user.see({ role: "button", label: "Sign in with Lab Deploys" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Sign in with Lab Deploys" });
    const tab = await probe.eventually(() => world.signInTab(), { within: 40_000, label: "sign-in tab", until: value => Boolean(value) });
    if (tab) { await user.on(tab).navigate("about:blank"); tab.client.close(); }
    await user.see({ text: REFUSED }, { timeoutMs: 40_000 });
    await user.see({ text: "You can add it anyway and finish its settings on its page." });
    const pending = await world.connectionFor("/mcp/anyway");
    evidence.recordAssertionEvidence("The sign-in check failed", `registration attempts=${world.registrations()}; token exchanges=${world.exchanges()}; connector signed in=${String(pending?.connected ?? false)}`, world.registrations() >= 1 && world.exchanges() === 0 && pending?.connected !== true);
    expect(world.exchanges()).toBe(0);
    await user.screenshot();
  });

  await step("the admin chooses Add anyway and picks who gets it", async () => {
    await user.click({ role: "button", label: "Add anyway" });
    await user.see({ text: "Add Lab Deploys anyway" }, { timeoutMs: 30_000 });
    await user.see({ text: /Some checks did not pass/ });
    await user.see({ role: "button", label: "Add Lab Deploys" });
    const shown = (await probe.text()).includes("Who can use it");
    evidence.recordAssertionEvidence("Setup moved past the failed check", `title=Add Lab Deploys anyway; "Who can use it" shown=${shown}`, shown);
    expect(shown).toBe(true);
    await user.screenshot();
  });

  await step("after: the connector is added and listed, ready to finish on its page", async () => {
    await user.click({ role: "button", label: "Add Lab Deploys" });
    await user.see({ text: /Lab Deploys couldn't be verified/ }, { timeoutMs: 30_000 });
    const added = await probe.eventually(() => world.connectionFor("/mcp/anyway"), { within: 20_000, label: "connector saved", until: row => Boolean(row) });
    evidence.recordAssertionEvidence("The connector exists even though sign-in never worked", `name=${String(added?.name)}; authType=${String(added?.authType)}; connected=${String(added?.connected)}`, added?.name === "Lab Deploys" && added?.authType === "oauth");
    expect(added).toMatchObject({ name: "Lab Deploys", authType: "oauth" });
    await user.screenshot();
  });
});
