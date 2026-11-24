import { expect, vi } from "vitest";
import { test } from "@openwork/testkit";

const marker = "x-openwork-title-attempt";

for (const authorization of ["AWS4-HMAC-SHA256 Credential=dummy, SignedHeaders=x-openwork-title-attempt, Signature=dummy", "Bearer dummy", ""]) {
  test(`title correlation preserves signed headers but strips unsigned markers: ${authorization.split(" ")[0] || "api-key"}`, async ({ evidence }) => {
    const original = globalThis.fetch;
    let received = new Headers();
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      received = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }, original);
    vi.resetModules();
    const { OpenWorkTitleRecovery } = await import("../src/opencode-plugins/openwork-title-recovery.ts");
    const plugin = await OpenWorkTitleRecovery({ client: { app: { log: async () => undefined } } });
    try {
      const headers: Record<string, string> = { authorization, "x-api-key": "dummy-api-key" };
      await plugin["chat.headers"]({ sessionID: "unit", agent: "title", model: { id: "model", providerID: "provider" } }, { headers });
      await fetch("https://provider.invalid", { headers });
      expect(received.get(marker)).toBe(authorization.startsWith("AWS4-HMAC-SHA256") ? headers[marker] : null);
      expect(received.get("authorization")).toBe(authorization);
      expect(received.get("x-api-key")).toBe("dummy-api-key");
      // An expired/unknown signed marker must also stay intact.
      await fetch("https://provider.invalid", { headers: { ...headers, [marker]: "expired" } });
      expect(received.get(marker)).toBe(authorization.startsWith("AWS4-HMAC-SHA256") ? "expired" : null);
      const chat = { headers: {} };
      await plugin["chat.headers"]({ sessionID: "chat", agent: "build", model: { id: "model", providerID: "provider" } }, chat);
      expect(chat.headers).toEqual({});
      evidence.recordAssertionEvidence("Signed headers preserved; unsigned markers stripped; ordinary chat untouched", authorization.startsWith("AWS4-HMAC-SHA256") ? "AWS signed markers survive, including expired markers" : "Unsigned markers are stripped without changing authentication", true);
    } finally { await plugin.dispose(); globalThis.fetch = original; }
  });
}

const failures: { status: number; body: unknown; outcome: string }[] = [
  { status: 403, body: { message: "The request signature we calculated does not match the signature you provided." }, outcome: "signature_rejected" },
  { status: 403, body: { __type: "SignatureDoesNotMatch", message: "Invalid signature" }, outcome: "signature_rejected" },
  { status: 403, body: "The request signature we calculated does not match the signature you provided.", outcome: "signature_rejected" },
  { status: 403, body: { message: "Access denied" }, outcome: "access_rejected" },
  { status: 401, body: { message: "SignatureDoesNotMatch" }, outcome: "access_rejected" },
  { status: 429, body: { message: "Too many tokens per day" }, outcome: "rate_or_quota_limited" },
  { status: 404, body: { message: "Missing model" }, outcome: "model_or_endpoint_missing" },
];
for (const { status, body, outcome } of failures) {
  test(`title diagnostic maps ${status} to ${outcome}: ${JSON.stringify(body)}`, async ({ evidence }) => {
    const original = globalThis.fetch;
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    globalThis.fetch = Object.assign(async () => new Response(raw, { status }), original);
    vi.resetModules();
    const diagnostics: string[] = [];
    const { OpenWorkTitleRecovery } = await import("../src/opencode-plugins/openwork-title-recovery.ts");
    const plugin = await OpenWorkTitleRecovery({ client: { app: { log: async ({ body }) => { diagnostics.push(body.extra.outcome); } } } });
    try {
      const headers: Record<string, string> = {};
      await plugin["chat.headers"]({ sessionID: "unit", agent: "title", model: { id: "model", providerID: "provider" } }, { headers });
      const response = await fetch("https://provider.invalid", { headers });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(raw);
      expect(diagnostics).toEqual(["started", outcome]);
      evidence.recordAssertionEvidence("Failure labels preserve status and response", `${status}: ${outcome}; response unchanged`, true);
    } finally { await plugin.dispose(); globalThis.fetch = original; }
  });
}
