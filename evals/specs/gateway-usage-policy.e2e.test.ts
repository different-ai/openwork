import { expect } from "vitest";
import { browserScript, spec, type User, type Probe } from "@openwork/testkit";
import { gatewayUsageLimitPolicySchema, gatewayUsagePeriod, gatewayUsageResetPageSchema, gatewayUsageStatusSchema, gatewayUsageTimeframes, type GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { gatewayUsagePolicy, usageRecord, usageRecords } from "../worlds/gateway-usage-policy.ts";

const test = spec.world(gatewayUsagePolicy, {
  timeout: 600_000,
  resources: { surfaces: ["web", "desktop"], services: ["den", "mock"], nativeReason: "Verify Electron submits a usage increase through its native UI and the same composer completes a real Gateway-backed assistant turn after Den approval." },
  needs: { commands: ["pnpm", "bun"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

const policyName = "Usage Member";
const reason = "Finish the synthetic integration review";
const ownPath = "/v1/gateway/usage-limits/me";
const requestsPath = "/v1/gateway/usage-limit-reset-requests";
const policiesPath = "/v1/gateway/usage-limit-policies";
const untrackedCoverage = {
  complete: false, unpricedRequests: 0, incompleteRequests: 0,
  historicalCoverage: "unknown", historicalUnknownReason: "tracking_not_started",
  trackingStartedAt: null, pendingRequests: null, settlementReady: false,
  lastSettlementAt: null, lastSettlementRequestId: null,
};

function expectSettledCoverage(status: GatewayUsageStatus) {
  const { trackingStartedAt, lastSettlementAt, lastSettlementRequestId } = status.coverage;
  if (!trackingStartedAt || !lastSettlementAt || !lastSettlementRequestId) throw new Error("Settled usage must carry its tracking and settlement receipt");
  const oldestStart = Math.min(...gatewayUsageTimeframes.map((frame) => gatewayUsagePeriod(frame, new Date(status.serverTime)).start.getTime()));
  const periodPredatesTracking = oldestStart < Date.parse(trackingStartedAt);
  expect(status.coverage).toMatchObject({
    complete: !periodPredatesTracking, unpricedRequests: 0, incompleteRequests: 0,
    historicalCoverage: periodPredatesTracking ? "unknown" : "tracked_since_epoch",
    historicalUnknownReason: periodPredatesTracking ? "period_predates_tracking" : null,
    pendingRequests: 0, settlementReady: true,
  });
  expect(Date.parse(lastSettlementAt)).toBeGreaterThanOrEqual(Date.parse(trackingStartedAt));
  expect(Date.parse(status.serverTime)).toBeGreaterThanOrEqual(Date.parse(lastSettlementAt));
}

test("GATEWAY-USAGE-01 admin policy blocks member Gateway calls until a reviewed 25% extension", async ({ world, user, agent, probe, seed, step, evidence }) => {
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const expectAdminRoute = async (path: string, tab: string) => {
    await adminProbe.eventually(() => adminProbe.eval(browserScript(() => `${location.pathname}${location.search}`, [])), {
      within: 15_000, label: `Den route ${path}`, until: (value) => value === path,
    });
    expect((await adminProbe.dom('[role="tab"][aria-selected="true"]')).elements.map((element) => element.text)).toEqual([tab]);
    expect((await adminProbe.dom(`[role="tabpanel"][aria-label="${tab}"]`)).elements).toHaveLength(1);
  };
  const member = user.on(world.desktop);
  const memberAgent = agent.on(world.desktop);
  const memberProbe = probe.on(world.desktop);
  const capture = async (name: string, surfaceUser: User, surfaceProbe: Probe, selector: string) => {
    let previous = "";
    const dom = await surfaceProbe.eventually(() => surfaceProbe.dom(selector), {
      within: 15_000, intervalMs: 250, label: `${name} settled visible geometry`,
      until: (value) => {
        const current = JSON.stringify(value);
        const settled = current === previous;
        previous = current;
        return settled && value.elements.length > 0 && value.elements.every(({ rect }) => rect.width > 0 && rect.height > 0);
      },
    });
    const viewport = await surfaceProbe.eval(browserScript(() => ({
      width: innerWidth, height: innerHeight, scale: devicePixelRatio,
      readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
      theme: document.documentElement.dataset.theme ?? getComputedStyle(document.documentElement).colorScheme,
    }), []));
    expect(viewport.readyState).toBe("complete");
    expect(viewport.visibility).toBe("visible");
    expect(dom.documentWidth).toBeLessThanOrEqual(dom.viewportWidth);
    for (const { rect } of dom.elements) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(viewport.width);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
    }
    const shot = await surfaceUser.screenshot();
    expect(shot.png.subarray(1, 4).toString()).toBe("PNG");
    const width = shot.png.readUInt32BE(16);
    const height = shot.png.readUInt32BE(20);
    expect(width).toBe(Math.round(viewport.width * viewport.scale));
    expect(height).toBe(Math.round(viewport.height * viewport.scale));
    evidence.recordAssertionEvidence(`${name}: real app screenshot and DOM dimensions`, JSON.stringify({ hash: shot.hash, width, height, viewport, elements: dom.elements.length }), true);
  };
  const own = async (identity = world.member, query = "") => {
    const result = await probe.api(identity, `${ownPath}${query}`);
    expect(result.response.status).toBe(200);
    return gatewayUsageStatusSchema.parse(result.body);
  };
  const policies = async () => {
    const result = await probe.api(world.den.admin, policiesPath);
    expect(result.response.status).toBe(200);
    return usageRecords(usageRecord(result.body).policies).map((row) => gatewayUsageLimitPolicySchema.parse(row));
  };
  const requests = async (identity = world.den.admin, suffix = "") => {
    const result = await probe.api(identity, `${requestsPath}${suffix}`);
    expect(result.response.status).toBe(200);
    const page = gatewayUsageResetPageSchema.parse(result.body);
    expect(page).toMatchObject({ view: suffix.includes("view=history") ? "history" : "pending", limit: 50, hasMore: false, nextCursor: null });
    expect(page.pendingCount).toBe(page.view === "pending" ? page.requests.length : 0);
    return page.requests;
  };
  expect(await own()).toMatchObject({ organizationId: world.orgId, memberId: world.memberId, state: "unlimited", buckets: [], coverage: untrackedCoverage });
  expect(await own(world.control)).toMatchObject({ memberId: world.controlId, state: "unlimited", buckets: [], coverage: untrackedCoverage });

  const policy = await step("admin sets Usage Member's monthly hard limit on the New limit page", async () => {
    await admin.navigate(new URL("/dashboard/ai-gateway?tab=limits", world.den.ref.webUrl).toString());
    await admin.see({ testId: "gateway-limits-empty" }, { timeoutMs: 90_000 });
    await expectAdminRoute("/dashboard/ai-gateway?tab=limits", "Limits");
    await admin.notSee({ testId: "gateway-users-teams" });
    await admin.click({ testId: "gateway-limit-new" });
    await admin.see({ testId: "gateway-limit-editor" }, { timeoutMs: 30_000 });
    await expectAdminRoute("/dashboard/ai-gateway/limits/new", "Limits");
    await admin.click({ role: "switch", label: "Everyone in the organization" });
    await admin.click({ testId: "gateway-limit-add-person" });
    await admin.click({ role: "combobox", label: "Person" });
    await admin.click({ role: "option", label: /Usage Member/ });
    await admin.see({ testId: "gateway-limit-who-row" }, { text: /Usage Member/ });
    await admin.type({ testId: "gateway-limit-amount-month" }, "1.000000");
    await capture("Den New spend limit amounts", admin, adminProbe, '[data-testid="gateway-limit-period-month"]');
    await admin.click({ testId: "gateway-limit-save" });
    await admin.see({ testId: "gateway-limit-row" }, { text: /\$1\.00 a month each/, timeoutMs: 30_000 });
    await expectAdminRoute("/dashboard/ai-gateway?tab=limits", "Limits");
    const saved = (await policies()).find((entry) => entry.name === policyName);
    expect(saved).toMatchObject({ hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costLimitMicroUsd: 1_000_000 }] });
    if (!saved) throw new Error("Policy not persisted by the New limit page");
    expect(saved.assignments).toEqual([{ id: expect.any(String), memberId: world.memberId, teamId: null, organization: false }]);
    expect((await adminProbe.dom('[data-testid="gateway-limit-row"]')).elements).toHaveLength(1);
    await capture("Den Limits row", admin, adminProbe, '[data-testid="gateway-limit-row"]');
    await admin.click({ role: "tab", label: "Users & Teams" });
    await admin.see({ testId: "gateway-users-teams" });
    await expectAdminRoute("/dashboard/ai-gateway?tab=users-and-teams", "Users & Teams");
    await admin.notSee({ testId: "gateway-limit-new" });
    await admin.notSee({ role: "combobox", label: "Find a person" });
    await admin.notSee({ role: "button", label: "Refresh requests" });
    const personRow = (memberId: string) => adminProbe.eventually(() => adminProbe.dom(`[data-testid="gateway-directory-person-row"][data-member-id="${memberId}"]`), {
      within: 30_000, intervalMs: 250, label: `directory row for ${memberId}`, until: (value) => value.elements.length === 1,
    });
    expect((await personRow(world.memberId)).elements[0]?.text).toMatch(/Usage Member[\s\S]*\$1\.00 a month[\s\S]*Their own limit/);
    expect((await personRow(world.controlId)).elements[0]?.text).toMatch(/Usage Control[\s\S]*No limit/);
    await admin.notSee({ role: "button", label: `Unassign ${policyName} from Usage Member` });
    expect((await adminProbe.dom('[data-testid="gateway-directory-person-row"]')).elements).toHaveLength(3);
    expect((await adminProbe.dom('[data-testid="gateway-directory-everyone"] [aria-label="Can use Usage journey provider"]')).elements).toHaveLength(1);
    await capture("Den Users and Teams directory", admin, adminProbe, '[data-testid="gateway-users-teams"]');
    await admin.click({ role: "link", label: /Usage Member/ });
    await expectAdminRoute(`/dashboard/ai-gateway/people/${world.memberId}`, "Users & Teams");
    await admin.see({ testId: "gateway-person-access-row" }, { text: /Usage journey provider[\s\S]*Everyone has it/, timeoutMs: 30_000 });
    await admin.click({ role: "link", label: "Back to Users & Teams" });
    await admin.see({ testId: "gateway-directory-everyone" }, { timeoutMs: 30_000 });
    return saved;
  });
  const initial = await own();
  expect(initial).toMatchObject({ state: "within_limit", coverage: untrackedCoverage, buckets: [{ policyId: policy.id, timeframe: "month", usedMicroUsd: 0, baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0, allowanceMicroUsd: 1_000_000 }] });
  expect(initial.buckets).toHaveLength(1);
  const initialBucket = initial.buckets[0];
  if (!initialBucket) throw new Error("Assigned bucket missing");
  expect(new Date(initialBucket.resetAt).getUTCHours()).toBe(5);

  await step("nested provider forms retain AI Providers and each person has a page with their limit", async () => {
    await admin.click({ role: "tab", label: "AI Providers" });
    await admin.see({ testId: "gateway-provider-create" });
    await expectAdminRoute("/dashboard/ai-gateway?tab=ai-providers", "AI Providers");
    await admin.notSee({ testId: "gateway-users-teams" });
    await admin.click({ testId: "gateway-provider-create" });
    await admin.see({ role: "heading", label: "Add a provider" });
    await expectAdminRoute("/dashboard/ai-gateway/providers/new", "AI Providers");
    await admin.see({ testId: "gateway-provider-catalog-filter" });
    await admin.click({ role: "link", label: "Back to AI Providers" });
    await admin.see({ testId: "gateway-provider-open" });
    await admin.click({ testId: "gateway-provider-open" });
    await admin.see({ testId: "gateway-provider-title" }, { timeoutMs: 30_000 });
    await expectAdminRoute(`/dashboard/ai-gateway/providers/${world.providerId}`, "AI Providers");
    await admin.see({ testId: "gateway-provider-save" });
    await admin.navigate(new URL(`/dashboard/ai-gateway/providers/${world.providerId}/edit`, world.den.ref.webUrl).toString());
    await admin.see({ testId: "gateway-provider-title" }, { timeoutMs: 30_000 });
    await expectAdminRoute(`/dashboard/ai-gateway/providers/${world.providerId}/edit`, "AI Providers");
    await admin.notSee({ role: "button", label: "Apply new usage limit" });
    await admin.click({ role: "tab", label: "Limits" });
    await admin.see({ role: "combobox", label: "Find a person" });
    await expectAdminRoute("/dashboard/ai-gateway?tab=limits", "Limits");
    await admin.click({ role: "combobox", label: "Find a person" });
    await admin.type({ role: "combobox", label: "Find a person" }, world.member.email);
    await admin.click({ role: "option", label: /Usage Member[\s\S]*usage-member@example\.test/ });
    await expectAdminRoute(`/dashboard/ai-gateway/people/${world.memberId}`, "Users & Teams");
    await admin.see({ testId: "gateway-person-limit" }, { text: /Within the limit/ });
    await admin.see({ testId: "gateway-person-limit-row" }, { text: /\$0\.00 used/ });
    await admin.see({ testId: "gateway-person-limit-row" }, { text: /\$1\.00 a month/ });
    await admin.navigate(new URL(`/dashboard/ai-gateway/people/${world.controlId}`, world.den.ref.webUrl).toString());
    await admin.see({ testId: "gateway-person-limit" }, { text: /No limit/, timeoutMs: 60_000 });
    await admin.notSee({ testId: "gateway-person-limit-row" });
    await admin.notSee({ role: "link", label: "Old Gateway" });
    for (const oldPath of [
      "/dashboard/gateway-providers",
      "/dashboard/gateway-providers/new",
      `/dashboard/gateway-providers/${world.providerId}`,
      `/dashboard/gateway-providers/${world.providerId}/edit`,
    ]) {
      await admin.navigate(new URL(oldPath, world.den.ref.webUrl).toString());
      await admin.see({ role: "heading", label: "404" });
      await admin.notSee({ testId: "gateway-provider-open" });
      await admin.notSee({ testId: "ai-gateway-tabs" });
      expect(await adminProbe.eval(browserScript(() => location.pathname, []))).toBe(oldPath);
    }
    await admin.navigate(new URL("/dashboard/inference?source=legacy&tag=one&tag=two&tab=limits", world.den.ref.webUrl).toString());
    await admin.see({ role: "heading", label: "OpenWork Models" });
    await expectAdminRoute("/dashboard/ai-gateway?tab=openwork-models&source=legacy&tag=one&tag=two", "OpenWork Models");
    await admin.see({ role: "heading", label: "Models" });
    await admin.notSee({ role: "link", label: "OpenWork Models" });
    await admin.notSee({ role: "button", label: "Apply new usage limit" });
    expect((await adminProbe.dom("h1")).elements).toHaveLength(1);
    await capture("Den OpenWork Models tab", admin, adminProbe, '[role="tabpanel"][aria-label="OpenWork Models"]');
    await admin.navigate(new URL("/dashboard/ai-gateway?tab=limits", world.den.ref.webUrl).toString());
    await admin.see({ role: "button", label: "Refresh requests" });
    await expectAdminRoute("/dashboard/ai-gateway?tab=limits", "Limits");
    expect(await policies()).toHaveLength(1);
    expect(world.upstreamCount()).toBe(0);
    evidence.recordAssertionEvidence("AI Gateway tab and nested form ownership", "New/edit provider forms stay within AI Providers without saving changes. The old Gateway sidebar link is absent and its list/new/detail/edit URLs show 404 without redirecting. The New limit page assigns only Usage Member; Usage Member's page reports $0.00 used of $1.00 a month and the unassigned control's page shows No limit. The legacy Models URL forwards to the OpenWork Models tab with repeated query values intact and no duplicate sidebar link or page heading. No upstream inference calls occurred.", true);
  });

  const sessionId = await step("member selects the actual managed Gateway model in a real Desktop session", async () => {
    await memberAgent.run("route.settings.appearance");
    await member.click({ role: "button", label: "Light" });
    await memberProbe.eventually(() => memberProbe.eval(browserScript(() => document.documentElement.dataset.theme, [])), {
      within: 5_000, label: "source Light theme selected for readable screenshots", until: (value) => value === "light",
    });
    await member.click({ role: "button", label: "Back to app" });
    const id = await memberAgent.createSession("Gateway usage composer verification");
    await memberAgent.run("session.model_picker.open");
    await member.type({ placeholder: "Search providers and models..." }, world.modelId);
    await member.see({ role: "button", label: new RegExp(world.modelId) }, { timeoutMs: 90_000 });
    await member.click({ role: "button", label: new RegExp(world.modelId) });
    await member.notSee({ placeholder: "Search providers and models..." });
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, modelUnavailable: false, composerEditable: true });
    await member.notSee({ testId: "gateway-usage-notice" });
    return id;
  });

  const openUsageFromAccountMenu = async (left: RegExp) => {
    await member.click({ role: "button", label: "Account menu" });
    await member.see({ testId: "gateway-usage-menu-item" }, { text: left, timeoutMs: 30_000 });
    await member.click({ testId: "gateway-usage-menu-item" });
    await member.see({ testId: "gateway-usage-settings" }, { timeoutMs: 30_000 });
  };
  const backToSession = async () => {
    await member.click({ role: "button", label: "Back to app" });
    await member.see("composer", { editable: true });
    expect(await memberAgent.run("session.open", { sessionId })).toMatchObject({ ok: true });
    await member.see("composer", { editable: true });
  };

  await step("own status is identity scoped and members cannot administer policies or another person's usage", async () => {
    expect(await own(world.control, `?memberId=${world.memberId}`)).toMatchObject({ memberId: world.controlId, state: "unlimited", buckets: [] });
    for (const path of [policiesPath, requestsPath, `/v1/gateway/usage-limits/members/${world.controlId}`]) {
      expect((await probe.api(world.member, path)).response.status).toBe(403);
    }
    expect((await seed.api(world.member, policiesPath, { method: "POST", body: JSON.stringify({ name: "Unauthorized policy", limits: [{ timeframe: "month", costUsd: "100" }] }) })).response.status).toBe(403);
    expect(await policies()).toHaveLength(1);
    await member.see({ role: "button", label: "Account menu" }, { timeoutMs: 90_000 });
    await openUsageFromAccountMenu(/This month\s*100% left/);
    await member.see({ text: /\$1\.00 of \$1\.00 left/ });
    await member.notSee({ role: "button", label: "Ask for $0.25 more" });
  });
  evidence.recordAssertionEvidence("Rendered Den assignment reaches only the intended member's real Desktop", "Monthly $1 hard/reset-enabled policy persisted through Den UI. Own-status identity injection did not change the control member; management requests returned 403; Desktop rendered zero used of $1.", true);

  const exhausted = await step("known settled upstream cost exhausts the bucket and a second real Gateway admission is blocked", async () => {
    expect(world.upstreamCount()).toBe(0);
    expect((await world.generate()).status).toBe(200);
    expect(world.upstreamCount()).toBe(1);
    expect(world.upstreamModel()).toBe("openai/gpt-4o-mini");
    expect(world.upstreamUsesOnlyOrgKey()).toBe(true);
    const status = await probe.eventually(own, { within: 15_000, intervalMs: 200, label: "real Gateway settles reported $1", until: (value) => value.state === "blocked" && value.coverage.settlementReady === true });
    expect(status.buckets).toEqual([{ ...initialBucket, usedMicroUsd: 1_000_000, remainingMicroUsd: 0, canRequestReset: true }]);
    expectSettledCoverage(status);
    const blocked = await world.generate();
    expect(blocked).toMatchObject({ status: 429, errorCode: "openwork_gateway_usage_limit_exceeded", usageState: "blocked", body: { error: { source: "openwork_gateway", code: "openwork_gateway_usage_limit_exceeded", details: { exhaustedBuckets: [{ bucketId: initialBucket.id, usedMicroUsd: 1_000_000, allowanceMicroUsd: 1_000_000 }] } } } });
    expect(world.upstreamCount()).toBe(1);
    expect((await own()).buckets).toEqual(status.buckets);
    expect(await own(world.control)).toMatchObject({ state: "unlimited", buckets: [] });
    await backToSession();
    await openUsageFromAccountMenu(/This month\s*0% left/);
    await member.see({ text: /\$0\.00 of \$1\.00 left/ });
    await member.see({ role: "button", label: "Ask for $0.25 more" });
    await capture("Desktop exhausted usage", member, memberProbe, '[aria-label="This month usage"]');
    return status;
  });
  evidence.recordAssertionEvidence("Gateway, not Desktop, blocks after known consumption", "First request settled 1000000 micro-USD; second returned trusted policy HTTP 429 without a second upstream call or charge. Desktop rendered exhaustion; the unassigned control stayed unlimited.", true);

  await step("real composer submission reaches the Gateway through the native engine and shows truthful own-status exhaustion", async () => {
    await backToSession();
    const rejectedBefore = await probe.eventually(() => world.rejectedCalls(), {
      within: 15_000, intervalMs: 200, label: "direct Gateway rejection finalized",
      until: (rows) => rows.length === 1,
    });
    const prompt = "Summarize the remaining work for this synthetic review.";
    expect(prompt).not.toContain(world.providerId);
    expect(prompt).not.toContain(world.modelId);
    await member.type("composer", prompt);
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, draftText: prompt, composerEditable: true });
    await memberAgent.run("composer.send");
    const rejectedAfter = await probe.eventually(() => world.rejectedCalls(), {
      within: 120_000, intervalMs: 500, label: "native engine request rejected by the real Gateway",
      until: (rows) => rows.length > rejectedBefore.length,
    });
    for (const row of rejectedAfter) expect(row).toMatchObject({ status: 429, error_code: "openwork_gateway_usage_limit_exceeded", org_membership_id: world.memberId, requested_model: world.modelId });
    const native = await probe.eventually(() => world.nativeMessages(sessionId), {
      within: 120_000, intervalMs: 500, label: "native engine records the submitted prompt and terminal assistant error",
      until: (value) => {
        if (!value.ok || !value.data.some((message) => message.parts.some((part) => part.text === prompt))) return false;
        const body = Array.isArray(value.body) ? value.body : usageRecord(value.body).data;
        return usageRecords(body).some((entry) => {
          const info = usageRecord(entry.info ?? entry);
          return (info.role === "assistant" || info.type === "assistant") && Boolean(info.error);
        });
      },
    });
    expect(native.ok).toBe(true);
    expect(world.upstreamCount()).toBe(1);
    expect((await own()).buckets).toEqual(exhausted.buckets);
    await member.see({ testId: "gateway-usage-notice" }, { text: /used this month’s \$1\.00/ });
    expect((await memberProbe.dom('[data-testid="gateway-usage-notice"]')).elements).toHaveLength(1);
    expect(await memberProbe.composer()).toMatchObject({ composerEditable: true, modelUnavailable: false });
    await capture("Desktop blocked composer", member, memberProbe, '[data-testid="gateway-usage-notice"]');
    evidence.recordAssertionEvidence("Native composer reaches the real Gateway and own status corroborates the custom notice", JSON.stringify({ engine: world.engine, rejectedBefore: rejectedBefore.length, rejectedAfter: rejectedAfter.length, upstreamRequests: world.upstreamCount(), nativePromptRecorded: true, nativeAssistantErrorRecorded: true, usedMicroUsd: exhausted.buckets[0]?.usedMicroUsd }), true);
    await member.see({ role: "button", label: "Ask for $0.25 more" });
  });

  const pending = await step("member submits a required reason from Desktop and cannot review the request", async () => {
    const blank = await seed.api(world.member, requestsPath, { method: "POST", body: JSON.stringify({ bucketId: initialBucket.id, reason: "   " }) });
    expect(blank.response.status).toBe(400);
    expect(await requests()).toEqual([]);
    await member.click({ role: "button", label: "Ask for $0.25 more" });
    await member.see({ role: "textbox", label: "What do you need it for?" });
    expect((await memberProbe.dom('[role="dialog"]')).elements).toHaveLength(0);
    await member.type({ role: "textbox", label: "What do you need it for?" }, reason);
    await capture("Desktop direct increase form", member, memberProbe, '[data-testid="gateway-usage-notice"]');
    await member.click({ role: "button", label: "Send request" });
    await probe.eventually(() => requests(world.member, "/me"), {
      within: 15_000, intervalMs: 200, label: "one Desktop increase request persisted",
      until: (rows) => rows.length === 1 && rows[0]?.reason === reason && rows[0]?.status === "pending",
    });
    await member.see({ testId: "gateway-usage-notice" }, { text: /Asked for \$0\.25 more this month[\s\S]*Waiting for an admin/, timeoutMs: 15_000 });
    await member.notSee({ role: "textbox", label: "What do you need it for?" });
    await member.notSee({ role: "button", label: "Ask for $0.25 more" });
    expect((await memberProbe.dom('[data-testid="gateway-usage-notice"]')).elements).toHaveLength(1);
    await capture("Desktop pending increase", member, memberProbe, '[data-testid="gateway-usage-notice"]');
    const rows = await requests();
    expect(rows).toHaveLength(1);
    const request = rows[0];
    if (!request) throw new Error("Desktop reset submission missing");
    expect(request).toMatchObject({ bucketId: initialBucket.id, memberId: world.memberId, reason, status: "pending", reviewedBy: null, reviewedAt: null });
    expect(await requests(world.member, "/me")).toEqual(rows);
    expect(await requests(world.control, "/me")).toEqual([]);
    expect((await seed.api(world.member, `${requestsPath}/${request.id}/approve`, { method: "POST" })).response.status).toBe(403);
    expect((await own()).buckets).toEqual(exhausted.buckets.map((bucket) => ({ ...bucket, resetRequestStatus: "pending", canRequestReset: false })));
    return request;
  });

  await step("admin reviews the actual reason in Den and approves exactly 25% without forgiving consumption", async () => {
    await admin.click({ role: "button", label: "Refresh requests" });
    await admin.see({ text: reason });
    await admin.see({ text: "+$0.25 allowance ($1.25 total); may increase provider charges; no undo." });
    await capture("Den pending request row", admin, probe.on(world.admin), '[aria-label="Pending increase request pages"] tbody tr');
    await admin.click({ role: "button", label: "Approve 25% for Usage Member, 1 month" });
    await admin.see({ text: "Request approved. Check the queue and history for the latest state." });
    const approved = await probe.eventually(own, { within: 15_000, intervalMs: 200, label: "approval restores real allowance", until: (value) => value.state === "within_limit" });
    expect(approved.buckets).toEqual([{ ...initialBucket, usedMicroUsd: 1_000_000, extensionMicroUsd: 250_000, allowanceMicroUsd: 1_250_000, remainingMicroUsd: 250_000, canRequestReset: false, resetRequestStatus: "approved" }]);
    expect(await requests()).toEqual([]);
    const history = await requests(world.den.admin, "?view=history");
    expect(history).toHaveLength(1);
    expect(await requests(world.member, "/me?view=history")).toEqual(history);
    expect(await requests(world.control, "/me?view=history")).toEqual([]);
    expect(history[0]).toMatchObject({ id: pending.id, status: "approved", reviewedBy: world.adminId, reviewedAt: expect.any(String), bucketId: initialBucket.id, usedMicroUsd: 1_000_000, allowanceMicroUsd: 1_250_000, resetAt: initialBucket.resetAt });
    await admin.see({ text: "No pending requests" });
    expect((await probe.on(world.admin).dom('[aria-label="Pending increase request pages"] tbody tr')).elements).toHaveLength(0);
    await admin.notSee({ role: "button", label: "Approve 25% for Usage Member, 1 month" });
    await admin.click({ text: "Previous requests" });
    await admin.see({ text: "Reviewer: Usage Admin" });
    expect((await probe.on(world.admin).dom('#gateway-reset-history tbody tr:nth-child(odd)')).elements).toHaveLength(1);
    expect((await probe.on(world.admin).dom('#gateway-reset-history tbody tr:nth-child(even)')).elements).toHaveLength(1);
    await admin.notSee({ role: "button", label: "Load more history" });
    await admin.see({ text: "Reviewer: Usage Admin" });
    await capture("Den approved history", admin, probe.on(world.admin), '#gateway-reset-history tbody tr');
    await openUsageFromAccountMenu(/This month\s*20% left/);
    await member.see({ text: /\$0\.25 of \$1\.25 left/ });
    await member.see({ text: /Added \$0\.25/ });
    await member.notSee({ text: /waiting for an admin/ });
    await member.notSee({ role: "button", label: "Ask for $0.25 more" });
    await capture("Desktop usage after approval", member, memberProbe, '[data-testid="gateway-usage-settings"]');
    await backToSession();
    await member.notSee({ testId: "gateway-usage-notice" }, { timeoutMs: 60_000 });
    await member.see({ testId: "gateway-usage-approved-notice" }, { text: /You got \$0\.25 more this month/ });
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, composerEditable: true, modelUnavailable: false });
    await capture("Desktop approved increase", member, memberProbe, '[data-testid="gateway-usage-approved-notice"]');
    expect(await own(world.control)).toMatchObject({ state: "unlimited", buckets: [] });
  });

  await step("after approval the same Desktop composer completes a native assistant turn through the real Gateway", async () => {
    world.streamSuccess();
    const prompt = "Continue the synthetic review with one brief plain-text summary. Do not use tools.";
    expect(prompt).not.toContain(world.providerId);
    expect(prompt).not.toContain(world.modelId);
    const rejectedBefore = await world.rejectedCalls();
    await member.type("composer", prompt);
    await memberProbe.eventually(() => memberProbe.composer(), {
      within: 30_000, label: "approved session is ready for a new composer send",
      until: (state) => state.runTaskEnabled && state.draftText === prompt,
    });
    await memberAgent.run("composer.send");
    const native = await probe.eventually(() => world.nativeMessages(sessionId), {
      within: 120_000, intervalMs: 500, label: "post-approval native assistant finishes successfully",
      until: (value) => {
        if (!value.ok || !value.data.some((message) => message.parts.some((part) => part.text === prompt))) return false;
        const body = Array.isArray(value.body) ? value.body : usageRecord(value.body).data;
        const last = usageRecords(body).at(-1);
        if (!last) return false;
        const info = usageRecord(last.info ?? last);
        return (info.role === "assistant" || info.type === "assistant") && !info.error && info.finish === "stop"
          && typeof usageRecord(info.time).completed === "number"
          && value.data.at(-1)?.parts.some((part) => part.type === "text" && part.text === "Complete café") === true;
      },
    });
    const body = Array.isArray(native.body) ? native.body : usageRecord(native.body).data;
    const completed = usageRecords(body).at(-1);
    if (!completed) throw new Error("Post-approval native assistant missing");
    const info = usageRecord(completed.info ?? completed);
    expect(info.error).toBeUndefined();
    expect(info.finish).toBe("stop");
    if (world.engine === "v1") expect(info).toMatchObject({ providerID: world.providerId, modelID: world.modelId });
    else expect(info.model).toMatchObject({ providerID: world.providerId, id: world.modelId });
    await member.see({ text: "Complete café" });
    await member.see("Run task", { timeoutMs: 30_000 });
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, composerEditable: true, modelUnavailable: false, draftText: "" });
    expect(world.upstreamCount()).toBe(2);
    expect(world.upstreamModel()).toBe("openai/gpt-4o-mini");
    expect(world.upstreamStreamed()).toBe(true);
    expect(world.upstreamUsesOnlyOrgKey()).toBe(true);
    const calls = await probe.eventually(() => world.successfulCalls(), {
      within: 15_000, intervalMs: 200, label: "post-approval native stream settles known upstream cost",
      until: (rows) => rows.length === 2 && rows.every((row) => row.cost_micro_usd === 1_000_000),
    });
    expect(calls.filter((row) => Boolean(row.stream))).toEqual([{ status: 200, outcome: "ok", cost_micro_usd: 1_000_000, stream: 1, org_membership_id: world.memberId, requested_model: world.modelId }]);
    const settled = await probe.eventually(own, {
      within: 15_000, intervalMs: 200, label: "native completion accounting writes finish",
      until: (value) => value.coverage.settlementReady === true && value.buckets[0]?.usedMicroUsd === 2_000_000,
    });
    expectSettledCoverage(settled);
    expect(settled.coverage.trackingStartedAt).toBe(exhausted.coverage.trackingStartedAt);
    expect(settled).toMatchObject({ state: "blocked", buckets: [{ id: initialBucket.id, usedMicroUsd: 2_000_000, extensionMicroUsd: 250_000, allowanceMicroUsd: 1_250_000, resetRequestStatus: "approved", canRequestReset: false }] });
    expect(await world.rejectedCalls()).toEqual(rejectedBefore);
    expect(await own(world.control)).toMatchObject({ state: "unlimited", buckets: [] });
    if (typeof info.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(info.id)) throw new Error("Native assistant has no valid message ID");
    const answerSelector = `[data-message-role="assistant"][data-message-id="${info.id}"]`;
    const answer = await memberProbe.dom(answerSelector);
    expect(answer.elements).toHaveLength(1);
    expect(answer.elements[0]?.text).toContain("Complete café");
    await capture("Desktop native recovery completed", member, memberProbe, answerSelector);
    evidence.recordAssertionEvidence("Den approval restores actual Desktop composer completion, not a direct HTTP bypass", JSON.stringify({ engine: world.engine, nativeAssistantCompleted: true, renderedAnswer: "Complete café", upstreamRequests: world.upstreamCount(), streamed: true, settledCostMicroUsd: 1_000_000, totalUsedMicroUsd: settled.buckets[0]?.usedMicroUsd, additionalRejections: 0 }), true);
  });
  evidence.recordAssertionEvidence("Desktop request and Den approval restore the same native session", "The member submitted a required reason through the blocked-notice dialog; Den displayed it and granted exactly 250000 micro-USD without forgiving consumption. After approval, a real Desktop composer send produced a completed native assistant and rendered answer with one streaming upstream call and a settled $1 cost. Total usage became $2, correctly exhausting the $1.25 allowance again; the control member remained unlimited.", true);
});
