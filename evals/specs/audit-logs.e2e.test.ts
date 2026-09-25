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

test("an owner filters grouped audit history by child event, exact IDs and local dates while a teammate cannot read it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const audit = probe.on(world.web);
  const teammate = user.on(world.memberWeb);
  const operationsPath = "/v1/audit/operations?limit=50";
  const groupedRow = { role: "button", label: "View changes for Provider configuration update committed" } satisfies Parameters<User["see"]>[0];
  const idSearches: Array<{ label: string; value: string }> = [];
  let operationId = "";

  async function seeGroupedOperation() {
    await owner.see(groupedRow, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "audit-empty" });
    const rows = await audit.dom('button[aria-controls^="audit-operation-"]');
    expect(rows.elements).toHaveLength(1);
    expect((await audit.dom(`button[aria-controls="audit-operation-${operationId}"]`)).elements).toHaveLength(1);
  }

  await step("before: audit capture is configured but no provider changes have been recorded", async () => {
    await owner.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "audit-empty" });
    const response = await probe.api(world.den.admin, operationsPath);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(response.response.status).toBe(200);
    expect(history.operations).toHaveLength(0);
    evidence.recordAssertionEvidence("No retained provider operations", `Audit operations returned ${response.response.status} with ${history.operations.length} operations. The world explicitly seeded an operator policy before this screen.`, response.response.status === 200 && history.operations.length === 0);
    await owner.screenshot();
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

  await step("the empty history still offers the full server event-type catalog", async () => {
    const response = await probe.api(world.den.admin, "/v1/audit/event-types");
    expect(response.response.status).toBe(200);
    const catalog = auditEventTypesResponseSchema.parse(response.body);
    expect(catalog.eventTypes).toContain("provider.credential.updated");
    expect(catalog.eventTypes).toContain("provider.created");
    expect(catalog.eventTypes).toContain("audit.policy.enabled");
    await owner.click({ role: "button", label: "Event type" });
    const options = await audit.eventually(() => audit.dom('[role="listbox"] [role="option"]'), { within: 30_000, label: "Full event catalog is available before any history", until: (value) => value.elements.length === catalog.eventTypes.length + 1 });
    const labels = options.elements.map((option) => option.text);
    expect(labels).toContain("All event types");
    expect(labels).toContain("Provider credential updated");
    expect(labels).toContain("Provider created");
    expect(labels).toContain("Audit policy enabled");
    await owner.see({ role: "option", label: "Provider credential updated" });
    evidence.recordAssertionEvidence("The catalog is not derived from loaded operation summaries", `${catalog.eventTypes.length} server event types and ${options.elements.length - 1} dropdown event types are available with zero retained operations, including credential changes and policy events.`, options.elements.length === catalog.eventTypes.length + 1);
    await owner.screenshot();
    await owner.click({ role: "option", label: "All event types" });
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
    await owner.see({ text: "First recorded target" });
    await owner.see({ role: "button", label: "View changes for Provider configuration update committed" });
    const response = await probe.api(world.den.admin, `${operationsPath}&action=provider.credential.updated`);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(history.operations).toHaveLength(1);
    const operation = history.operations[0];
    if (!operation) throw new Error("No grouped provider operation returned");
    operationId = operation.id;
    expect(operation.action).not.toBe("provider.credential.updated");
    const eventsResponse = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
    const timeline = auditEventsResponseSchema.parse(eventsResponse.body);
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
    evidence.recordAssertionEvidence("One operation groups the complete save", `${history.operations.length} operation contains ${timeline.events.length} events across ${requests.size} requests, including credential replacement and access-grant removal.`, history.operations.length === 1 && requests.size >= 3 && timeline.events.every((event) => event.operationId === operationId));
    await owner.screenshot();
  });

  await step("after: selecting a child event type returns its whole grouped operation", async () => {
    await owner.click({ role: "button", label: "Event type" });
    await owner.click({ role: "option", label: "Provider created" });
    await owner.click({ role: "button", label: "Apply filters" });
    await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
    await owner.notSee(groupedRow);
    await owner.click({ role: "button", label: "Event type" });
    await owner.click({ role: "option", label: "Provider credential updated" });
    await owner.click({ role: "button", label: "Apply filters" });
    await owner.see({ role: "button", label: "Event type" }, { text: "Provider credential updated" });
    await seeGroupedOperation();
    const response = await probe.api(world.den.admin, `${operationsPath}&action=provider.credential.updated`);
    expect(response.response.status).toBe(200);
    const history = auditOperationsResponseSchema.parse(response.body);
    expect(history.operations.map((operation) => operation.id)).toEqual([operationId]);
    expect(history.operations[0]?.action).not.toBe("provider.credential.updated");
    evidence.recordAssertionEvidence("A child event filters the group, not just its first-row summary", `Provider created returns zero rows; Provider credential updated returns one grouped operation (${operationId}) whose summary action is ${history.operations[0]?.action}.`, history.operations.length === 1 && history.operations[0]?.id === operationId);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Clear filters" });
    await owner.see({ role: "button", label: "Event type" }, { text: "All event types" });
    await seeGroupedOperation();
  });

  for (const { label, value } of idSearches) {
    await step(`after: the owner finds the grouped operation by exact ${label} ID, never a prefix`, async () => {
      expect(value.length).toBeGreaterThan(1);
      await owner.type({ label: "Search IDs" }, value.slice(0, -1), { replace: true, verify: true });
      await owner.click({ role: "button", label: "Apply filters" });
      await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
      await owner.notSee(groupedRow);
      await owner.type({ label: "Search IDs" }, value, { replace: true, verify: true });
      await owner.click({ role: "button", label: "Apply filters" });
      await owner.see({ label: "Search IDs" }, { value });
      await seeGroupedOperation();
      const response = await probe.api(world.den.admin, `${operationsPath}&searchId=${encodeURIComponent(value)}`);
      expect(response.response.status).toBe(200);
      const history = auditOperationsResponseSchema.parse(response.body);
      expect(history.operations.map((operation) => operation.id)).toEqual([operationId]);
      evidence.recordAssertionEvidence(`Exact ${label} ID finds the same grouped operation`, `The ${label} ID prefix returns zero rows; the complete ID returns one row for ${operationId}; searchId read returned HTTP ${response.response.status}.`, history.operations.length === 1 && history.operations[0]?.id === operationId);
      await owner.screenshot();
      await owner.click({ role: "button", label: "Clear filters" });
      await owner.see({ label: "Search IDs" }, { value: "" });
    });
  }

  await step("a local date range before the save excludes the grouped operation", async () => {
    await seeGroupedOperation();
    await enterPastDate(owner, "From (local time)", "1");
    await enterPastDate(owner, "To (local time)", "2");
    await owner.click({ role: "button", label: "Apply filters" });
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
    await seeGroupedOperation();
    const rows = await audit.dom(`button[aria-controls="audit-operation-${operationId}"]`);
    evidence.recordAssertionEvidence("Clearing filters restores the saved operation", `Both local dates and Search IDs are empty, all event types are selected, and ${rows.elements.length} row for ${operationId} is restored.`, rows.elements.length === 1);
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
    const historyResponse = await probe.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(operationId)}/events?limit=50`);
    expect(historyResponse.response.status).toBe(200);
    const history = auditEventsResponseSchema.parse(historyResponse.body);
    expect(history.events.some((event) => event.action === "provider.credential.updated")).toBe(true);
    evidence.recordAssertionEvidence("Off is separate from entitlement and retained history", `Entitlement remains ${off.entitlement.enabled}; the organization setting is ${off.captureOn}; ${history.events.length} saved events remain readable.`, off.entitlement.enabled && !off.captureOn && !off.captureEnabled && history.events.length > 0);
    await owner.screenshot();
    await owner.click({ role: "switch", label: "Capture audit logs" });
    await owner.notSee({ text: "New activity is not recorded. Retained history remains available." });
    const onResponse = await probe.api(world.den.admin, "/v1/audit/usage");
    const on = auditUsageResponseSchema.parse(onResponse.body);
    expect(on.captureOn).toBe(true);
    expect(on.captureEnabled).toBe(true);
    expect(on.policy?.revision).toBe((off.policy?.revision ?? 0) + 1);
    evidence.recordAssertionEvidence("The organization can resume recording", `Capture is ${on.captureOn}, effective recording is ${on.captureEnabled}, policy revision is ${on.policy?.revision}.`, on.captureOn && on.captureEnabled);
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
