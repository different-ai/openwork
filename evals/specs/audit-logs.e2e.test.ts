import { expect } from "vitest";
import { spec, type User } from "@openwork/testkit";
import { auditEventsResponseSchema, auditEventTypesResponseSchema, auditOperationsResponseSchema, auditUsageResponseSchema } from "@openwork/types/den/audit";
import { auditLogs } from "../worlds/audit-logs.ts";

const test = spec.world(auditLogs, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

async function enterPastDate(owner: User, label: string, day: string) {
  const parts = ["1", day, "2000", "1", "0", "a"];
  for (const [segment, value] of parts.entries()) {
    await owner.click({ label });
    for (let index = 0; index < 8; index += 1) await owner.press("ArrowLeft");
    for (let index = 0; index < segment; index += 1) await owner.press("ArrowRight");
    for (const key of value) await owner.press(key);
  }
  await owner.press("Tab");
  await owner.see({ label }, { value: `2000-01-${day.padStart(2, "0")}T01:00` });
}

test("a flagged owner records and filters audit history by default while an unflagged owner and a teammate cannot read it", { timeout: 1_200_000 }, async ({ world, user, probe, seed, step, evidence }) => {
  const owner = user.on(world.web);
  const audit = probe.on(world.web);
  const teammate = user.on(world.memberWeb);
  const unflaggedOwner = user.on(world.unflaggedWeb);
  const hiddenAudit = probe.on(world.unflaggedWeb);
  const operationsPath = "/v1/audit/operations?limit=50";
  const providerOperationsPath = `${operationsPath}&action=provider.credential.updated&resourceId=${encodeURIComponent(world.providerId)}`;
  const groupedRow = { role: "button", label: "View changes for Provider configuration update committed" } satisfies Parameters<User["see"]>[0];
  const idSearches: Array<{ label: string; value: string }> = [];
  let operationId = "";
  let initializationOperationId = "";
  let originalEventIds: string[] = [];

  async function openEventTypes() {
    // Navigation mounts the filter before its independently fetched catalog is
    // ready. Observe readiness; never dispatch a click to a disabled control.
    await audit.eventually(() => audit.dom('button[aria-label="Event type"]:not(:disabled)'), {
      within: 30_000, label: "Event catalog is ready for selection", until: (value) => value.elements.length === 1,
    });
    await owner.click({ role: "button", label: "Event type" });
  }

  async function selectEventType(text: string, search?: string) {
    await openEventTypes();
    if (search) await owner.type({ label: "Search event types" }, search, { verify: true });
    // Target the displayed option text: the menu's enclosing label names the
    // whole field, and its text span receives the user's click on the option.
    await owner.click({ text });
  }

  async function filterAndFindOperation(eventType: string, search: string, rowLabel: string) {
    await selectEventType(eventType, search);
    await owner.click({ role: "button", label: "Apply filters" });
    await historySettled();
    await owner.see({ role: "button", label: `View changes for ${rowLabel}` }, { timeoutMs: 30_000 });
  }

  async function onlyOperationWith(action: string) {
    const response = await probe.api(world.den.admin, `${operationsPath}&action=${encodeURIComponent(action)}`);
    expect(response.response.status).toBe(200);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(history.operations).toHaveLength(1);
    const operation = history.operations[0];
    if (!operation) throw new Error(`No operation recorded ${action}`);
    const eventsResponse = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(operation.id)}/events?limit=50`);
    expect(eventsResponse.response.status).toBe(200);
    const events = auditEventsResponseSchema.parse(eventsResponse.body).events.sort((a, b) => a.sequence - b.sequence);
    return { operation, events, text: eventsResponse.text };
  }

  async function expandedTimeline(operation: { id: string }, count: number) {
    const selector = `[id="audit-operation-${operation.id}"] [data-testid="audit-event"]`;
    const events = await audit.eventually(() => audit.dom(selector), { within: 30_000, label: "Expanded operation lists every event", until: (value) => value.elements.length === count });
    // Each event starts with two lines: title + result, then actor + time.
    const heads = (await audit.dom(`${selector} > div > *`)).elements.map((element) => element.text);
    const cells = (await audit.dom(`${selector} tbody td`)).elements.map((cell) => cell.text);
    return {
      events: events.elements.map((event, index) => ({ headline: heads.slice(index * 4, index * 4 + 3).join(" · "), text: event.text })),
      changes: Array.from({ length: cells.length / 3 }, (_, index) => cells.slice(index * 3, index * 3 + 3).join(" | ")),
    };
  }

  async function operationRow(operation: { id: string }) {
    const row = await audit.dom(`tr:has(> td button[aria-controls="audit-operation-${operation.id}"]) > td`);
    expect(row.elements).toHaveLength(7);
    const [action = "", actor = "", origin = "", , result = ""] = row.elements.map((cell) => cell.text);
    return { action, actor, origin, result, summary: `${action} · ${actor} · ${origin} · ${result}` };
  }

  async function seeGroupedOperation() {
    await historySettled();
    await owner.see(groupedRow, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "audit-empty" });
    expect((await audit.dom(`button[aria-controls="audit-operation-${operationId}"]`)).elements).toHaveLength(1);
  }

  async function historySettled() {
    await audit.eventually(() => audit.dom('div[aria-busy="false"]:has(> [data-testid="audit-empty"]), div[aria-busy="false"]:has(button[aria-controls^="audit-operation-"])'), {
      within: 30_000, label: "Applied audit history has finished loading", until: (value) => value.elements.length > 0,
    });
  }

  async function filterProviderHistory() {
    await selectEventType("Provider credential updated");
    await owner.click({ role: "button", label: "Apply filters" });
    await historySettled();
  }

  await step("before: an entitled owner without the release flag has no audit navigation", async () => {
    await unflaggedOwner.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    const response = await probe.api(world.unflaggedOwner, "/v1/org");
    expect(response.response.status).toBe(200);
    expect(response.body).toMatchObject({ organization: { id: world.unflaggedOrgId }, currentMember: { isOwner: true }, entitlements: { auditLogs: true }, capabilities: { auditLogs: false } });
    await unflaggedOwner.notSee({ role: "link", label: "Audit logs" });
    const links = await hiddenAudit.dom('[data-testid="den-org-sidebar"] a[href="/dashboard/audit-logs"]');
    expect(links.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Entitlement does not reveal the hidden feature", `The second organization owner is entitled, its auditLogs capability is false, and ${links.elements.length} audit sidebar links are present.`, links.elements.length === 0);
    await unflaggedOwner.screenshot();
  });

  await step("before: the unflagged owner cannot find audit logs in the command palette", async () => {
    await unflaggedOwner.click({ role: "button", label: "Search or jump to" });
    await unflaggedOwner.see({ testId: "den-command-palette" });
    await unflaggedOwner.type({ testId: "den-command-palette-input" }, "Audit logs", { verify: true });
    await unflaggedOwner.see({ text: "No matches for “Audit logs”." });
    await unflaggedOwner.notSee({ role: "option", label: "Audit logs" });
    const options = await hiddenAudit.dom('[data-testid="den-command-palette"] [role="option"]');
    expect(options.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Hidden audit logs are absent from search", `Searching Audit logs returns ${options.elements.length} command-palette options and the no-matches state.`, options.elements.length === 0);
    await unflaggedOwner.screenshot();
    await unflaggedOwner.press("Escape");
  });

  await step("before: the unflagged owner's direct link is unavailable and the API denies audit access", async () => {
    await unflaggedOwner.navigate(`${world.den.ref.webUrl}/dashboard/audit-logs`);
    await unflaggedOwner.see({ testId: "audit-locked" }, { text: "Audit logs are not enabled for this organization.", timeoutMs: 60_000 });
    await unflaggedOwner.notSee({ label: "Search IDs" });
    await unflaggedOwner.notSee({ role: "button", label: "Refresh history" });
    await unflaggedOwner.notSee({ role: "switch", label: "Capture audit logs" });
    await unflaggedOwner.notSee({ text: "Capture and storage" });
    const statuses: number[] = [];
    for (const path of [operationsPath, "/v1/audit/event-types", "/v1/audit/usage", "/v1/audit/export"]) {
      const response = await probe.api(world.unflaggedOwner, path);
      statuses.push(response.response.status);
      expect(response.response.status).toBe(403);
      expect(response.body).toEqual({ error: "audit_feature_disabled" });
    }
    evidence.recordAssertionEvidence("The release flag is enforced despite owner permission and entitlement", `Operations, catalog, usage and export return ${statuses.join("/")} audit_feature_disabled; the direct route shows the neutral unavailable message.`, statuses.every((status) => status === 403));
    await unflaggedOwner.screenshot();
  });

  await step("before: the flagged owner is already recording with no provider changes retained", async () => {
    await owner.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 90_000 });
    await filterProviderHistory();
    await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
    const response = await probe.api(world.den.admin, providerOperationsPath);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(response.response.status).toBe(200);
    expect(history.operations).toHaveLength(0);
    await owner.see({ role: "link", label: "Audit logs" });
    await owner.click({ text: "Capture and storage" });
    await owner.see({ text: "Recording" });
    const usageResponse = await probe.api(world.den.admin, "/v1/audit/usage");
    expect(usageResponse.response.status).toBe(200);
    const usage = auditUsageResponseSchema.parse(usageResponse.body);
    expect(usage.entitlement).toEqual({ enabled: true, source: "self_hosted" });
    expect(usage.captureAvailable).toBe(true);
    expect(usage.captureOn).toBe(true);
    expect(usage.captureEnabled).toBe(true);
    expect(usage.policy).toMatchObject({
      revision: 1, enabled: true, source: "operator", allowance: 6_000_000, excessMode: "keep_all", attachmentWindowSeconds: 300,
      categories: ["change", "security", "execution", "access", "request", "lifecycle"],
    });
    expect(usage.policy?.captureStartedAt).toEqual(expect.any(String));
    expect(usage.retainedOperations).toBeGreaterThan(0);
    await owner.see({ text: "6,000,000" });
    await owner.see({ text: "Instance operator" });
    await owner.see({ text: "Keep all" });
    expect((await audit.dom('[role="switch"][aria-label="Capture audit logs"][aria-checked="true"]')).elements).toHaveLength(1);
    // Bring the allowance into the viewport alongside the recording state.
    await owner.click({ text: "Operation allowance" });
    evidence.recordAssertionEvidence("Default rollout records before any manual toggle", `No policy was seeded. The lazily initialized revision ${usage.policy?.revision} operator/keep_all policy is ON with a displayed 6,000,000-operation allowance, 300-second window and access capture; ${usage.retainedOperations} total operations already exist, with ${history.operations.length} matching provider credential changes.`, usage.captureAvailable && usage.captureOn && usage.captureEnabled && usage.policy?.allowance === 6_000_000 && history.operations.length === 0);
    await owner.screenshot();
    await owner.click({ text: "Capture and storage" });
    await owner.click({ role: "heading", label: "Audit logs" });
  });

  await step("before: one system initialization and administrator reads are already in history", async () => {
    const response = await probe.api(world.den.admin, `${operationsPath}&action=audit.policy.initialized`);
    expect(response.response.status).toBe(200);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(history.operations).toHaveLength(1);
    expect(history.nextCursor).toBeNull();
    const initialization = history.operations[0];
    if (!initialization) throw new Error("Missing automatic policy initialization");
    initializationOperationId = initialization.id;
    const eventsResponse = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(initialization.id)}/events?limit=50`);
    expect(eventsResponse.response.status).toBe(200);
    const timeline = auditEventsResponseSchema.parse(eventsResponse.body);
    expect(timeline.events).toHaveLength(1);
    expect(timeline.nextCursor).toBeNull();
    expect(timeline.events[0]).toMatchObject({ action: "audit.policy.initialized", actor: { type: "system", id: "den-api.audit-defaults" }, changes: { before: null, after: { allowance: 6_000_000, enabled: true, source: "operator", excessMode: "keep_all" } } });
    const readsResponse = await probe.api(world.den.admin, `${operationsPath}&action=audit.operations.served`);
    expect(readsResponse.response.status).toBe(200);
    const reads = auditOperationsResponseSchema.parse(readsResponse.body);
    expect(reads.operations.length).toBeGreaterThan(0);
    await selectEventType("Audit policy initialized");
    await owner.click({ role: "button", label: "Apply filters" });
    await historySettled();
    await owner.see({ role: "button", label: "View changes for Audit policy initialized" });
    evidence.recordAssertionEvidence("Real initialization and read capture are retained", `Exactly ${timeline.events.length} system initialization event in ${initialization.id}; the read-action query returns ${reads.operations.length} administrator read operations on this page. Default access capture is active.`, timeline.events.length === 1 && reads.operations.length > 0);
    await owner.screenshot();
    await filterProviderHistory();
  });

  await step("the owner sees dates, event type and Search IDs without opening More filters", async () => {
    await owner.see({ label: "From (local time)" });
    await owner.see({ label: "To (local time)" });
    await owner.see({ role: "button", label: "Event type" });
    await owner.see({ label: "Search IDs" });
    await owner.see({ text: "More filters" });
    const primary = await audit.dom('[data-testid="audit-primary-filters"] [aria-label]');
    expect(primary.elements).toHaveLength(4);
    expect(primary.documentWidth).toBeLessThanOrEqual(primary.viewportWidth);
    for (const { rect } of primary.elements) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(primary.viewportWidth);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(world.viewport.height);
    }
    expect((await audit.dom('form[aria-label="Filter audit operations"] > details[open]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Four primary filters are visible without expansion", `${primary.elements.length} primary controls fit in the ${primary.viewportWidth}px viewport; More filters is closed.`, primary.elements.length === 4 && primary.documentWidth <= primary.viewportWidth);
    await owner.screenshot();
  });

  await step("history with no provider changes still offers the full server event-type catalog", async () => {
    const response = await probe.api(world.den.admin, "/v1/audit/event-types");
    expect(response.response.status).toBe(200);
    const catalog = auditEventTypesResponseSchema.parse(response.body);
    expect(catalog.eventTypes).toContain("provider.credential.updated");
    expect(catalog.eventTypes).toContain("provider.created");
    expect(catalog.eventTypes).toContain("audit.policy.enabled");
    expect(catalog.eventTypes).toContain("audit.policy.initialized");
    await owner.click({ role: "button", label: "Event type" });
    const options = await audit.eventually(() => audit.dom('[role="listbox"] [role="option"]'), { within: 30_000, label: "Full event catalog is available before provider changes", until: (value) => value.elements.length === catalog.eventTypes.length + 1 });
    const labels = options.elements.map((option) => option.text);
    expect(labels).toContain("All event types");
    expect(labels).toContain("Provider credential updated");
    expect(labels).toContain("Provider created");
    expect(labels).toContain("Audit policy enabled");
    await owner.see({ text: "Provider credential updated" });
    evidence.recordAssertionEvidence("The catalog is not derived from loaded operation summaries", `${catalog.eventTypes.length} server event types and ${options.elements.length - 1} dropdown event types are available with no matching provider changes; system initialization and administrator reads already exist.`, options.elements.length === catalog.eventTypes.length + 1);
    await owner.screenshot();
    await owner.press("Escape");
  });

  await step("the owner opens More filters for Result, Origin and Actor", async () => {
    await owner.click({ text: "More filters" });
    await owner.see({ role: "button", label: "Result" });
    await owner.see({ role: "button", label: "Origin" });
    await owner.see({ role: "button", label: "Actor" });
    const secondary = await audit.dom('form[aria-label="Filter audit operations"] > details[open] button[aria-haspopup="listbox"]');
    expect(secondary.elements).toHaveLength(3);
    evidence.recordAssertionEvidence("Secondary filters remain available behind More filters", `${secondary.elements.length} secondary dropdowns are visible after expansion: Actor, Result and Origin.`, secondary.elements.length === 3);
    await owner.screenshot();
    await owner.click({ text: "More filters" });
  });

  await step("the owner replaces the shared key and removes organization-wide access in one save", async () => {
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/${encodeURIComponent(world.providerId)}`);
    await owner.see({ testId: "gateway-provider-title" }, { text: "Team models", timeoutMs: 60_000 });
    await owner.click({ testId: "gateway-provider-replace-key" });
    await owner.type({ testId: "gateway-provider-api-key" }, world.replacementCredential, { sensitive: true, verify: true });
    await owner.click({ role: "switch", label: "Everyone in the organization" });
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-open" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "gateway-provider-audience" }, { text: "No one yet" });
    await owner.notSee({ testId: "gateway-provider-api-key" });
    const response = await probe.api(world.den.admin, `/v1/inference-providers/${encodeURIComponent(world.providerId)}`);
    expect(response.response.status).toBe(200);
    expect(response.text).not.toContain(world.originalCredential);
    expect(response.text).not.toContain(world.replacementCredential);
    evidence.recordAssertionEvidence("The provider save completed without exposing credentials", `Provider details returned ${response.response.status}; the UI reports no one has access and neither synthetic key appears in the response.`, response.response.status === 200 && !response.text.includes(world.originalCredential) && !response.text.includes(world.replacementCredential));
    await owner.screenshot();
  });

  await step("after: several provider requests appear as one audit operation", async () => {
    await owner.click({ role: "link", label: "Audit logs" });
    await owner.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 30_000 });
    await filterProviderHistory();
    await owner.see({ text: "First recorded target" });
    await owner.see({ role: "button", label: "View changes for Provider configuration update committed" });
    const response = await probe.api(world.den.admin, providerOperationsPath);
    expect(response.response.status).toBe(200);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(history.operations).toHaveLength(1);
    const operation = history.operations[0];
    if (!operation) throw new Error("No grouped provider operation returned");
    operationId = operation.id;
    expect(operation.action).toBe("provider.configuration.update.committed");
    const eventsResponse = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
    const timeline = auditEventsResponseSchema.parse(eventsResponse.body);
    expect(eventsResponse.response.status).toBe(200);
    expect(timeline.nextCursor).toBeNull();
    originalEventIds = timeline.events.map((event) => event.id);
    const requests = new Set(timeline.events.map((event) => event.requestId).filter(Boolean));
    expect(requests.size).toBeGreaterThanOrEqual(3);
    expect(new Set(timeline.events.map((event) => event.operationId)).size).toBe(1);
    expect(timeline.events.some((event) => event.action === "provider.credential.updated")).toBe(true);
    expect(timeline.events.some((event) => event.action === "provider.access_grant.deleted")).toBe(true);
    const credentialEvent = timeline.events.find((event) => event.action === "provider.credential.updated");
    const resource = credentialEvent?.resources.find((resource) => resource.relationship === "target");
    if (!credentialEvent?.requestId || !resource?.id) throw new Error("Credential change must expose its own event, request and target resource IDs");
    expect(timeline.events.some((event) => event.action === "provider.created")).toBe(false);
    idSearches.push({ label: "operation", value: operationId }, { label: "event", value: credentialEvent.id }, { label: "request", value: credentialEvent.requestId }, { label: "resource", value: resource.id });
    expect(new Set(idSearches.map((entry) => entry.value)).size).toBe(4);
    await seeGroupedOperation();
    evidence.recordAssertionEvidence("One operation groups the complete save", `The provider credential action and resource query returns ${history.operations.length} operation containing ${timeline.events.length} events across ${requests.size} requests, including credential replacement and access-grant removal; other history contains initialization and reads.`, history.operations.length === 1 && requests.size >= 3 && timeline.events.every((event) => event.operationId === operationId));
    await owner.screenshot();
  });

  await step("after: selecting a child event type returns its whole grouped operation", async () => {
    await selectEventType("Provider created");
    await owner.click({ role: "button", label: "Apply filters" });
    await historySettled();
    await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
    await owner.notSee(groupedRow);
    await selectEventType("Provider credential updated");
    await owner.click({ role: "button", label: "Apply filters" });
    await owner.see({ role: "button", label: "Event type" }, { text: "Provider credential updated" });
    await seeGroupedOperation();
    const response = await probe.api(world.den.admin, providerOperationsPath);
    expect(response.response.status).toBe(200);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(history.operations.map((operation) => operation.id)).toEqual([operationId]);
    expect(history.operations[0]?.action).not.toBe("provider.credential.updated");
    evidence.recordAssertionEvidence("A child event filters the group, not just its first-row summary", `Provider created returns zero rows; Provider credential updated returns one grouped operation (${operationId}) whose summary action is ${history.operations[0]?.action}.`, history.operations.length === 1 && history.operations[0]?.id === operationId);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Clear filters" });
    await owner.see({ role: "button", label: "Event type" }, { text: "All event types" });
    await filterProviderHistory();
    await seeGroupedOperation();
  });

  for (const { label, value } of idSearches) {
    await step(`after: the owner finds the grouped operation by exact ${label} ID, never a prefix`, async () => {
      expect(value.length).toBeGreaterThan(1);
      await owner.type({ label: "Search IDs" }, value.slice(0, -1), { replace: true, verify: true });
      await owner.click({ role: "button", label: "Apply filters" });
      await historySettled();
      await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
      await owner.notSee(groupedRow);
      await owner.type({ label: "Search IDs" }, value, { replace: true, verify: true });
      await owner.click({ role: "button", label: "Apply filters" });
      await owner.see({ label: "Search IDs" }, { value });
      await seeGroupedOperation();
      const prefixResponse = await probe.api(world.den.admin, `${providerOperationsPath}&searchId=${encodeURIComponent(value.slice(0, -1))}`);
      expect(prefixResponse.response.status).toBe(200);
      expect(auditOperationsResponseSchema.parse(prefixResponse.body).operations).toHaveLength(0);
      const response = await probe.api(world.den.admin, `${providerOperationsPath}&searchId=${encodeURIComponent(value)}`);
      expect(response.response.status).toBe(200);
      const history = auditOperationsResponseSchema.parse(response.body);
      expect(history.operations.map((operation) => operation.id)).toEqual([operationId]);
      expect(history.nextCursor).toBeNull();
      evidence.recordAssertionEvidence(`Exact ${label} ID finds the same grouped operation`, `Within provider credential changes, the ${label} ID prefix returns zero rows in UI and API; the complete ID returns only ${operationId}, with no next page; searchId read returned HTTP ${response.response.status}.`, history.operations.length === 1 && history.operations[0]?.id === operationId);
      await owner.screenshot();
      await owner.click({ role: "button", label: "Clear filters" });
      await owner.see({ label: "Search IDs" }, { value: "" });
      await filterProviderHistory();
    });
  }

  await step("a local date range before the save excludes the grouped operation", async () => {
    await seeGroupedOperation();
    await enterPastDate(owner, "From (local time)", "1");
    await enterPastDate(owner, "To (local time)", "2");
    await owner.click({ role: "button", label: "Apply filters" });
    await historySettled();
    await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
    await owner.notSee(groupedRow);
    await owner.see({ label: "From (local time)" }, { value: "2000-01-01T01:00" });
    await owner.see({ label: "To (local time)" }, { value: "2000-01-02T01:00" });
    const rows = await audit.dom('button[aria-controls^="audit-operation-"]');
    expect(rows.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("An excluding date range has no matching operations", `The applied local range 2000-01-01 01:00 to 2000-01-02 01:00 returns ${rows.elements.length} grouped rows and the filtered empty state.`, rows.elements.length === 0);
    await owner.screenshot();
  });

  await step("after: Clear filters empties both dates and restores the same grouped operation", async () => {
    await owner.click({ role: "button", label: "Clear filters" });
    await owner.see({ label: "From (local time)" }, { value: "" });
    await owner.see({ label: "To (local time)" }, { value: "" });
    await owner.see({ label: "Search IDs" }, { value: "" });
    await owner.see({ role: "button", label: "Event type" }, { text: "All event types" });
    // Reads can push the saved operation beyond the unfiltered first page.
    // Reapply its child action after verifying Clear resets every field.
    await filterProviderHistory();
    await seeGroupedOperation();
    const rows = await audit.dom(`button[aria-controls="audit-operation-${operationId}"]`);
    evidence.recordAssertionEvidence("Clearing filters restores access to the saved operation", `Both local dates and Search IDs reset to empty and event type resets to All; reselecting Provider credential updated restores ${rows.elements.length} row for ${operationId} despite growing read history.`, rows.elements.length === 1);
    await owner.screenshot();
  });

  await step("the owner expands the operation to read changes without revealing secret values", async () => {
    await owner.click({ role: "button", label: "View changes for Provider configuration update committed" });
    await owner.see({ text: "Provider credential updated" }, { timeoutMs: 30_000 });
    await owner.see({ text: "Before" });
    await owner.see({ text: "After" });
    await owner.see({ text: "Provider access grant deleted" });
    await owner.see({ text: "None" });
    await owner.see({ text: "Changed; values not retained" });
    await owner.notSee({ text: world.originalCredential });
    await owner.notSee({ text: world.replacementCredential });
    const response = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
    const timeline = auditEventsResponseSchema.parse(response.body);
    expect(response.text).not.toContain(world.originalCredential);
    expect(response.text).not.toContain(world.replacementCredential);
    const changed = timeline.events.filter((event) => event.changes?.changedFields.length);
    expect(changed.length).toBeGreaterThanOrEqual(2);
    evidence.recordAssertionEvidence("Readable change evidence without credential material", `${changed.length} events contain field changes; neither synthetic key appears anywhere in the returned event envelopes.`, changed.length >= 2 && !response.text.includes(world.originalCredential) && !response.text.includes(world.replacementCredential));
    await owner.screenshot();
  });

  await step("capture and storage reports the operator policy without purchase or deletion controls", async () => {
    await owner.click({ role: "button", label: "Hide changes for Provider configuration update committed" });
    await owner.click({ text: "Capture and storage" });
    await owner.see({ text: "Instance operator" });
    await owner.see({ text: "Dry run only — no deletion" });
    const response = await probe.api(world.den.admin, "/v1/audit/usage");
    const usage = auditUsageResponseSchema.parse(response.body);
    expect(usage.captureEnabled).toBe(true);
    expect(usage.billing).toBe("disabled");
    expect(usage.cleanup).toBe("dry_run");
    expect(usage.drains).toBe("not_configured");
    evidence.recordAssertionEvidence("Actual capture and launch policy state", `Capture enabled: ${usage.captureEnabled}; ${usage.retainedOperations} retained operations; billing ${usage.billing}; cleanup ${usage.cleanup}; drains ${usage.drains}.`, usage.captureEnabled && usage.billing === "disabled" && usage.cleanup === "dry_run" && usage.drains === "not_configured");
    await owner.screenshot();
  });

  await step("the owner turns capture off and on without losing entitlement or retained history", async () => {
    await owner.see({ text: "Enabled by instance operator" });
    await owner.click({ role: "switch", label: "Capture audit logs" });
    await owner.see({ text: "New activity is not recorded. Retained history remains available." });
    const offResponse = await probe.api(world.den.admin, "/v1/audit/usage");
    const off = auditUsageResponseSchema.parse(offResponse.body);
    expect(off.entitlement).toEqual({ enabled: true, source: "self_hosted" });
    expect(off.captureAvailable).toBe(true);
    expect(off.captureOn).toBe(false);
    expect(off.captureEnabled).toBe(false);
    expect(off.policy).toMatchObject({ allowance: 6_000_000, source: "operator", excessMode: "keep_all" });
    const historyResponse = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
    expect(historyResponse.response.status).toBe(200);
    const history = auditEventsResponseSchema.parse(historyResponse.body);
    expect(history.events.some((event) => event.action === "provider.credential.updated")).toBe(true);
    expect(history.events.map((event) => event.id)).toEqual(originalEventIds);
    // Refresh through the browser while OFF: the filtered original row survives.
    await owner.click({ role: "button", label: "Refresh history" });
    await seeGroupedOperation();
    await owner.click(groupedRow);
    await owner.see({ text: "Changed; values not retained" });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Provider configuration update committed" });
    await owner.click({ text: "Operation allowance" });
    await owner.see({ text: "Not recording" });
    await owner.see({ text: "6,000,000" });
    evidence.recordAssertionEvidence("Off is separate from entitlement and retained history", `Entitlement remains ${off.entitlement.enabled}; the organization setting is ${off.captureOn}; ${history.events.length} saved events remain readable.`, off.entitlement.enabled && !off.captureOn && !off.captureEnabled && history.events.length > 0);
    await owner.screenshot();
    await owner.click({ role: "switch", label: "Capture audit logs" });
    await owner.see({ text: "Recording" });
    await owner.notSee({ text: "New activity is not recorded. Retained history remains available." });
    const onResponse = await probe.api(world.den.admin, "/v1/audit/usage");
    const on = auditUsageResponseSchema.parse(onResponse.body);
    expect(on.captureOn).toBe(true);
    expect(on.captureEnabled).toBe(true);
    expect(on.policy?.revision).toBe((off.policy?.revision ?? 0) + 1);
    expect(on.policy).toMatchObject({ allowance: 6_000_000, source: "operator", excessMode: "keep_all" });
    const initializedResponse = await probe.api(world.den.admin, `${operationsPath}&action=audit.policy.initialized`);
    expect(initializedResponse.response.status).toBe(200);
    const initialized = auditOperationsResponseSchema.parse(initializedResponse.body);
    expect(initialized.operations.map((operation) => operation.id)).toEqual([initializationOperationId]);
    expect(initialized.nextCursor).toBeNull();
    evidence.recordAssertionEvidence("The organization can resume recording", `Capture is ${on.captureOn}, effective recording is ${on.captureEnabled}, policy revision is ${on.policy?.revision}.`, on.captureOn && on.captureEnabled);
    await owner.screenshot();
  });

  const setName = `${world.reviewersTeamName} Permissions`;
  let setOperation: Awaited<ReturnType<typeof onlyOperationWith>> | null = null;

  await step("the owner gives the Audit reviewers team its own permissions and types “permission set created” into the Event type search", async () => {
    const created = await seed.api(world.den.admin, "/v1/permissions/sets", { method: "POST", body: JSON.stringify({ teamId: world.reviewersTeamId, permissions: [{ key: "audit.view", status: "allow" }] }) });
    expect(created.response.status).toBe(201);
    await owner.click({ text: "Capture and storage" });
    await openEventTypes();
    await owner.type({ label: "Search event types" }, "permission set created", { verify: true });
    const options = await audit.eventually(() => audit.dom('[role="listbox"] [role="option"]'), { within: 10_000, label: "Search narrows the event types", until: (value) => value.elements.some((option) => option.text === "Permission set created") });
    const labels = options.elements.map((option) => option.text);
    expect(labels).toContain("Permission set created");
    expect(labels.every((label) => label.toLowerCase().includes("permission set created"))).toBe(true);
    evidence.recordAssertionEvidence("The searchable Event type select narrows the catalog", `POST /v1/permissions/sets returned ${created.response.status}; typing “permission set created” leaves ${labels.length} options: ${labels.join(", ")}.`, labels.includes("Permission set created"));
    await owner.screenshot();
  });

  await step("after: picking Permission set created lists the owner's change as one operation", async () => {
    await owner.click({ text: "Permission set created" });
    await owner.see({ role: "button", label: "Event type" }, { text: "Permission set created" });
    await owner.click({ role: "button", label: "Apply filters" });
    await historySettled();
    await owner.see({ role: "button", label: "View changes for Permission set create requested" }, { timeoutMs: 30_000 });
    setOperation = await onlyOperationWith("permission_set.created");
    const { operation, events } = setOperation;
    expect(operation.action).toBe("permission_set.create.requested");
    expect(operation.origin).toBe("api");
    expect(events.map((event) => event.action)).toEqual(["permission_set.create.requested", "permission_set.created", "permission_set.create.succeeded"]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    const row = await operationRow(operation);
    expect(row).toMatchObject({ action: "Permission set create requested", actor: "Audit Owner", origin: "API" });
    evidence.recordAssertionEvidence("One request, one operation, three events", `Operation ${operation.id} holds ${events.map((event) => event.action).join(" → ")} from one request; the row reads “${row.summary}”.`, events.length === 3);
    await owner.screenshot();
  });

  await step("after: expanding it shows the permission set before (empty) and after, and the request's HTTP method, route and status", async () => {
    if (!setOperation) throw new Error("Permission set operation was not found");
    const { operation, events } = setOperation;
    await owner.click({ role: "button", label: "View changes for Permission set create requested" });
    const timeline = await expandedTimeline(operation, events.length);
    expect(timeline.events[1]?.headline).toBe("Permission set created · Succeeded · Audit Owner");
    expect(timeline.changes).toContain(`Name | None | ${setName}`);
    expect(timeline.changes).toContain("Allowed | None | audit.view");
    const change = events.find((event) => event.action === "permission_set.created")?.changes;
    expect(change?.before).toBeNull();
    expect(change?.after).toMatchObject({ name: setName, kind: "team", teamId: world.reviewersTeamId, allowed: ["audit.view"] });
    const requested = events.find((event) => event.action === "permission_set.create.requested");
    const succeeded = events.findIndex((event) => event.action === "permission_set.create.succeeded");
    expect(requested?.http).toEqual({ method: "POST", route: "/v1/permissions/sets" });
    expect(events[succeeded]?.http).toEqual({ method: "POST", route: "/v1/permissions/sets", status: 201 });
    await owner.click({ text: "Technical details", nth: succeeded });
    await owner.click({ text: "HTTP status" });
    const details = await audit.dom(`[id="audit-operation-${operation.id}"] details[open] dd`);
    const values = details.elements.map((value) => value.text);
    expect(values).toContain("POST /v1/permissions/sets");
    expect(values).toContain("201");
    expect(values).toContain("permission_set.create.succeeded");
    evidence.recordAssertionEvidence("Readable change and request evidence", `Changes: ${timeline.changes.join("; ")}. Technical details of permission_set.create.succeeded show “POST /v1/permissions/sets” and status 201 (the requested intent has no status).`, change?.before === null && values.includes("201"));
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Permission set create requested" });
  });

  await step("an ordinary team creation is one operation with a requested and a succeeded request event", async () => {
    const team = await seed.api(world.den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name: "Audit proof team" }) });
    expect(team.response.ok).toBe(true);
    await filterAndFindOperation("Team create succeeded", "team create", "Team create requested");
    const { operation, events } = await onlyOperationWith("team.create.succeeded");
    expect(events.map((event) => event.action)).toEqual(["team.create.requested", "team.create.succeeded"]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events.map((event) => event.outcome)).toEqual(["unknown", "succeeded"]);
    expect(events[1]?.http).toMatchObject({ method: "POST", route: "/v1/teams", status: team.response.status });
    await owner.click({ role: "button", label: "View changes for Team create requested" });
    const timeline = await expandedTimeline(operation, 2);
    expect(timeline.events.map((event) => event.headline)).toEqual(["Team create requested · Unknown · Audit Owner", "Team create succeeded · Succeeded · Audit Owner"]);
    evidence.recordAssertionEvidence("Request-level evidence groups under one operation", `POST /v1/teams returned ${team.response.status}; operation ${operation.id} shows exactly: ${timeline.events.map((event) => event.headline).join(" / ")}, from one request.`, events.length === 2);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Team create requested" });
  });

  await step("a teammate's denied attempt to create team permissions appears as a denied security event attributed to the teammate", async () => {
    const denied = await seed.api(world.teammate, "/v1/permissions/sets", { method: "POST", body: JSON.stringify({ teamId: world.reviewersTeamId, permissions: [{ key: "audit.view", status: "allow" }] }) });
    expect(denied.response.status).toBe(403);
    await filterAndFindOperation("Permission set create attempted", "permission set create attempted", "Permission set create requested");
    const { operation, events } = await onlyOperationWith("permission_set.create.attempted");
    expect(operation.initiatingActor).toMatchObject({ type: "user", id: world.teammateUserId });
    const attempt = events.find((event) => event.action === "permission_set.create.attempted");
    expect(attempt).toMatchObject({ category: "security", outcome: "denied", reasonCode: "request_denied", actor: { type: "user", id: world.teammateUserId }, http: { method: "POST", route: "/v1/permissions/sets", status: 403 } });
    expect(events.some((event) => event.action === "permission_set.created")).toBe(false);
    const row = await operationRow(operation);
    expect(row).toMatchObject({ action: "Permission set create requested", actor: "Audit Teammate", origin: "API" });
    await owner.click({ role: "button", label: "View changes for Permission set create requested" });
    const timeline = await expandedTimeline(operation, events.length);
    const shown = timeline.events.find((event) => event.headline.startsWith("Permission set create attempted"));
    expect(shown?.headline).toBe("Permission set create attempted · Denied · Audit Teammate");
    expect(shown?.text).toContain("Request denied");
    evidence.recordAssertionEvidence("A denied admin-route attempt is retained for the owner", `The teammate's POST /v1/permissions/sets returned 403; the owner's row reads “${row.summary}” and the event reads “${shown?.headline} · Request denied” (category ${attempt?.category}, outcome ${attempt?.outcome}); no permission set was created.`, attempt?.outcome === "denied" && attempt.category === "security");
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Permission set create requested" });
  });

  await step("a platform administrator's DPA change shows actor Platform administrator and origin Platform admin", async () => {
    const reason = "Synthetic countersigned DPA for the audit proof";
    const dpa = await seed.api(world.platformAdmin, `/v1/admin/organizations/${encodeURIComponent(world.orgId)}/dpa`, { method: "PATCH", body: JSON.stringify({ dpaSigned: true, reason }) });
    expect(dpa.response.status).toBe(200);
    await filterAndFindOperation("Organization DPA signed updated", "dpa", "Organization DPA update requested");
    const { operation, events, text } = await onlyOperationWith("organization.dpa_signed.updated");
    expect(operation.origin).toBe("platform_admin");
    expect(operation.initiatingActor.type).toBe("user");
    expect(operation.initiatingActor.memberId).toBeUndefined();
    expect(text).not.toContain(reason);
    const row = await operationRow(operation);
    expect(row).toMatchObject({ actor: "Platform administrator", origin: "Platform admin" });
    await owner.click({ role: "button", label: "View changes for Organization DPA update requested" });
    const timeline = await expandedTimeline(operation, events.length);
    expect(timeline.changes).toContain("DPA signed | None | Yes");
    await owner.notSee({ text: reason });
    evidence.recordAssertionEvidence("Platform admin changes are attributed without a member identity", `PATCH /v1/admin/organizations/:id/dpa returned ${dpa.response.status}; the row reads “${row.summary}”; the change reads “${timeline.changes.join("; ")}” and the reason text is not retained.`, operation.origin === "platform_admin" && row.actor === "Platform administrator");
    await owner.screenshot();
  });

  await step("a teammate sees a locked page and cannot read the owner's audit evidence", async () => {
    await teammate.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 90_000 });
    await teammate.see({ testId: "audit-locked" });
    await teammate.notSee({ role: "button", label: "Refresh history" });
    await teammate.notSee({ text: "Provider credential updated" });
    await teammate.notSee({ label: "Search IDs" });
    const list = await probe.api(world.teammate, operationsPath);
    const events = await probe.api(world.teammate, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
    const catalog = await probe.api(world.teammate, "/v1/audit/event-types");
    const statuses = [list.response.status, events.response.status, catalog.response.status];
    for (const { value } of idSearches) {
      const filtered = await probe.api(world.teammate, `${operationsPath}&searchId=${encodeURIComponent(value)}`);
      statuses.push(filtered.response.status);
      expect(filtered.text).not.toContain(operationId);
    }
    expect(statuses).toEqual(Array.from({ length: 7 }, () => 403));
    evidence.recordAssertionEvidence("Organization membership alone does not grant audit access", `List, timeline, catalog and all four ID searches returned 403 (${statuses.join("/")}); the page and Search IDs remain locked.`, statuses.every((status) => status === 403));
    await teammate.screenshot();
  });
});
