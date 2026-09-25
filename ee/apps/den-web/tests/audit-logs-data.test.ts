import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as requests from "../app/(den)/_lib/den-flow";
import { AuditReadError, auditFilterParams, auditQueryKey, getAuditEventTypes, getAuditEvents, getAuditOperations, getAuditUsage, isAuditAccessError, updateAuditCapture } from "../app/(den)/dashboard/_components/audit-logs-data";
import { auditEvent, auditOperation, auditScope, auditUsage, eventsPage, operationsPage } from "./audit-logs-fixtures";

let restore = () => {};
afterEach(() => restore());
function reply(payload: unknown, status = 200) {
  const request = spyOn(requests, "requestJson").mockResolvedValue({ response: new Response(null, { status }), payload, text: "" });
  restore = () => request.mockRestore();
  return request;
}

describe("audit capture requests", () => {
  test("PATCH sends only the stored revision and requested setting with pinned organization", async () => {
    const request = reply(auditUsage);
    const input = { captureOn: false, expectedRevision: 7 };
    expect(await updateAuditCapture(auditScope, input)).toEqual(auditUsage);
    const [path, init, timeout] = request.mock.calls[0];
    expect(path).toBe("/v1/audit/settings");
    expect(init).toEqual({ method: "PATCH", headers: { "x-openwork-org-id": "org-a" }, cache: "no-store", body: JSON.stringify(input), signal: expect.any(AbortSignal) });
    expect(timeout).toBe(15000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("strict capture input rejects internal or policy fields before transport", async () => {
    const request = reply(auditUsage);
    for (const input of [
      { captureOn: true, expectedRevision: 1, allowance: 100 },
      { captureOn: true, expectedRevision: 1, secret: "not-for-transport" },
      { captureOn: true, expectedRevision: -1 },
    ]) await expect(updateAuditCapture(auditScope, input)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  test.each(["malformed", "wrong-org", "missing-fields"])("rejects %s successful settings response", async (kind) => {
    const { entitlement, captureOn, captureAvailable, ...legacy } = auditUsage;
    reply(kind === "malformed" ? { ok: true } : kind === "missing-fields" ? legacy
      : { ...auditUsage, policy: { ...auditUsage.policy, organizationId: "org-b" } });
    await expect(updateAuditCapture(auditScope, { captureOn: false, expectedRevision: 1 })).rejects.toThrow();
  });

  test("only explicit fresh-auth denial is reauthable", async () => {
    reply({ error: "reauth", reason: "fresh_session_required" }, 403);
    await expect(updateAuditCapture(auditScope, { captureOn: false, expectedRevision: 1 })).rejects.toBeInstanceOf(requests.ReauthRequiredError);
  });

  test.each([401, 403, 404])("settings access failure %s retains status and code", async (status) => {
    reply({ error: status === 404 ? "organization_not_found" : "forbidden" }, status);
    try { await updateAuditCapture(auditScope, { captureOn: false, expectedRevision: 1 }); throw new Error("Expected rejection"); }
    catch (error) { expect(isAuditAccessError(error)).toBe(true); }
  });
});

describe("audit reads", () => {
  test("event types use the independently authorized catalog with pinned org and cancellation", async () => {
    const payload = { eventTypes: ["provider.credential.updated", "provider.model.updated"] };
    const request = reply(payload);
    const signal = new AbortController().signal;
    expect(await getAuditEventTypes(auditScope, signal)).toEqual(payload);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe("/v1/audit/event-types");
    expect(init?.headers).toEqual({ "x-openwork-org-id": auditScope.orgId });
    expect(init?.signal).toBe(signal);
    expect(init?.cache).toBe("no-store");
  });

  test("catalog rejects malformed or duplicate types instead of using loaded rows", async () => {
    for (const payload of [{ eventTypes: ["unexpected content"] }, { eventTypes: ["provider.updated", "provider.updated"] }, operationsPage()]) {
      reply(payload);
      await expect(getAuditEventTypes(auditScope)).rejects.toThrow("invalid response");
      restore();
    }
  });

  test("catalog access denial remains an access failure", async () => {
    reply({ error: "forbidden" }, 403);
    try { await getAuditEventTypes(auditScope); throw new Error("Expected rejection"); }
    catch (error) { expect(isAuditAccessError(error)).toBe(true); }
  });

  test("pins the organization, forwards cancellation and encodes every supported filter", async () => {
    const request = reply(operationsPage());
    const signal = new AbortController().signal;
    const filters = { from: "2026-09-01T00:00:00Z", to: "2026-09-25T00:00:00Z", actorId: "user/a", action: "provider.updated", resourceId: "resource & a", searchId: "event/+? & a", outcome: auditOperation.outcome, origin: auditOperation.origin };
    await getAuditOperations(auditScope, filters, undefined, signal);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe(`/v1/audit/operations?${auditFilterParams(filters)}`);
    expect(init?.headers).toEqual({ "x-openwork-org-id": "org-a" });
    expect(init?.signal).toBe(signal);
    expect(init?.cache).toBe("no-store");
    expect(auditQueryKey(auditScope)).not.toEqual(auditQueryKey({ ...auditScope, orgId: "org-b" }));
    expect(auditQueryKey(auditScope)).not.toEqual(auditQueryKey({ ...auditScope, memberId: "member-b" }));
  });

  test.each([401, 403])("access response %s is not empty history", async (status) => {
    reply({ error: "audit_visibility_disabled" }, status);
    try { await getAuditOperations(auditScope, {}); throw new Error("Expected rejection"); }
    catch (error) {
      expect(isAuditAccessError(error)).toBe(true);
      if (error instanceof AuditReadError) expect(error.code).toBe("audit_visibility_disabled");
    }
  });

  test("membership loss clears access rather than retaining cached evidence as a transient error", async () => {
    reply({ error: "organization_not_found" }, 404);
    try { await getAuditOperations(auditScope, {}); throw new Error("Expected rejection"); }
    catch (error) { expect(isAuditAccessError(error)).toBe(true); }
    expect(isAuditAccessError(new AuditReadError(404, "audit_operation_not_found"))).toBe(false);
  });

  test("rejects malformed envelopes and unrecognized outcomes instead of implying success", async () => {
    reply(operationsPage([{ ...auditOperation, outcome: "unknown" }]));
    expect((await getAuditOperations(auditScope, {})).operations[0].outcome).toBe("unknown");
    restore();
    reply({ ...operationsPage(), operations: [{ ...auditOperation, outcome: "unexpected" }] });
    await expect(getAuditOperations(auditScope, {})).rejects.toThrow("invalid response");
  });

  test.each(["repeat", "snapshot", "duplicate", "empty"])("rejects inconsistent %s pagination", async (kind) => {
    const param = { cursor: "page-2", snapshot: 10, cursors: ["page-2"], ids: ["operation-a"] };
    reply({ operations: kind === "empty" ? [] : [{ ...auditOperation, id: kind === "duplicate" ? "operation-a" : "operation-b" }], snapshotSequence: kind === "snapshot" ? 11 : 10, nextCursor: kind === "repeat" ? "page-2" : "page-3" });
    await expect(getAuditOperations(auditScope, {}, param)).rejects.toThrow("pagination");
  });

  test("event pages encode identifiers and preserve the cursor", async () => {
    const request = reply(eventsPage([{ ...auditEvent, operationId: "op/a" }]));
    await getAuditEvents(auditScope, "op/a", { cursor: "cursor + a", snapshot: 10, cursors: [], ids: [] });
    expect(request.mock.calls[0][0]).toBe("/v1/audit/operations/op%2Fa/events?limit=50&cursor=cursor+%2B+a");
  });

  test.each(["organization", "operation"])("rejects events from a different %s", async (kind) => {
    reply(eventsPage([{ ...auditEvent, ...(kind === "organization" ? { organizationId: "org-b" } : { operationId: "op-b" }) }]));
    await expect(getAuditEvents(auditScope, auditOperation.id)).rejects.toThrow("did not match");
  });

  test("policy must belong to the pinned organization", async () => {
    reply({ ...auditUsage, policy: { ...auditUsage.policy, organizationId: "org-b" } });
    await expect(getAuditUsage(auditScope)).rejects.toThrow("did not match");
  });

  test("no policy is a valid actual state, not a made-up default", async () => {
    reply({ ...auditUsage, policy: null, captureEnabled: false });
    expect((await getAuditUsage(auditScope)).policy).toBeNull();
  });
});
