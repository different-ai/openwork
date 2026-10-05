import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { spec, control, engineSessionProbe } from "@openwork/testkit";
import { nativeMemberKeys } from "../worlds/native-member-keys.ts";
import { inventoryResponse } from "./member-api-key-fixture.ts";

const test = spec.world(nativeMemberKeys, {
  timeout: 600_000,
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" },
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "Credential enrollment uses sender-bound Electron IPC and durable desktop bootstrap, neither provided by appWeb." },
});

test("native Electron Library enrolls two ordinary members on one real Den connection", async ({ world, user, probe, evidence }) => {
  const { den, keys, connectionId, organizationId, fingerprint } = world;
  for (const name of ["alice", "blair"] as const) {
    await world.withMember(name, async (desktop, memberId) => {
    const person = user.on(desktop);
    const page = probe.on(desktop);
    expect(await page.desktopBootstrap()).toEqual({ apiBaseUrl: den.ref.apiUrl, sessionOriginPresent: true });
    await person.see({ text: "Native credential proof model" }, { timeoutMs: 30_000 });
    if (name === "alice") {
      await control(desktop, "settings.panel.open", { panel: "connect" });
      await person.click({ role: "button", label: "Sign in" });
    } else {
      await person.type("composer", "Connect my native private tools");
      await person.click("Run task");
      await person.see({ testId: "desktop-connection-card" }, { timeoutMs: 60_000 });
      await person.screenshot();
    }
    await person.click({ role: "button", label: "Add key" });
    await person.see({ testId: "member-api-key-input" }, { value: "", timeoutMs: 20_000 });
    expect(await page.credentialInputState('[data-testid="member-api-key-input"]')).toMatchObject({ inputType: "password", empty: true });
    await person.screenshot();
    await person.type({ testId: "member-api-key-input" }, keys[name], { sensitive: true });
    await person.click({ role: "button", label: "Save key" });
    await probe.eventually(() => page.memberCredentialSaved(connectionId, organizationId, memberId), { within: 45_000, until: Boolean, label: "same-member acknowledged native save" });
    await person.see({ text: "Key saved" }, { timeoutMs: 30_000 });
    expect(await page.credentialInputState('[data-testid="member-api-key-input"]', keys[name])).toMatchObject({ inputContainsSecret: false, bodyContainsSecret: false, urlContainsSecret: false, storageContainsSecret: false, consoleContainsSecret: false });
    await person.screenshot();
    const inventory = await probe.api(den.members[name], "/v1/mcp-connections?scope=usable");
    expect(inventoryResponse.parse(inventory.body).connections.find(row => row.id === connectionId)).toMatchObject({ connectedForMe: true, credentialHealth: "unknown" });
    const logPath = desktop.handle.meta?.log;
    if (logPath) expect((await readFile(logPath, "utf8")).includes(keys[name])).toBe(false);
    await person.click({ role: "button", label: "Done" });
    if (name === "alice") {
      await person.click({ role: "button", label: "Replace key" });
      await person.see({ testId: "member-api-key-input" }, { value: "" });
      await person.see({ role: "heading", label: "Replace key for Native private tools" });
      expect((await page.dom('[data-testid="member-api-key-dialog"]')).elements.map(row => row.text).join(" ")).not.toContain("Key saved");
      await person.press("Escape");
      await person.click({ role: "button", label: "Back to app" });
    }
    await person.click({ role: "button", label: "New session" });
    await person.see("composer", { editable: true, text: "" });
    await person.type("composer", "Read my fixture identity");
    await person.click("Run task");
    await probe.eventually(async () => (await den.mocks.source.toolCalls()).some(call => call.tokenId === fingerprint(keys[name])), { within: 60_000, until: Boolean, label: "native tool execution uses enrolled member key" });
    const route = await page.hash();
    const sessionId = /\/session\/([^/?#]+)/.exec(route)?.[1];
    if (!sessionId) throw new Error("Owned session missing");
    const native = engineSessionProbe({ engine: "v1", surface: desktop, workspaceId: desktop.workspaceId });
    expect(JSON.stringify(await native.snapshot(sessionId)).includes(keys[name])).toBe(false);
    await person.see({ text: "Identity read finished." }, { timeoutMs: 60_000 });
    const line = await probe.eventually(async () => (await page.dom('[data-capability-call*="execute_capability"] span.truncate')).elements.find(row => row.rect.height > 0)?.text ?? "", { within: 30_000, until: Boolean, label: "actual completed capability sentence" });
    await person.hover({ text: line });
    await person.click({ testId: "tool-details-toggle", nth: 1 });
    await probe.eventually(async () => (await page.dom('[data-capability-call*="execute_capability"] pre')).elements.some(row => row.text.includes("fixture identity") && row.rect.height > 0), { within: 30_000, until: Boolean, label: "expanded actual capability output" });
    evidence.recordAssertionEvidence(`${name} actual rendered tool result`, "A real execute_capability result was expanded through the normal disclosure and contains fixture identity. No replacement UI or JSON was injected.", true);
    await person.screenshot();
    });
  }
  const denied = await probe.api(den.members.ungranted, "/v1/mcp-connections?scope=usable");
  expect(inventoryResponse.parse(denied.body).connections.some(row => row.id === connectionId)).toBe(false);
  const log = await den.apiLog();
  expect(Object.values(keys).some(key => log.includes(key))).toBe(false);
  expect(world.analyticsBodies.length).toBeGreaterThan(0);
  expect(Object.values(keys).some(key => world.analyticsBodies.some(body => body.includes(key)))).toBe(false);
  evidence.recordAssertionEvidence("Fixture engine configuration is observed before use", `${JSON.stringify(world.reloads)}. Each actor used one reload attempt followed by read-only model and gateway validation. An uncertain reload acknowledgement is not treated as a product fix and no POST was replayed.`, world.reloads.length === 2);
  evidence.recordAssertionEvidence("Actual analytics request bodies omit candidates", `${world.analyticsBodies.length} owned analytics requests contain zero candidate matches. Bodies are not retained as evidence.`, true);
  evidence.recordAssertionEvidence("Native Library and chat use real IPC and real Den", "One central connection and two ordinary password enrollments have same-actor acknowledged save, explicit API readback and caller-specific actual tools. Reopening the same Library connection is empty and unsaved. Ungranted inventory excludes it and observed UI, storage, console, transcript and logs omit candidates. No mocked product import, actor-race rollback or packaged observer truth-table claim.", true);
});
