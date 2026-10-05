import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denLibraryManage } from "../worlds/den-library-manage.ts";
import { connectionResponse, inventoryResponse, requireOwnedDen } from "./member-api-key-fixture.ts";

const test = spec.world(async (seed, ctx) => {
  requireOwnedDen();
  const world = await denLibraryManage(seed, ctx);
  const create = async (name: string) => {
    const response = await seed.api(world.den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({
      name, url: world.keyed.mcpUrl, authType: "apikey", credentialMode: "per_member", access: { orgWide: true },
    }) });
    expect(response.response.status).toBe(200);
    return connectionResponse.parse(response.body).id;
  };
  const id = await create("Key recovery A");
  const second = await create("Key recovery B");
  return Object.assign(world, { id, second });
}, {
  timeout: 240_000,
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

for (const scenario of ["cancel", "uncertain", "refresh", "stale-target", "deadline"]) {
  test(`real member key dialog recovers from ${scenario} without disclosing a candidate`, async ({ world, user, probe, evidence }) => {
    const { id, second } = world;
    const person = user.on(world.web);
    const page = probe.on(world.web);
    await person.navigate(`${world.den.ref.webUrl}/dashboard/your-connections`);
    await person.see({ testId: `connect-my-mcp-account-${id}` }, { timeoutMs: 60_000 });
    await person.click({ testId: `connect-my-mcp-account-${id}` });
    await person.see({ role: "heading", label: "Add key for Key recovery A" });
    const candidate = "synthetic-private-dialog-candidate";
    await person.type({ label: "Key recovery A key" }, candidate, { sensitive: true });
    const endpoint = `/v1/mcp-connections/${id}/my-credential`;
    if (scenario === "cancel") {
      await person.click({ role: "button", label: "Cancel" });
      await person.click({ testId: `connect-my-mcp-account-${id}` });
      expect(await page.credentialInputState('input[name="member-mcp-api-key"]', candidate)).toMatchObject({ empty: true, inputContainsSecret: false, bodyContainsSecret: false, storageContainsSecret: false });
    } else if (scenario === "uncertain") {
      await world.proxy.faults.status(endpoint, 500, { times: 1, body: { message: `Provider echoed ${candidate}` } });
      await person.click({ role: "button", label: "Save key" });
      await person.see({ role: "alert" }, { text: /Check the connection status before retrying/ });
      await person.notSee({ text: candidate });
      await person.notSee({ role: "heading", label: "Key recovery A: key saved" });
      expect(await page.credentialInputState('input[name="member-mcp-api-key"]', candidate)).toMatchObject({ empty: true, bodyContainsSecret: false, storageContainsSecret: false });
      expect((await world.proxy.requestLog()).some(row => row.path === endpoint && row.faulted && row.status === 500)).toBe(true);
    } else if (scenario === "refresh") {
      await world.proxy.faults.status("/v1/mcp-connections?scope=usable", 500, { times: 10 });
      await person.click({ role: "button", label: "Save key" });
      await person.see({ role: "heading", label: "Key recovery A: key saved" }, { timeoutMs: 30_000 });
      await person.notSee({ role: "alert" });
      const stored = await probe.api(world.den.members.sam, "/v1/mcp-connections?scope=usable");
      expect(inventoryResponse.parse(stored.body).connections.find(row => row.id === id)?.connectedForMe).toBe(true);
      await probe.eventually(async () => (await world.proxy.requestLog()).some(row => row.path.startsWith("/v1/mcp-connections?scope=usable") && row.faulted && row.status === 500), { within: 15_000, until: Boolean, label: "actual failed post-save refresh" });
    } else if (scenario === "deadline") {
      await world.proxy.faults.latency(endpoint, 45000, { times: 1 });
      const startedAt = Date.now();
      await person.click({ role: "button", label: "Save key" });
      await probe.eventually(async () => (await page.dom('input[name="member-mcp-api-key"]:disabled')).elements.length === 1, { within: 5000, until: Boolean, label: "hanging request is visibly pending" });
      await person.see({ role: "alert" }, { text: /Check the connection status before retrying/, timeoutMs: 20000 });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(14000);
      expect(elapsedMs).toBeLessThan(21000);
      expect((await page.dom('input[name="member-mcp-api-key"]:disabled')).elements).toHaveLength(0);
      expect(await page.credentialInputState('input[name="member-mcp-api-key"]', candidate)).toMatchObject({ empty: true, bodyContainsSecret: false, urlContainsSecret: false, storageContainsSecret: false });
      await probe.eventually(async () => (await world.proxy.requestLog()).some(row => row.path === endpoint && row.faulted && row.status === 499), { within: 5000, until: Boolean, label: "deadline actually canceled the delayed request" });
      await person.type({ label: "Key recovery A key" }, "synthetic-timeout-retry-candidate", { sensitive: true });
      await person.click({ role: "button", label: "Save key" });
      await person.see({ role: "heading", label: "Key recovery A: key saved" }, { timeoutMs: 15000 });
      const stored = await probe.api(world.den.members.sam, "/v1/mcp-connections?scope=usable");
      expect(inventoryResponse.parse(stored.body).connections.find(row => row.id === id)?.connectedForMe).toBe(true);
      evidence.recordAssertionEvidence("Hanging save has a finite caller-preserving deadline", `The real delayed request became uncertain after ${elapsedMs}ms, its input was enabled and empty, the proxy observed cancellation, and the next real save succeeded. No candidate or response body is retained.`, true);
    } else {
      if (!second) throw new Error("Missing second owned connection");
      await world.proxy.faults.latency(endpoint, 2500, { times: 1 });
      await person.click({ role: "button", label: "Save key" });
      await probe.eventually(async () => (await page.dom('input[name="member-mcp-api-key"]:disabled')).elements.length === 1, { within: 10_000, until: Boolean, label: "first request pending" });
      const arrivals = world.proxy.arrivals;
      if (!arrivals) throw new Error("Local fault proxy arrival observation required");
      await probe.eventually(async () => (await arrivals()).some(row => row.path === endpoint && row.faulted), { within: 10_000, until: Boolean, label: "first request reached the delaying proxy" });
      await person.press("Escape");
      await person.click({ testId: `connect-my-mcp-account-${second}` });
      await person.type({ label: "Key recovery B key" }, "synthetic-second-dialog-candidate", { sensitive: true });
      await person.click({ role: "button", label: "Save key" });
      await person.see({ role: "heading", label: "Key recovery B: key saved" }, { timeoutMs: 30_000 });
      await probe.eventually(async () => (await world.proxy.requestLog()).some(row => row.path === endpoint && row.faulted), { within: 15_000, until: Boolean, label: "delayed request observed" });
      await person.see({ role: "heading", label: "Key recovery B: key saved" });
      await person.notSee({ role: "alert" });
      await person.notSee({ role: "heading", label: "Key recovery A: key saved" });
    }
    await person.notSee({ text: candidate });
    evidence.recordAssertionEvidence("Real rendered dialog recovery", `Observed ${scenario} through the real Den web, Chrome, typed user/probe channels and owned fault proxy. No mounted product imports or repository snapshots. No server rollback or prepared-revision CAS claim.`, true);
  });
}
