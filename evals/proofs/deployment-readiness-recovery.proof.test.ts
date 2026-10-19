import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deploymentParentReadLock, deploymentReadinessRecovery } from "../worlds/deployment-readiness-recovery.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(deploymentReadinessRecovery, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const guardTest = spec.world(deploymentParentReadLock, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

guardTest("an owner keeps last-known observations while a real parent rollout refusal blocks preparation until fresh reads restore it", async ({ world, user, probe, step, evidence }) => {
  if (!world.operator) throw new Error("Missing local operator browser");
  const operator = user.on(world.operator);
  await step("the owner first verifies an existing target without starting any cloud services", async () => {
    await user.see({ text: "Observed deployment" }, { timeoutMs: 60_000 });
    await operator.see({ testId: "admin-capability-managedDeployments" }, { timeoutMs: 60_000 });
    const verified = await probe.eventually(() => probe.dom('[data-deployment-read-state="verified"]'), { within: 30_000, label: "the initial matching read pair is verified", until: (value) => value.elements.length === 1 });
    const ready = await probe.dom('[data-testid="deployment-prepare-install"]:not(:disabled)');
    expect(ready.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the initial target comes from authorized reads", `verified surfaces=${verified.elements.length}; preparation controls enabled=${ready.elements.length}`, verified.elements.length === 1 && ready.elements.length === 1);
    await user.screenshot();
  });
  await step("the operator turns off the real local parent feature and polling keeps observations as last known", async () => {
    await operator.click({ testId: "admin-capability-managedDeployments" });
    const blocked = await probe.eventually(() => probe.api(world.den.admin, "/v1/managed-deployments"), { within: 15_000, label: "the real parent route guard refuses reads", until: (value) => value.response.status === 404 });
    expect(blocked.body).toEqual({ error: "feature_disabled", feature: "managedDeployments" });
    await user.see({ text: /Deployment preparation is turned off.*OpenWork operator/ }, { timeoutMs: 35_000 });
    await user.see({ testId: "deployment-last-known" });
    await user.see({ text: "Observed deployment" });
    await user.see({ testId: "managed-deployment-status" }, { text: "Last known: Not launched" });
    await user.notSee({ text: /feature_disabled|No deployments yet|Install failed/ });
    const disabled = await probe.dom('[data-testid="deployment-prepare-install"]:disabled');
    const create = await probe.dom('[data-testid="managed-deployment-create"]:disabled');
    const alerts = await probe.dom('[data-testid="managed-deployments-screen"] [role="alert"]');
    expect(disabled.elements).toHaveLength(1);
    expect(create.elements).toHaveLength(1);
    expect(alerts.elements).toHaveLength(0);
    const refusals = (await world.faults.requestLog()).filter((entry) => entry.method === "GET" && entry.path.startsWith("/api/den/v1/managed-deployments") && entry.status === 404 && !entry.faulted);
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    evidence.recordAssertionEvidence("the known guard refusal is a neutral lock, not installation failure", `real uninjected guard refusals=${refusals.length}; disabled preparation=${disabled.elements.length}; disabled create=${create.elements.length}; red alerts=${alerts.elements.length}`, refusals.length >= 2 && disabled.elements.length === 1 && create.elements.length === 1 && alerts.elements.length === 0);
    await user.screenshot();
  });
  await step("only fresh matching reads after operator re-enablement lift the lock", async () => {
    const restoredAt = Date.now();
    await operator.click({ testId: "admin-capability-managedDeployments" });
    if (await probe.has("Check again")) await user.click({ role: "button", label: "Check again" });
    const ready = await probe.eventually(() => probe.dom('[data-testid="deployment-prepare-install"]:not(:disabled)'), { within: 35_000, label: "fresh authorized data restores preparation", until: (value) => value.elements.length === 1 });
    await user.notSee({ testId: "deployment-last-known" });
    await user.see({ testId: "managed-deployment-status" }, { text: "Not launched" });
    const requests = await world.faults.requestLog();
    const fresh = requests.filter((entry) => entry.method === "GET" && entry.at >= restoredAt && entry.status === 200);
    const list = fresh.some((entry) => entry.path === "/api/den/v1/managed-deployments");
    const configuration = fresh.some((entry) => entry.path === "/api/den/v1/managed-deployments/configuration");
    const launches = requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/launch"));
    expect(list && configuration).toBe(true);
    expect(launches).toHaveLength(0);
    evidence.recordAssertionEvidence("cached context cannot unlock or launch a target", `fresh list=${list}; fresh configuration=${configuration}; restored preparation=${ready.elements.length}; launch requests=${launches.length}`, list && configuration && ready.elements.length === 1 && launches.length === 0);
    await user.screenshot();
  });
});

guardTest("a revoked reader loses cached deployment details immediately even while the other read hangs and rejects", async ({ world, user, probe, step, evidence }) => {
  let startedAt = 0;
  await step("before: the authorized reader sees a verified target and can prepare approval", async () => {
    await user.see({ text: "Observed deployment" }, { timeoutMs: 60_000 });
    const ready = await probe.dom('[data-deployment-read-state="verified"] [data-testid="deployment-prepare-install"]:not(:disabled)');
    expect(ready.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the denial starts with real cached details", `verified preparation controls=${ready.elements.length}`, ready.elements.length === 1);
    await user.screenshot();
  });
  await step("after: a completed access refusal masks details without waiting for the hanging settings read", async () => {
    startedAt = Date.now();
    // The real renderer fetches both endpoints. Only settings is delayed beyond the shipped
    // request deadline; the list answers 403. This is not a helper with two HTTP statuses.
    await world.faults.faults.latency("/api/den/v1/managed-deployments/configuration", 45_000, { method: "GET", times: 2 });
    await world.faults.faults.status("/api/den/v1/managed-deployments", 403, { method: "GET", times: 2, body: { error: "forbidden" } });
    await user.see({ text: "Deployment access changed. Sign in again or ask an organization owner for access." }, { timeoutMs: 25_000 });
    await user.notSee({ text: "Observed deployment" });
    await user.notSee({ testId: "managed-deployment-detail" });
    await user.notSee({ testId: "deployment-last-known" });
    const requests = (await world.faults.requestLog()).filter((entry) => entry.at >= startedAt);
    const refusals = requests.filter((entry) => entry.path === "/api/den/v1/managed-deployments" && entry.status === 403);
    const timeouts = requests.filter((entry) => entry.path === "/api/den/v1/managed-deployments/configuration" && entry.status === 499);
    const masked = await probe.dom('[data-deployment-read-state="access_denied"]');
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(timeouts).toHaveLength(0);
    expect(masked.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("known access denial wins before the sibling settles", `completed list refusals=${refusals.length}; sibling timeouts so far=${timeouts.length}; masked surfaces=${masked.elements.length}`, refusals.length >= 1 && timeouts.length === 0 && masked.elements.length === 1);
    await user.screenshot();
  });
  await step("the later network rejection cannot restore revoked observations", async () => {
    const requests = await probe.eventually(() => world.faults.requestLog(), { within: 40_000, label: "the browser cancels the hanging settings request at its deadline", until: (value) => value.some((entry) => entry.at >= startedAt && entry.path === "/api/den/v1/managed-deployments/configuration" && entry.status === 499) });
    await user.see({ text: "Deployment access changed. Sign in again or ask an organization owner for access." });
    await user.notSee({ text: /Observed deployment|No deployments yet|feature_disabled/ });
    const masked = await probe.dom('[data-deployment-read-state="access_denied"]');
    const create = await probe.dom('[data-testid="managed-deployment-create"]:disabled');
    const timeouts = requests.filter((entry) => entry.at >= startedAt && entry.path === "/api/den/v1/managed-deployments/configuration" && entry.status === 499);
    expect(masked.elements).toHaveLength(1);
    expect(create.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("a transport rejection does not erase the completed refusal", `actual browser timeouts=${timeouts.length}; masked surfaces=${masked.elements.length}; disabled creation=${create.elements.length}`, timeouts.length >= 1 && masked.elements.length === 1 && create.elements.length === 1);
    await user.screenshot();
  });
  await step("fresh authorized list and settings reads are required to show details again", async () => {
    await world.faults.faults.clear();
    const restoredAt = Date.now();
    await user.see({ text: "Observed deployment" }, { timeoutMs: 40_000 });
    const ready = await probe.dom('[data-deployment-read-state="verified"] [data-testid="deployment-prepare-install"]:not(:disabled)');
    const fresh = (await world.faults.requestLog()).filter((entry) => entry.at >= restoredAt && entry.method === "GET" && entry.status === 200);
    const pair = fresh.some((entry) => entry.path === "/api/den/v1/managed-deployments") && fresh.some((entry) => entry.path === "/api/den/v1/managed-deployments/configuration");
    expect(ready.elements).toHaveLength(1);
    expect(pair).toBe(true);
    evidence.recordAssertionEvidence("only a fresh successful pair restores access", `fresh matching read pair=${pair}; verified preparation controls=${ready.elements.length}`, pair && ready.elements.length === 1);
    await user.screenshot();
  });
});

guardTest("an owner keeps the real parent rollout lock when the sibling settings read rejects", async ({ world, user, probe, step, evidence }) => {
  if (!world.operator) throw new Error("Missing local operator browser");
  const operator = user.on(world.operator);
  let startedAt = 0;
  await step("before: the owner sees a verified target with preparation available", async () => {
    await user.see({ text: "Observed deployment" }, { timeoutMs: 60_000 });
    await operator.see({ testId: "admin-capability-managedDeployments" }, { timeoutMs: 60_000 });
    const ready = await probe.dom('[data-deployment-read-state="verified"] [data-testid="deployment-prepare-install"]:not(:disabled)');
    expect(ready.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the target is verified before the mixed failure", `verified preparation controls=${ready.elements.length}`, ready.elements.length === 1);
    await user.screenshot();
  });
  await step("after: the actual parent guard locks preparation while settings is still hanging", async () => {
    startedAt = Date.now();
    await world.faults.faults.latency("/api/den/v1/managed-deployments/configuration", 45_000, { method: "GET", times: 2 });
    await operator.click({ testId: "admin-capability-managedDeployments" });
    const refusal = await probe.eventually(() => probe.api(world.den.admin, "/v1/managed-deployments"), { within: 15_000, label: "the real local parent feature guard is off", until: (value) => value.response.status === 404 });
    expect(refusal.body).toEqual({ error: "feature_disabled", feature: "managedDeployments" });
    await user.see({ text: /Deployment preparation is turned off.*OpenWork operator/ }, { timeoutMs: 25_000 });
    await user.see({ testId: "deployment-last-known" });
    await user.see({ text: "Observed deployment" });
    const requests = (await world.faults.requestLog()).filter((entry) => entry.at >= startedAt);
    const real = requests.filter((entry) => entry.path === "/api/den/v1/managed-deployments" && entry.status === 404 && !entry.faulted);
    const timeouts = requests.filter((entry) => entry.path === "/api/den/v1/managed-deployments/configuration" && entry.status === 499);
    const disabled = await probe.dom('[data-deployment-read-state="feature_locked"] [data-testid="deployment-prepare-install"]:disabled');
    expect(real.length).toBeGreaterThanOrEqual(1);
    expect(timeouts).toHaveLength(0);
    expect(disabled.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the real parent refusal applies before the sibling settles", `uninjected parent refusals=${real.length}; sibling timeouts so far=${timeouts.length}; disabled preparation=${disabled.elements.length}`, real.length >= 1 && timeouts.length === 0 && disabled.elements.length === 1);
    await user.screenshot();
  });
  await step("the settings timeout cannot downgrade the operator lock or mark installation failed", async () => {
    const requests = await probe.eventually(() => world.faults.requestLog(), { within: 40_000, label: "the sibling settings fetch really rejects at its deadline", until: (value) => value.some((entry) => entry.at >= startedAt && entry.path === "/api/den/v1/managed-deployments/configuration" && entry.status === 499) });
    await user.see({ testId: "managed-deployment-status" }, { text: "Last known: Not launched" });
    await user.notSee({ text: /feature_disabled|No deployments yet|Install failed|Could not verify deployments/ });
    const locked = await probe.dom('[data-deployment-read-state="feature_locked"]');
    const disabled = await probe.dom('[data-testid="deployment-prepare-install"]:disabled');
    const alerts = await probe.dom('[data-testid="managed-deployments-screen"] [role="alert"]');
    const timeouts = requests.filter((entry) => entry.at >= startedAt && entry.path === "/api/den/v1/managed-deployments/configuration" && entry.status === 499);
    expect(locked.elements).toHaveLength(1);
    expect(disabled.elements).toHaveLength(1);
    expect(alerts.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("transport failure preserves the neutral last-known lock", `actual browser timeouts=${timeouts.length}; locked surfaces=${locked.elements.length}; disabled preparation=${disabled.elements.length}; red alerts=${alerts.elements.length}`, timeouts.length >= 1 && locked.elements.length === 1 && disabled.elements.length === 1 && alerts.elements.length === 0);
    await user.screenshot();
  });
  await step("only a fresh read pair after operator re-enablement restores preparation", async () => {
    await world.faults.faults.clear();
    const restoredAt = Date.now();
    await operator.click({ testId: "admin-capability-managedDeployments" });
    await user.click({ role: "button", label: "Check again" });
    const ready = await probe.eventually(() => probe.dom('[data-deployment-read-state="verified"] [data-testid="deployment-prepare-install"]:not(:disabled)'), { within: 40_000, label: "fresh successful list and settings reads restore preparation", until: (value) => value.elements.length === 1 });
    await user.notSee({ testId: "deployment-last-known" });
    const fresh = (await world.faults.requestLog()).filter((entry) => entry.at >= restoredAt && entry.method === "GET" && entry.status === 200);
    const pair = fresh.some((entry) => entry.path === "/api/den/v1/managed-deployments") && fresh.some((entry) => entry.path === "/api/den/v1/managed-deployments/configuration");
    expect(pair).toBe(true);
    evidence.recordAssertionEvidence("cached context and one success cannot lift the lock", `fresh matching read pair=${pair}; verified preparation controls=${ready.elements.length}`, pair && ready.elements.length === 1);
    await user.screenshot();
  });
});

test("an owner keeps a Google Cloud form through readiness failures and prepares approval without starting cloud services", async ({ world, user, probe, step, evidence }) => {
  await step("the owner can review billable cloud approval before preparing anything", async () => {
    await user.see({ text: /No deployments yet/ }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Create deployment" });
    await user.type({ role: "textbox", label: "Google Cloud project ID" }, "openwork-fixture");
    await user.type({ role: "textbox", label: "Google Cloud project number" }, "123456789012");
    await user.type({ role: "textbox", label: "Address" }, "openwork.example.test");
    await user.type({ role: "textbox", label: "Cloud DNS managed zone name for that address" }, "example-test");
    await user.type({ role: "textbox", label: "First administrator email" }, "owner@example.test");
    await user.see({ testId: "deployment-cost-consent" }, { text: /Only running the command creates or changes billable/ });
    await user.click({ role: "checkbox", label: /I control this Google Cloud project/ });
    const consent = await probe.has("Removing this record does not delete those resources or stop charges.");
    evidence.recordAssertionEvidence("billable approval remains explicit", `cloud billable-resource and retained-charge consent visible=${consent}`, consent);
    expect(consent).toBe(true);
    await user.screenshot();
  });
  await step("a late feature lock names the operator and preserves every entered value", async () => {
    await user.click({ testId: "create-deployment-submit" });
    await user.see({ text: /Google Cloud deployments aren't enabled.*OpenWork operator/ }, { timeoutMs: 60_000 });
    await user.see({ role: "textbox", label: "Google Cloud project ID" }, { value: "openwork-fixture" });
    await user.see({ role: "textbox", label: "Address" }, { value: "openwork.example.test" });
    await user.notSee({ text: /^feature_disabled$/ });
    const failed = (await world.faults.requestLog()).filter((entry) => entry.method === "POST" && entry.status === 404);
    const blocked = await probe.dom('[data-testid="create-deployment-dialog"] [data-notice-tone="neutral"]');
    expect(blocked.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("a late rollout change has actionable recovery", `actual create refusal=${failed.length}; project and address retained; neutral operator lock=${blocked.elements.length}`, failed.length === 1 && blocked.elements.length === 1);
    expect(failed.length).toBe(1);
    await user.screenshot();
  });
  await step("an unpublished installer requests operator publication without discarding the form", async () => {
    await user.click({ testId: "create-deployment-submit" });
    await user.see({ text: /OpenWork operator must publish and configure a verified installer release/ }, { timeoutMs: 60_000 });
    await user.see({ role: "textbox", label: "First administrator email" }, { value: "owner@example.test" });
    await user.notSee({ text: /^release_not_configured$/ });
    const failed = (await world.faults.requestLog()).filter((entry) => entry.method === "POST" && entry.status === 503);
    evidence.recordAssertionEvidence("publication is separate from permissions and sign-in", `actual publication refusal=${failed.length}; entered email retained; publication owner named`, failed.length === 1);
    expect(failed.length).toBe(1);
    await user.screenshot();
  });
  await step("after: one retry prepares the cloud handoff, but approval and healthy services are not claimed", async () => {
    await user.click({ testId: "create-deployment-submit" });
    await user.see({ role: "button", label: "Copy command" }, { timeoutMs: 60_000 });
    await user.see({ text: /Running it approves the installation and creates or changes billable resources/ });
    await user.see({ testId: "managed-deployment-status" }, { text: "Awaiting Google Cloud approval" });
    const read = await probe.api(world.den.admin, "/v1/managed-deployments");
    const deployment = isRecord(read.body) ? records(read.body.deployments)[0] : null;
    const run = isRecord(deployment?.run) ? deployment.run : null;
    const requests = await world.faults.requestLog();
    const prepared = requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/launch") && entry.status === 200);
    const cloudActions = requests.filter((entry) => /\/enroll|\/events|\/heartbeat/.test(entry.path));
    expect(run?.state).toBe("awaiting_approval");
    expect(prepared).toHaveLength(1);
    expect(cloudActions).toHaveLength(0);
    evidence.recordAssertionEvidence("prepared never means approved or healthy", `local approval handoffs=${prepared.length}; observed run=${run?.state}; installer/enrollment/health actions=${cloudActions.length}`, read.response.ok && prepared.length === 1 && run?.state === "awaiting_approval" && cloudActions.length === 0);
    await user.screenshot();
  });
});
