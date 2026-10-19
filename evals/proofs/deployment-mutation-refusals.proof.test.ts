import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deploymentParentReadLock } from "../worlds/deployment-readiness-recovery.ts";

const test = spec.world(deploymentParentReadLock, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an owner keeps access recovery when an older prepare request later returns the parent rollout refusal", async ({ world, user, probe, step, evidence }) => {
  if (!world.operator || !world.deploymentId || !world.faults.arrivals) throw new Error("Missing isolated mutation-ordering fixture");
  const operator = user.on(world.operator);
  const arrivals = world.faults.arrivals;
  const path = `/api/den/v1/managed-deployments/${world.deploymentId}/launch`;
  let startedAt = 0;
  let requestAt = 0;
  let deniedAt = 0;
  await step("before: the owner can prepare approval for a verified target", async () => {
    await user.see({ text: "Observed deployment" }, { timeoutMs: 60_000 });
    await operator.see({ testId: "admin-capability-managedDeployments" }, { timeoutMs: 60_000 });
    const ready = await probe.dom('[data-deployment-read-state="verified"] [data-testid="deployment-prepare-install"]:not(:disabled)');
    expect(ready.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("preparation starts from verified access", `enabled preparation controls=${ready.elements.length}`, ready.elements.length === 1);
    await user.screenshot();
  });
  await step("a newer access refusal replaces cached details while the prepare request is still waiting", async () => {
    startedAt = Date.now();
    await world.faults.faults.latency(path, 25_000, { method: "POST", times: 1 });
    await user.click({ testId: "deployment-prepare-install" });
    const pending = await probe.eventually(arrivals, { within: 10_000, label: "the older prepare request is in flight", until: (value) => value.some((entry) => entry.at >= startedAt && entry.method === "POST" && entry.path === path) });
    requestAt = pending.find((entry) => entry.at >= startedAt && entry.method === "POST" && entry.path === path)?.at ?? 0;
    // Keep subsequent reads denied. The delayed POST still reaches the actual local API,
    // whose real parent feature guard is turned off through the shipped operator control.
    await world.faults.faults.status("/api/den/v1/managed-deployments", 403, { method: "GET", times: 20, body: { error: "forbidden" } });
    await operator.click({ testId: "admin-capability-managedDeployments" });
    const parent = await probe.eventually(() => probe.api(world.den.admin, "/v1/managed-deployments"), { within: 15_000, label: "the actual parent rollout guard is disabled", until: (value) => value.response.status === 404 });
    expect(parent.body).toEqual({ error: "feature_disabled", feature: "managedDeployments" });
    await user.see({ text: "Deployment access changed. Sign in again or ask an organization owner for access." }, { timeoutMs: 20_000 });
    await user.notSee({ testId: "managed-deployment-detail" });
    const requests = await world.faults.requestLog();
    deniedAt = requests.find((entry) => entry.at >= requestAt && entry.method === "GET" && entry.status === 403)?.at ?? 0;
    const late = requests.filter((entry) => entry.at >= startedAt && entry.method === "POST" && entry.path === path && entry.status === 404);
    expect(requestAt > 0 && deniedAt >= requestAt).toBe(true);
    expect(late).toHaveLength(0);
    evidence.recordAssertionEvidence("access denial is newer than the pending prepare request", `prepare arrived=${requestAt}; GET denied=${deniedAt}; completed late refusals=${late.length}; actual parent body=${JSON.stringify(parent.body)}`, requestAt > 0 && deniedAt >= requestAt && late.length === 0);
    await user.screenshot();
  });
  await step("after: the delayed prepare refusal cannot replace access recovery with operator-enablement advice", async () => {
    const requests = await probe.eventually(() => world.faults.requestLog(), { within: 30_000, label: "the older prepare request returns the real parent guard refusal", until: (value) => value.some((entry) => entry.at > deniedAt && entry.method === "POST" && entry.path === path && entry.status === 404) });
    const lateAt = requests.find((entry) => entry.at > deniedAt && entry.method === "POST" && entry.path === path && entry.status === 404)?.at ?? 0;
    // Capture after the actual delayed response, then verify the rendered recovery classification.
    await user.screenshot();
    await user.see({ text: "Deployment access changed. Sign in again or ask an organization owner for access." });
    await user.notSee({ text: /Deployment preparation is turned off|OpenWork operator|Observed deployment|feature_disabled|No deployments yet/ });
    const masked = await probe.dom('[data-deployment-read-state="access_denied"]');
    const create = await probe.dom('[data-testid="managed-deployment-create"]:disabled');
    expect(masked.elements).toHaveLength(1);
    expect(create.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the newer denial remains authoritative after the prepare response", `ordering=${requestAt} < ${deniedAt} < ${lateAt}; access-denied surfaces=${masked.elements.length}; disabled creation=${create.elements.length}`, requestAt <= deniedAt && deniedAt < lateAt && masked.elements.length === 1 && create.elements.length === 1);
  });
});

test("an owner keeps access recovery when an older create request returns the parent rollout refusal after its dialog unmounts", async ({ world, user, probe, step, evidence }) => {
  if (!world.operator || !world.faults.arrivals) throw new Error("Missing isolated mutation-ordering fixture");
  const operator = user.on(world.operator);
  const arrivals = world.faults.arrivals;
  const path = "/api/den/v1/managed-deployments";
  let startedAt = 0;
  let requestAt = 0;
  let deniedAt = 0;
  await step("before: the owner enters a target and explicitly consents to billable approval", async () => {
    await user.see({ text: "Observed deployment" }, { timeoutMs: 60_000 });
    await operator.see({ testId: "admin-capability-managedDeployments" }, { timeoutMs: 60_000 });
    await user.click({ testId: "managed-deployment-create" });
    await user.type({ role: "textbox", label: "Google Cloud project ID" }, "openwork-fixture");
    await user.type({ role: "textbox", label: "Google Cloud project number" }, "123456789012");
    await user.type({ role: "textbox", label: "Address" }, "new-target.example.test");
    await user.type({ role: "textbox", label: "Cloud DNS managed zone name for that address" }, "example-test");
    await user.type({ role: "textbox", label: "First administrator email" }, "owner@example.test");
    await user.click({ role: "checkbox", label: /I control this Google Cloud project/ });
    const ready = await probe.dom('[data-testid="create-deployment-submit"]:not(:disabled)');
    expect(ready.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the create request starts from a consented scoped draft", `enabled create controls=${ready.elements.length}; new target=new-target.example.test`, ready.elements.length === 1);
    await user.screenshot();
  });
  await step("a newer access refusal unmounts the dialog while its create request is still waiting", async () => {
    startedAt = Date.now();
    await world.faults.faults.latency(path, 25_000, { method: "POST", times: 1 });
    await user.click({ testId: "create-deployment-submit" });
    const pending = await probe.eventually(arrivals, { within: 10_000, label: "the older create request is in flight", until: (value) => value.some((entry) => entry.at >= startedAt && entry.method === "POST" && entry.path === path) });
    requestAt = pending.find((entry) => entry.at >= startedAt && entry.method === "POST" && entry.path === path)?.at ?? 0;
    await world.faults.faults.status(path, 403, { method: "GET", times: 20, body: { error: "forbidden" } });
    await operator.click({ testId: "admin-capability-managedDeployments" });
    const parent = await probe.eventually(() => probe.api(world.den.admin, "/v1/managed-deployments"), { within: 15_000, label: "the actual parent rollout guard is disabled", until: (value) => value.response.status === 404 });
    expect(parent.body).toEqual({ error: "feature_disabled", feature: "managedDeployments" });
    await user.see({ text: "Deployment access changed. Sign in again or ask an organization owner for access." }, { timeoutMs: 20_000 });
    await user.notSee({ testId: "create-deployment-dialog" });
    await user.notSee({ testId: "managed-deployment-detail" });
    const requests = await world.faults.requestLog();
    deniedAt = requests.find((entry) => entry.at >= requestAt && entry.method === "GET" && entry.status === 403)?.at ?? 0;
    const late = requests.filter((entry) => entry.at >= startedAt && entry.method === "POST" && entry.path === path && entry.status === 404);
    expect(requestAt > 0 && deniedAt >= requestAt).toBe(true);
    expect(late).toHaveLength(0);
    evidence.recordAssertionEvidence("the dialog unmounts before its response can arrive", `create arrived=${requestAt}; GET denied=${deniedAt}; completed late refusals=${late.length}; actual parent body=${JSON.stringify(parent.body)}`, requestAt > 0 && deniedAt >= requestAt && late.length === 0);
    await user.screenshot();
  });
  await step("after: the unmounted dialog cannot replace the newer access recovery", async () => {
    const requests = await probe.eventually(() => world.faults.requestLog(), { within: 30_000, label: "the older create request returns the real parent guard refusal", until: (value) => value.some((entry) => entry.at > deniedAt && entry.method === "POST" && entry.path === path && entry.status === 404) });
    const lateAt = requests.find((entry) => entry.at > deniedAt && entry.method === "POST" && entry.path === path && entry.status === 404)?.at ?? 0;
    await user.screenshot();
    await user.see({ text: "Deployment access changed. Sign in again or ask an organization owner for access." });
    await user.notSee({ testId: "create-deployment-dialog" });
    await user.notSee({ text: /Deployment preparation is turned off|OpenWork operator|Observed deployment|feature_disabled|No deployments yet|new-target.example.test/ });
    const masked = await probe.dom('[data-deployment-read-state="access_denied"]');
    const create = await probe.dom('[data-testid="managed-deployment-create"]:disabled');
    expect(masked.elements).toHaveLength(1);
    expect(create.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the newer denial remains authoritative after the create response", `ordering=${requestAt} < ${deniedAt} < ${lateAt}; access-denied surfaces=${masked.elements.length}; disabled creation=${create.elements.length}`, requestAt <= deniedAt && deniedAt < lateAt && masked.elements.length === 1 && create.elements.length === 1);
  });
});
