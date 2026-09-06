import { createHash } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { attachedCanary, cliManaged, requirements, workerRows } from "../worlds/fixtures/cloud-web-canary/world.ts";

// Operator-only attached journey. No VM, account, provider or gateway setup here.
const test = spec.world(attachedCanary, { needs: requirements, timeout: 90_000 });

test(cliManaged
  ? "CLI-managed Web signs in, streams a real file read, and preserves the conversation and file after manual runtime restart (automatic provisioning and wake unverified)"
  : "managed Web signs in, streams a real file read, and preserves the conversation and file after idle wake", { timeout: 900_000 }, async ({ world, user, probe, step, evidence }) => {
  const first = `Canary read 1: ${world.marker}`;
  const second = `Canary read 2: ${world.marker}`;
  const expectedHash = createHash("sha256").update(`${world.marker}\n`).digest("hex");

  await step("Anonymous gateway opens Den login and returns through the Web handoff", async () => {
    expect(await world.stats()).toMatchObject({ verifiedReads: 0, writeToolCalls: 0, readToolCalls: 0,
      rejectedReadResults: 0, protocolErrors: 0, streamedReplies: 0, upstreamCalls: 0 });
    if (cliManaged) expect(await world.providerCalls()).toBe(0);
    await user.navigate(world.gatewayUrl);
    await user.see({ role: "button", text: "Sign in to OpenWork" });
    expect(await probe.storage("openwork.den.authToken")).toBeNull();
    await user.click({ role: "button", text: "Sign in to OpenWork" });
    // Leave no second gateway tab running heartbeats during the idle-stop frame.
    await user.navigate("about:blank");
    await world.followLoginPopup();
    await probe.eventually(async () => (await world.page()).atDen, { within: 60_000, label: "Den login origin" });
    await user.type({ label: "Email" }, world.email, { replace: true });
    await user.click({ role: "button", text: "Next" });
    await user.type({ label: "Password" }, world.password, { sensitive: true, replace: true, verify: true });
    await user.click({ role: "button", text: /^Sign in$/ });
    await probe.eventually(async () => (await world.page()).atGateway, { within: 60_000, label: "Web handoff returns to gateway" });
  });

  await step(cliManaged ? "The CLI-precreated runtime becomes a ready Web workspace" : "Provisioning takeover yields to a ready managed workspace", async () => {
    if (!cliManaged) {
      await user.see({ testId: "cloud-workspace-takeover" }, { timeoutMs: 30_000 });
      await probe.eventually(async () => (await world.page()).takeover === "provisioning", { within: 30_000, label: "provisioning takeover state" });
    }
    await user.see("composer", { editable: true, timeoutMs: 300_000 });
    await probe.eventually(async () => (await world.page()).ready, { within: 60_000, label: "ready workspace pill" });
    await user.notSee({ testId: "cloud-workspace-takeover" });
    expect(await probe.storage("openwork.den.activeOrgId") === world.orgId).toBe(true);
  });

  // Reuse only the session established by the UI. /v1/workers reads stored state;
  // /cloud/instance and /gateway/resolve MUST NOT be polled here: they can wake it.
  const token = await probe.storage("openwork.den.authToken");
  if (typeof token !== "string" || !token) throw new Error("Web handoff did not establish a session");
  const session = { ...world.den.ref, token, email: world.email, password: world.password };
  const workers = async () => {
    const result = await probe.api(session, "/v1/workers?limit=100", { headers: { "x-openwork-org-id": world.orgId }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (result.response.status !== 200) throw new Error(`Worker list returned HTTP ${result.response.status}`);
    return workerRows(result.body);
  };
  const initialWorkers = await workers();
  expect(initialWorkers).toHaveLength(1);
  const worker = initialWorkers[0];
  expect(worker.orgId === world.orgId && worker.userId === world.userId).toBe(true);
  expect(worker.workspacePath === world.workspace).toBe(true);
  expect(worker.backend).toBe("cloud-instance");
  expect(worker.status).toBe("healthy");
  if (world.expectedWorkerId) expect(worker.id === world.expectedWorkerId).toBe(true);

  await step("A UI prompt causes engine write then read, with a visibly streamed assistant answer", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", text: /^Model\b/ });
    await user.click({ role: "option", text: /^Canary\b/ });
    await user.see({ role: "button", label: "Change model" }, { text: /Canary/ });
    await user.type("composer", `Create ${world.filename} in the current workspace containing exactly this line: ${world.marker}\nThen read the file back and report its contents.`);
    await user.press("Enter");
    await user.see({ text: /^Canary read 1:$/ }, { timeoutMs: 120_000 });
    const partial = (await world.page()).assistant;
    expect(partial.includes("Canary read 1:") && !partial.includes(first)).toBe(true);
    await user.see({ text: first }, { timeoutMs: 60_000 });
    expect((await world.page()).assistant.includes(first)).toBe(true);
    await user.see({ role: "button", label: "Run task" });
    const stats = await world.stats();
    expect(stats).toMatchObject({ writeToolCalls: 1, readToolCalls: 1, verifiedReads: 1, streamedReplies: 1,
      rejectedReadResults: 0, protocolErrors: 0, upstreamCalls: 0 });
    expect(stats.receipts).toEqual([{ sequence: 1, turn: 1, sha256: expectedHash }]);
  });

  const route = (await world.page()).route;
  expect(/\/workspace\/[^/?#]+\/session\/[^/?#]+/.test(route)).toBe(true);
  await step("Reload retains the same conversation and recorded assistant answer", async () => {
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    await user.see({ text: first });
    expect((await world.page()).route === route).toBe(true);
    expect((await world.stats()).verifiedReads).toBe(1);
  });

  await step(cliManaged ? "Fixture action: CLI stops and restarts the owned real runtime with the Web tab away" : "With the Web tab away, Den actually idle-stops the same worker", async () => {
    await user.navigate("about:blank");
    if (cliManaged) {
      expect(await world.manualRestart()).toEqual({ stopped: true, started: true, runtimeHealthy: true, sameSandbox: true });
      expect(await world.providerCalls()).toBe(0);
    } else {
      await probe.eventually(async () => {
        const rows = await workers();
        return rows.length === 1 && rows[0].id === worker.id && rows[0].status === "stopped";
      }, { within: 240_000, intervalMs: 3_000, label: "Den stored worker status becomes stopped" });
    }
    expect((await world.stats()).verifiedReads).toBe(1);
  });

  await step(cliManaged ? "Reopening the same conversation after manual restart causes a fresh engine read of the preserved file" : "Reopening wakes the same worker and conversation; a fresh engine read proves file persistence", async () => {
    await user.navigate(new URL(route, world.gatewayUrl).href);
    if (!cliManaged) await user.see({ testId: "cloud-workspace-takeover" }, { timeoutMs: 30_000 });
    await user.see("composer", { editable: true, timeoutMs: 180_000 });
    await probe.eventually(async () => (await world.page()).ready, { within: 60_000, label: cliManaged ? "workspace ready after manual restart" : "workspace ready after idle wake" });
    await user.see({ text: first });
    expect((await world.page()).route === route).toBe(true);
    const resumed = await workers();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toEqual(worker);
    await user.type("composer", `Read ${world.filename} again from disk and report its current contents. Do not modify the file.`);
    await user.press("Enter");
    await user.see({ text: /^Canary read 2:$/ }, { timeoutMs: 120_000 });
    const partial = (await world.page()).assistant;
    expect(partial.includes("Canary read 2:") && !partial.includes(second)).toBe(true);
    await user.see({ text: second }, { timeoutMs: 60_000 });
    expect((await world.page()).assistant.includes(second)).toBe(true);
    await user.see({ role: "button", label: "Run task" });
    expect((await world.page()).route === route).toBe(true);
    expect(await workers()).toEqual([worker]);
    const stats = await world.stats();
    expect(stats).toMatchObject({ writeToolCalls: 1, readToolCalls: 2, verifiedReads: 2, streamedReplies: 2,
      rejectedReadResults: 0, protocolErrors: 0, upstreamCalls: 0 });
    expect(stats.receipts).toEqual([{ sequence: 1, turn: 1, sha256: expectedHash }, { sequence: 2, turn: 2, sha256: expectedHash }]);
    if (cliManaged) expect(await world.providerCalls()).toBe(0);
    evidence.recordAssertionEvidence(cliManaged ? "UI continuity and fresh engine read after CLI-managed restart" : "UI continuity and fresh engine file read after Den idle stop",
      cliManaged
        ? "Trusted Chrome completed login, Web handoff, streaming and reload. An explicitly named fixture action used Daytona CLI stop/info/start and relaunched the real runtime. Reopening the same session caused a second distinct engine read receipt with the original normalized hash and no additional write. The model made zero upstream calls and the Den provider tripwire observed zero requests. Automatic provisioning, Den idle-stop and automatic wake remain unverified."
        : "Trusted Chrome clicks and typing completed login, provisioning, streaming, reload and wake. GET /v1/workers observed healthy -> stopped -> healthy with one unchanged identity. Two distinct engine read receipts matched the normalized read-content hash; the follow-up caused no write. The deterministic fixture made zero upstream calls.", true);
  });
});
