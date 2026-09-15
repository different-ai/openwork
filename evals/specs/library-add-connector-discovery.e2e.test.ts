import { expect } from "vitest";
import { browserScript, needs, spec, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { isRecord, libraryConnectorDiscovery, records, stringField } from "../worlds/library.ts";

const test = spec.world(libraryConnectorDiscovery, {
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Verify Library setup uses the Desktop Den bridge without opening an OS browser or changing workspace MCP configuration.",
  },
});

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library connector discovery skipped — needs: ${missingRequirements.join(", ")}`
  : "Library sets up Cloud connections inside Desktop and keeps local MCP creation in Advanced";

test(title, async ({ evidence, world, seed, user, agent, probe, step }) => {
  needs(requirements);
  const { app: desktop, workspaceId, organizationId: orgId, denWebUrl } = world;
  const connectionName = "Library setup witness";
  const headers = { "x-openwork-org-id": orgId };
  const readConnections = async (session = world.admin, scope = "manageable") => {
    const result = await probe.api(session, `/v1/mcp-connections?scope=${scope}`, { headers });
    expect(result.response.status).toBe(200);
    if (!isRecord(result.body) || !Array.isArray(result.body.connections)) {
      throw new Error("Den did not return a connection inventory.");
    }
    expect(result.body.connections.every(isRecord)).toBe(true);
    return records(result.body.connections);
  };
  const readLocalConfig = () => probe.desktopApi(`/workspace/${encodeURIComponent(workspaceId)}/opencode-config`);
  await user.see({ text: "OpenWork Cloud account and organization." }, { timeoutMs: 30_000 });
  expect(await probe.storage("openwork.extension.enabled.google-workspace")).toBe(1);
  const settingsText = await probe.text();
  expect(settingsText).toContain("OpenWork Cloud account and organization.");
  expect(settingsText).not.toContain("Google Workspace");
  expect(settingsText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);
  evidence.recordAssertionEvidence(
    "A stale local Google enabled flag cannot restore legacy Settings setup",
    "The upgraded profile retains openwork.extension.enabled.google-workspace=1. Settings retains the Cloud account entry without restoring Google Workspace or local Google OAuth setup.",
    true,
  );
  const bootstrap = await probe.eval(
    desktop,
    () => (window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig")
      .then((config) => ({
        baseUrl: config.baseUrl,
        activeOrgId: localStorage.getItem("openwork.den.activeOrgId"),
      }))),
    { awaitPromise: true },
  );
  expect(bootstrap).toMatchObject({
    baseUrl: denWebUrl,
    activeOrgId: orgId,
  });

  await step("Ollama has its own Settings page with the existing local model setup", async () => {
    await seed.evalIn(desktop, browserScript((id: string) => {
      location.hash = `#/workspace/${id}/settings/ollama`;
    }, [workspaceId]));
    await user.see({ text: "Connect to Ollama and manage local models" }, { timeoutMs: 30_000 });
    await user.see({ text: "Connect to a local Ollama instance and choose a model." });
    expect(await probe.hash()).toBe(`#/workspace/${workspaceId}/settings/ollama`);
    await user.notSee({ role: "button", label: "Add MCP" });
  });

  await step("Library defaults to MCPs, Ready to use, and cards with only three type filters", async () => {
    // Arrange the surface under test without exercising responsive Settings navigation.
    await seed.evalIn(desktop, browserScript((id: string) => {
      location.hash = `#/workspace/${id}/extensions`;
    }, [workspaceId]));
    await user.see({ role: "button", label: "Add to library" }, { timeoutMs: 90_000 });
    await probe.eventually(() => probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])'), {
      within: 90_000,
      label: "the signed-in admin's header Add to library is enabled",
      until: (snapshot) => snapshot.elements.length === 1,
    });
    expect(await probe.hash()).toBe(`#/workspace/${workspaceId}/extensions`);
    const filters = await probe.dom('[aria-label="Library filters"] button[aria-pressed]:not([aria-label])');
    expect(filters.elements.map((element) => element.text)).toEqual(["MCPs", "Skills", "Plugins"]);
    expect((await probe.dom('[aria-label="Library filters"] button[aria-pressed="true"]:not([aria-label])')).elements.map((element) => element.text)).toEqual(["MCPs"]);
    expect((await probe.dom('[role="tab"][aria-selected="true"]')).elements).toMatchObject([{ text: expect.stringMatching(/^Ready to use\s*0$/) }]);
    expect((await probe.dom('button[aria-label="Card view"][aria-pressed="true"]')).elements).toHaveLength(1);
    expect((await probe.dom('button[aria-label="List view"][aria-pressed="true"]')).elements).toHaveLength(0);
    expect((await probe.dom('button[aria-expanded="false"]')).elements).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/^Advanced\b/) })]));
    for (const label of ["All", "Apps", "Commands", "Agents", "Connections", "Show hidden", "Add", "Add workspace MCP"]) {
      await user.notSee({ role: "button", label: new RegExp(`^${label}$`) });
    }
    await user.notSee({ role: "tab", label: /^All\b/ });
    await user.notSee({ role: "textbox", label: "App name" });
    await user.notSee({ testId: "library-add-choices" });
    await user.notSee({ text: "Local MCP" });
    const libraryText = await probe.text();
    expect(libraryText).not.toContain("Voice Mode");
    expect(libraryText).not.toContain("Ollama");
    expect(libraryText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);
    expect((await probe.dom('[aria-label*="voice mode" i]')).elements).toHaveLength(0);
    const add = await probe.dom('header button[aria-label="Add to library"]');
    expect(add.elements).toHaveLength(1);
    const addButton = add.elements[0];
    if (!addButton) throw new Error("Library has no header Add to library control.");
    expect(addButton.text).toBe("Add to library");
    expect(addButton.rect.left).toBeGreaterThanOrEqual(0);
    expect(addButton.rect.right).toBeLessThanOrEqual(820);
    expect(addButton.rect.top).toBeGreaterThanOrEqual(0);
    expect(addButton.rect.bottom).toBeLessThanOrEqual(760);
    expect(filters.documentWidth).toBeLessThanOrEqual(filters.viewportWidth);
    await user.screenshot();
  });

  await step("admin sets up a real Cloud connection without leaving Desktop Library", async () => {
    const libraryHash = await probe.hash();
    const openedBefore = await world.browserUrls.opened();
    const connectionsBefore = await readConnections();
    expect(connectionsBefore.filter((row) => row.name === connectionName)).toHaveLength(0);
    const localConfigBefore = await readLocalConfig();
    expect(localConfigBefore.status).toBe(200);
    const assertContextUnchanged = async () => {
      expect(await probe.hash()).toBe(libraryHash);
      expect(await probe.storage("openwork.den.activeOrgId")).toBe(orgId);
      expect(await world.browserUrls.opened()).toEqual(openedBefore);
      expect(await readLocalConfig()).toEqual(localConfigBefore);
    };
    const openSetup = async () => {
      await user.click({ role: "button", label: "Add to library" });
      await user.click({ role: "button", label: "Continue" });
      await user.see({ role: "heading", label: "Set up a connection" }, { timeoutMs: 30_000 });
      await user.notSee({ testId: "library-add-choices" });
      for (const label of ["Custom MCP", "Google Workspace", "Microsoft 365"]) {
        await user.see({ role: "button", label });
      }
      await user.notSee({ role: "textbox", label: "App name" });
      await user.notSee({ role: "button", label: "Add workspace MCP" });
      expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
      await assertContextUnchanged();
    };

    await user.click({ role: "button", label: "Add to library" });
    await user.see({ testId: "library-add-choices" });
    expect((await probe.dom('[data-testid="library-add-choices"] [role="radio"]')).elements).toHaveLength(3);
    for (const kind of ["mcp", "skill", "plugin"]) {
      expect((await probe.dom(`[data-kind="${kind}"]`)).elements).toHaveLength(1);
    }
    expect(await world.browserUrls.opened()).toEqual(openedBefore);
    await user.press("Escape");
    await user.notSee({ testId: "library-add-choices" });
    await assertContextUnchanged();

    for (const { providerKey, label } of [
      { providerKey: "google-workspace", label: "Google Workspace" },
      { providerKey: "microsoft-365", label: "Microsoft 365" },
    ]) {
      await step(`${label} opens server-owned setup metadata without saving credentials or authorizing an account`, async () => {
        const path = `/v1/oauth-providers/${providerKey}/client`;
        const before = await probe.api(world.admin, path, { headers });
        expect(before.response.status).toBe(200);
        expect(before.body).toMatchObject({ configured: false, clientId: null });
        const redirectUri = stringField(before.body, "redirectUri");
        expect(redirectUri).not.toBe("");
        const authBefore = (await world.connector.requests()).filter((request) => request.path === "/authorize" || request.path === "/token");
        await openSetup();
        await user.click({ role: "button", label });
        await user.see({ role: "textbox", label: "Redirect URI" }, { value: redirectUri, timeoutMs: 30_000 });
        expect((await probe.dom(`form[aria-label="${label} setup"]`)).elements).toHaveLength(1);
        expect((await probe.dom('[role="dialog"] input[aria-label="Redirect URI"][readonly]')).elements).toHaveLength(1);
        await user.see({ role: "textbox", label: "Client ID" }, { value: "" });
        await user.see({ label: "Client secret" }, { value: "" });
        expect((await probe.dom('[role="dialog"] input[aria-label="Client secret"][type="password"]')).elements).toHaveLength(1);
        if (providerKey === "microsoft-365") {
          await user.see({ role: "textbox", label: "Directory (tenant) ID" }, { value: "" });
        } else {
          await user.see({ role: "textbox", label: "Name" }, { value: "Google Workspace" });
        }
        await user.see({ text: "Permissions" });
        expect((await probe.dom('[role="dialog"] input[type="checkbox"][data-feature]')).elements.length).toBeGreaterThan(0);
        await user.see({ role: "button", label: "Save setup" });
        expect((await probe.dom('[role="dialog"] button[type="submit"]:disabled')).elements).toHaveLength(1);
        await user.press("Escape");
        await user.notSee({ role: "heading", label: "Set up a connection" });
        const after = await probe.api(world.admin, path, { headers });
        expect(after.response.status).toBe(200);
        expect(after.body).toEqual(before.body);
        expect(await readConnections()).toEqual(connectionsBefore);
        expect((await world.connector.requests()).filter((request) => request.path === "/authorize" || request.path === "/token")).toEqual(authBefore);
        await assertContextUnchanged();
        evidence.recordAssertionEvidence(
          `${label} setup stays in Desktop without changing backend configuration`,
          "The exact server-returned redirect URI is read-only; client ID, password secret, permissions, and provider-specific fields are present. No credentials were entered or captured. Closing setup leaves provider metadata, connection inventory, workspace config, route, organization, and external-open capture unchanged.",
          true,
        );
      });
    }

    await step("Custom MCP validates the no-auth witness and saves exactly one owner-only shared connection", async () => {
      await openSetup();
      await user.click({ role: "button", label: "Custom MCP" });
      await user.type({ role: "textbox", label: "Name" }, connectionName, { replace: true });
      await user.type({ role: "textbox", label: "Server URL" }, world.mockUrl, { replace: true });
      const authentication = { label: "Authentication" };
      await user.see(authentication, { value: "oauth" });
      await user.see({ role: "combobox", label: "Account access" }, { value: "per_member" });
      expect((await probe.dom('select[aria-label="Authentication"] option')).elements.map((element) => element.text)).toEqual(["OAuth", "API key", "No authentication"]);
      await user.click(authentication);
      await user.press("ArrowDown");
      await user.press("Enter");
      await user.see(authentication, { value: "apikey" });
      await user.see({ label: "API key" }, { value: "" });
      expect((await probe.dom('[role="dialog"] input[type="password"]')).elements).toHaveLength(1);
      await user.click(authentication);
      await user.press("ArrowDown");
      await user.press("Enter");
      await user.see(authentication, { value: "none" });
      expect((await probe.dom('[role="dialog"] input[type="password"]')).elements).toHaveLength(0);
      const handshakesBefore = await world.connector.handshakes();
      const authBefore = (await world.connector.requests()).filter((request) => request.path === "/authorize" || request.path === "/token");
      expect(await readConnections()).toEqual(connectionsBefore);
      await user.click({ role: "button", label: "Save connection" });
      await user.see({ role: "button", label: "Refresh status" }, { timeoutMs: 60_000 });
      await user.see({ role: "button", label: "Done" });
      expect((await probe.dom('[role="dialog"]')).elements).toMatchObject([{ text: expect.stringContaining(connectionName) }]);
      expect((await probe.dom('[role="dialog"]')).elements).toMatchObject([{ text: expect.stringMatching(/Connected|Ready to use/) }]);
      await user.notSee({ role: "button", label: "Connect account" });
      await user.notSee({ role: "button", label: "Save connection" });
      const matching = await probe.eventually(async () => (await readConnections()).filter((row) => row.name === connectionName), {
        within: 30_000,
        label: "Den persisted the Desktop-created connection and validated the MCP boundary",
        until: (rows) => rows.length === 1 && rows[0]?.connected === true,
      });
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        name: connectionName,
        url: world.mockUrl,
        authType: "none",
        credentialMode: "shared",
        connected: true,
        connectedForMe: true,
        access: { orgWide: false, memberIds: [world.ownerMemberId], teamIds: [] },
      });
      const connectionId = stringField(matching[0], "id");
      expect(connectionId).not.toBe("");
      const handshakesAfter = await world.connector.handshakes();
      expect(handshakesAfter.slice(handshakesBefore.length)).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/mcp", status: 200 }),
      ]));
      expect((await world.connector.requests()).filter((request) => request.path === "/authorize" || request.path === "/token")).toEqual(authBefore);
      await assertContextUnchanged();
      await user.click({ role: "button", label: "Refresh status" });
      await user.see({ role: "button", label: "Refresh status" }, { timeoutMs: 30_000 });
      await user.click({ role: "button", label: "Done" });
      await user.notSee({ role: "heading", label: "Set up a connection" });
      await user.see({ text: connectionName }, { timeoutMs: 30_000 });
      const after = await readConnections();
      expect(after.filter((row) => row.name === connectionName)).toHaveLength(1);
      expect(after.filter((row) => row.id !== connectionId)).toEqual(connectionsBefore);
      expect((await readConnections(world.admin, "usable")).filter((row) => row.id === connectionId)).toHaveLength(1);
      expect((await readConnections(world.member, "usable")).filter((row) => row.id === connectionId || row.name === connectionName)).toHaveLength(0);
      await assertContextUnchanged();
      evidence.recordAssertionEvidence(
        "Desktop Library creates one validated owner-only Cloud MCP without local configuration or a Den browser handoff",
        "Save connection crossed real Den POST and the mock witnessed a new successful MCP initialize. Den returned one matching connected shared no-auth row with orgWide=false, only the owner's membership, and no teams. Refresh and Done retain that single row, exclude it from the ordinary member's usable scope, preserve workspace config and Library context, and issue no external browser opens or OAuth requests.",
        true,
      );
    });
  });

  for (const { filter, addLabel, emptyTitle, hint, formTitle } of [
    { filter: "Skills", addLabel: "Create skill", emptyTitle: "No skills yet", hint: "Add reusable instructions for work your agents do often.", formTitle: "Create a skill" },
    { filter: "Plugins", addLabel: "Add plugin", emptyTitle: "No plugins yet", hint: "Add a plugin to bring related skills and MCPs into your Library.", formTitle: "Create a plugin" },
  ]) {
    await step(`${filter} has its own empty state, search recovery, and separate header and empty-state actions`, async () => {
      await user.click({ role: "button", label: filter });
      await user.see({ text: emptyTitle });
      await user.see({ text: hint });
      expect((await probe.dom('[aria-label="Library filters"] button[aria-pressed="true"]:not([aria-label])')).elements.map((element) => element.text)).toEqual([filter]);
      expect((await probe.dom('header button[aria-label="Add to library"]')).elements).toMatchObject([{ text: "Add to library" }]);
      expect((await probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
      await user.see({ role: "button", label: addLabel }, { text: addLabel });
      await user.notSee({ role: "button", label: "Add MCP" });
      await user.notSee({ role: "button", label: "Add workspace MCP" });
      await user.type({ placeholder: "Search your library" }, "library-discovery-no-match", { replace: true });
      await user.see({ text: "No library items match these filters." });
      await user.notSee({ text: emptyTitle });
      await user.click({ role: "button", label: "Clear filters" });
      await user.see({ placeholder: "Search your library" }, { value: "" });
      await user.see({ text: emptyTitle });
      for (const entryPoint of ["header", "empty-state"]) {
        if (entryPoint === "header") {
          await user.click({ role: "button", label: "Add to library" });
          await user.see({ testId: "library-add-choices" });
          await user.click({ text: filter === "Skills" ? /^Skill$/ : /^Plugin$/ });
          await user.click({ role: "button", label: "Continue" });
        } else {
          await user.click({ role: "button", label: addLabel });
        }
        await user.see({ text: formTitle });
        await user.notSee({ role: "textbox", label: "App name" });
        await user.notSee({ testId: "library-add-choices" });
        expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
        await user.press("Escape");
        await user.notSee({ text: formTitle });
        await user.see({ text: emptyTitle });
      }
    });
  }

  await step("only Advanced exposes the workspace MCP form and closing it restores Cloud-only inventory", async () => {
    await user.click({ role: "button", label: "MCPs" });
    await user.notSee({ role: "button", label: "Add workspace MCP" });
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.click({ role: "button", label: "Add workspace MCP" });
    await user.see({ role: "textbox", label: "App name" });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
    await user.press("Escape");
    await user.notSee({ role: "textbox", label: "App name" });
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.notSee({ role: "button", label: "Add workspace MCP" });
    await user.notSee({ text: "Local MCP" });
    await user.see({ role: "button", label: "Add to library" });
    expect((await probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    await user.screenshot();
  });

  await step("an ordinary member gets only available connections, not admin setup or the owner's private connection", async () => {
    const connectionsBefore = await readConnections();
    const openedBefore = await world.browserUrls.opened();
    const localConfigBefore = await readLocalConfig();
    expect(localConfigBefore.status).toBe(200);
    const manageable = await probe.api(world.member, "/v1/mcp-connections?scope=manageable", { headers });
    expect(manageable.response.status).toBe(403);
    const available = await readConnections(world.member, "usable");
    expect(available.filter((row) => row.id === world.memberConnectionId)).toMatchObject([{
      name: world.memberConnectionName, authType: "oauth", credentialMode: "per_member", connectedForMe: false,
    }]);
    expect(available.filter((row) => row.name === connectionName)).toHaveLength(0);
    await seed.signIn(desktop, world.member, "Library Connector Member");
    await agent.run("route.extensions.skills");
    await user.click({ role: "button", label: "MCPs" });
    await user.see({ role: "button", label: "Add to library" }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Add to library" });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: "Set up a connection" }, { timeoutMs: 30_000 });
    await user.see({ text: world.memberConnectionName });
    const dialog = await probe.dom('[role="dialog"]');
    expect(dialog.elements).toHaveLength(1);
    expect(dialog.elements[0]?.text).toContain(world.memberConnectionName);
    expect(dialog.elements[0]?.text).not.toContain(connectionName);
    for (const label of ["Custom MCP", "Google Workspace", "Microsoft 365", "Save connection", "Save setup"]) {
      await user.notSee({ role: "button", label });
    }
    expect((await probe.dom('[role="dialog"] input[type="password"], [role="dialog"] select[aria-label="Authentication"]')).elements).toHaveLength(0);
    await user.notSee({ role: "textbox", label: "Server URL" });
    await user.notSee({ role: "textbox", label: "Client ID" });
    await user.press("Escape");
    await user.notSee({ role: "heading", label: "Set up a connection" });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    expect(await probe.hash()).toBe(`#/workspace/${workspaceId}/extensions`);
    expect(await probe.storage("openwork.den.activeOrgId")).toBe(orgId);
    expect(await readConnections()).toEqual(connectionsBefore);
    expect(await world.browserUrls.opened()).toEqual(openedBefore);
    expect(await readLocalConfig()).toEqual(localConfigBefore);
    evidence.recordAssertionEvidence(
      "Member Library setup lists granted connections without exposing admin creation",
      "The same Desktop switches to the ordinary member without another desktop or browser. Its granted OAuth row appears in setup, the owner-only created row is absent, admin provider/create controls and secret fields are absent, and Den rejects manageable inventory with 403. Closing changes neither connections nor local config and retains Library, organization, and external-open capture.",
      true,
    );
  });
});
