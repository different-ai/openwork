import { createServer } from "node:http";
import { expect } from "vitest";
import { freshSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { spec } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

/**
 * An organization where the owner added a no-sign-in connector, and a second
 * admin who did not add it and starts without "Remove any connection".
 */
async function connectorRemoveMenu(seed: Seed) {
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const rpc: unknown = body && req.headers["content-type"]?.includes("application/json") ? JSON.parse(body) : undefined;
    const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (!isRecord(rpc) || !("id" in rpc)) { res.writeHead(202).end(); return; }
    if (rpc.method === "initialize") { json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "exp-remove-provider", version: "1.0.0" } } }); return; }
    if (rpc.method === "tools/list") { json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } }); return; }
    json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const close = async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); };
  try {
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Provider did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const den = await seed.den({ env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" }, org: { name: "exp-remove-org", members: { helper: { name: "Lab Helper" } } } });
    const helperContext = await seed.api(den.members.helper, "/v1/org");
    const helperId = isRecord(helperContext.body) && isRecord(helperContext.body.currentMember) ? String(helperContext.body.currentMember.id) : "";
    const promote = await seed.api(den.admin, `/v1/members/${helperId}/role`, { method: "POST", body: JSON.stringify({ role: "admin" }) });
    if (!promote.response.ok) throw new Error(`Admin promotion failed: ${promote.response.status}`);
    // Role changes revoke sessions. Sign in again rather than bypassing that boundary.
    den.members.helper = await freshSession(den.members.helper);
    const sets = await seed.api(den.admin, "/v1/permissions/sets");
    const adminSet = (isRecord(sets.body) && Array.isArray(sets.body.sets) ? sets.body.sets.filter(isRecord) : []).find(set => set.kind === "admin_default");
    if (typeof adminSet?.id !== "string") throw new Error("Admin permissions set missing");
    const created = await seed.api(den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({ name: "Lab Tracker", url: `${origin}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: false, memberIds: [], teamIds: [] } }) });
    if (!created.response.ok || !isRecord(created.body) || typeof created.body.id !== "string") throw new Error(`Connector setup failed: ${created.response.status}`);
    const id = created.body.id;
    const web = await seed.web({ den, signedInAs: den.members.helper, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den, web, id,
      async helperPermissions() {
        const result = await seed.api(den.members.helper, "/v1/org");
        return isRecord(result.body) && isRecord(result.body.currentMember) && Array.isArray(result.body.currentMember.permissions) ? result.body.currentMember.permissions : [];
      },
      async grantRemoveAny() {
        const grant = await seed.api(den.admin, `/v1/permissions/sets/${adminSet.id}/permissions`, { method: "PUT", body: JSON.stringify({ changes: [{ key: "connections.delete", status: "allow" }] }) });
        if (!grant.response.ok) throw new Error(`Granting Remove any connection failed: ${grant.response.status}`);
      },
      async connectorExists() {
        const result = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable");
        return isRecord(result.body) && Array.isArray(result.body.connections) && result.body.connections.some(row => isRecord(row) && row.id === id);
      },
      async [Symbol.asyncDispose]() { await close(); },
    };
  } catch (error) { await close(); throw error; }
}

const test = spec.world(connectorRemoveMenu, { timeout: 600_000, needs: { commands: ["bun", "pnpm"], placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

test("an admin given Remove any connection while Den is open can remove a connector from its page", async ({ world, user, probe, step, evidence }) => {
  await step("the admin has Connectors open and cannot remove connectors others added", async () => {
    await user.see({ role: "button", label: "More for Lab Tracker" }, { timeoutMs: 90_000 });
    const before = await world.helperPermissions();
    evidence.recordAssertionEvidence("The admin starts without Remove any connection", `holds connections.delete=${before.includes("connections.delete")}`, !before.includes("connections.delete"));
    expect(before).not.toContain("connections.delete");
    await user.screenshot();
  });

  await step("the owner turns on Remove any connection for admins, and the admin opens the connector", async () => {
    await world.grantRemoveAny();
    const after = await world.helperPermissions();
    expect(after).toContain("connections.delete");
    await user.click({ role: "button", label: "More for Lab Tracker" });
    await user.click({ role: "menuitem", label: "Open" });
    await user.see({ text: "Who can use it" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "More for Lab Tracker" });
    await user.see({ role: "menuitem", label: "Remove" });
    const disabled = await probe.eventually(async () => (await probe.dom('[role="menuitem"][data-disabled]')).elements.map(element => element.text), { within: 15_000, label: "Remove enabled", until: items => !items.includes("Remove") });
    evidence.recordAssertionEvidence("Remove is offered on the connector page", `disabled menu items=${JSON.stringify(disabled)}`, !disabled.includes("Remove"));
    expect(disabled).not.toContain("Remove");
    await user.screenshot();
  });

  await step("after: the admin removes it from the connector page", async () => {
    await user.click({ role: "menuitem", label: "Remove" });
    await user.see({ text: "Remove Lab Tracker?" });
    await user.click({ role: "button", label: "Remove" });
    await user.see({ text: "Lab Tracker is removed" }, { timeoutMs: 30_000 });
    const exists = await probe.eventually(() => world.connectorExists(), { within: 15_000, label: "connector removed", until: value => !value });
    evidence.recordAssertionEvidence("The connector is gone", `still listed=${exists}`, !exists);
    expect(exists).toBe(false);
    await user.screenshot();
  });
});

test("an agent's removal link opens the confirmation, and the connector goes only when the person chooses Remove", async ({ world, user, probe, step, evidence }) => {
  await step("the person opens the link their agent gave them", async () => {
    await world.grantRemoveAny();
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${world.id}?remove=1`);
    await user.see({ text: "Remove Lab Tracker?" }, { timeoutMs: 90_000 });
    const exists = await world.connectorExists();
    evidence.recordAssertionEvidence("Opening the link removes nothing", `still listed=${exists}`, exists);
    expect(exists).toBe(true);
    await user.screenshot();
  });

  await step("Cancel keeps it and does not ask again", async () => {
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ text: "Remove Lab Tracker?" }, { timeoutMs: 15_000 });
    const url = await probe.eventually(() => probe.url(), { within: 15_000, label: "link cleared", until: value => !value.includes("remove=1") });
    expect(url).not.toContain("remove=1");
    expect(await world.connectorExists()).toBe(true);
    await user.screenshot();
  });

  await step("after: from the link again, the person chooses Remove and it is gone", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${world.id}?remove=1`);
    await user.see({ text: "Remove Lab Tracker?" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Remove" });
    await user.see({ text: "Lab Tracker is removed" }, { timeoutMs: 30_000 });
    const exists = await probe.eventually(() => world.connectorExists(), { within: 15_000, label: "connector removed", until: value => !value });
    evidence.recordAssertionEvidence("The connector is gone after the person confirms", `still listed=${exists}`, !exists);
    expect(exists).toBe(false);
    await user.screenshot();
  });
});
