import type { Target } from "@openwork/cdp";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { nativeConnectionSetup, records, isRecord } from "../worlds/library.ts";

const test = spec.world(nativeConnectionSetup, {
  timeout: 1_200_000,
  needs: { model: "tool-capable", env: ["OPENAI_API_KEY"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

test("a real model guides native setup, resumes with usable tools, and respects member access", { timeout: 1_200_000 }, async ({ world, agent, user, probe, evidence, step }) => {
  const appUser = user.on(world.app);
  const memberUser = user.on(world.memberApp);
  const appProbe = probe.on(world.app);
  const endpoint = world.den.mocks.connector.mcpUrl;
  const hostname = new URL(endpoint).hostname;
  const setupButton: Target = { role: "button", label: `Set up ${hostname}` };
  const prompt = `I want to connect the MCP service at ${endpoint}. Help me set it up here. Once I finish signing in, read the service's current connection status.`;
  expect(prompt).not.toContain("violet-orbit-42");
  const inventory = async () => {
    const result = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(result.response.status).toBe(200);
    return isRecord(result.body) ? records(result.body.connections) : [];
  };
  let connectionId = "";
  const unsentDraft = "Keep this note in my composer for later.";

  try {
  await step("A real model discovers setup without creating a connection", async () => {
    expect(await inventory()).toEqual([]);
    await agent.on(world.app).send(prompt);
    await appUser.see(setupButton, { timeoutMs: 120_000 });
    await probe.eventually(() => appProbe.composer(), { within: 120_000, label: "initial setup reply finishes before selecting its card", until: state => state.runTaskVisible });
    expect(await inventory()).toEqual([]);
    expect(await world.browserUrls.opened()).toEqual([]);
    await appUser.screenshot();
    await appUser.type("composer", unsentDraft);
    await appUser.click(setupButton);
    await appUser.see({ testId: "connection-setup-sheet" });
    await appUser.see({ role: "button", label: "Save and sign in" }, { timeoutMs: 45_000 });
    await appUser.type({ role: "textbox", label: "Connection name" }, "Workspace Service", { replace: true });
    expect(await appProbe.eval(() => document.querySelector<HTMLSelectElement>('#connection-audience')?.value)).toBe("me");
    expect(await appProbe.eval(() => document.querySelector<HTMLSelectElement>('#connection-account-mode')?.value)).toBe("per_member");
    expect(await world.browserUrls.opened()).toEqual([]);
    await appUser.click({ role: "button", label: "OAuth app settings" });
    await appUser.see({ role: "textbox", label: "Requested scopes" });
    expect(await appProbe.eval(() => document.querySelector<HTMLSelectElement>('#connection-client-auth')?.value)).toBe("");
    await appUser.screenshot();
    evidence.recordAssertionEvidence("Native setup is offered by a real model without creating or authorizing a connection", `Model ${world.modelId}; a visible native form defaults to each person signing in and Only me. Den inventory and OS browser requests are empty before Save.`, true);
  });

  await step("The admin saves once, signs in, and the original task uses the service", async () => {
    await appUser.click({ role: "button", label: "Save and sign in" });
    await appUser.see({ text: "Finish sign-in in your browser" }, { timeoutMs: 60_000 });
    await appUser.screenshot();
    await appUser.click({ role: "button", label: "Stop waiting" });
    await appUser.see({ role: "button", label: "Sign in" });
    await appUser.click({ text: "Update OAuth app" });
    await appUser.see({ role: "textbox", label: "Client ID" });
    await appUser.screenshot();
    expect(await inventory()).toHaveLength(1);
    await appUser.click({ role: "button", label: "Sign in" });
    await probe.eventually(async () => (await world.browserUrls.opened()).length, { within: 30_000, label: "provider sign-in reopened", until: value => value === 2 });
    const urls = await world.browserUrls.opened();
    const url = urls[1];
    if (!url) throw new Error("The provider sign-in did not open");
    expect(new URL(url).origin).toBe(new URL(world.den.mocks.connector.url).origin);
    const saved = await inventory();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.connectedForMe).toBe(false);
    connectionId = String(saved[0]?.id);
    expect(prompt).not.toContain(connectionId);
    const failureScenarios: Array<"token_rejected" | "resource_rejected"> = ["token_rejected", "resource_rejected"];
    for (const fault of failureScenarios) {
      await world.setOAuthFault(fault);
      const opened = await world.browserUrls.opened();
      const failureUrl = opened.at(-1);
      if (!failureUrl) throw new Error("Missing provider handoff");
      await user.on(world.web).navigate(failureUrl);
      await user.on(world.web).click({ role: "button", label: "Approve OpenWork" });
      await user.on(world.web).see({ text: "Connection failed" }, { timeoutMs: 30_000 });
      await appUser.see({ testId: "connection-diagnostic" }, { timeoutMs: 30_000 });
      await appUser.click({ text: "Sign-in details" });
      const expectedCode = fault === "token_rejected" ? "MCP_OAUTH_CLIENT_REJECTED" : "MCP_OAUTH_RESOURCE_REJECTED";
      await appUser.see({ text: expectedCode });
      await appUser.notSee({ text: "Ready to use" });
      await appUser.notSee({ text: "Finish sign-in in your browser" });
      expect((await inventory())[0]?.connectedForMe).toBe(false);
      expect(await probe.toolCalls(world.den.mocks.connector, { name: "read_connection_status", atLeast: 0, timeoutMs: 1000 })).toHaveLength(0);
      await appUser.screenshot();
      await user.on(world.web).screenshot();
      evidence.recordAssertionEvidence(`The task displays ${fault} from the exact browser sign-in`, `The real-model task stayed open and showed ${expectedCode} within 30 seconds of provider consent, with no Ready state, saved credential or business tool execution. Browser and app displayed the failure without waiting for the three-minute timeout.`, true);
      await world.setOAuthFault(null);
      await appUser.click({ role: "button", label: "Sign in" });
      await probe.eventually(async () => (await world.browserUrls.opened()).length, { within: 30_000, label: "retry sign-in", until: value => value === opened.length + 1 });
    }
    const recoveryUrl = (await world.browserUrls.opened()).at(-1);
    if (!recoveryUrl) throw new Error("Missing recovery handoff");
    // Capture and use the exact OS handoff; only the provider approval is in the browser.
    await user.on(world.web).navigate(recoveryUrl);
    await user.on(world.web).click({ role: "button", label: "Approve OpenWork" });
    await user.on(world.web).see({ text: "You're connected" }, { timeoutMs: 30_000 });
    await appUser.see({ text: "Ready to use" }, { timeoutMs: 90_000 });
    await appUser.screenshot();
    await appUser.click({ role: "button", label: "Back to task" });
    await appUser.see({ text: "violet-orbit-42" }, { timeoutMs: 120_000 });
    const calls = await probe.toolCalls(world.den.mocks.connector, { name: "read_connection_status", atLeast: 1, timeoutMs: 15_000 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.tokenId !== null)).toBe(true);
    const session = world.sessions.admin;
    if (!session) throw new Error("Missing original task identity");
    const transcript = await appProbe.desktopApi(`/workspace/${session.workspaceId}/opencode/session/${session.sessionId}/message`);
    expect(transcript.status).toBe(200);
    const assistantInfo = records(transcript.body).map(message => message.info).filter(isRecord).filter(info => info.role === "assistant");
    expect(assistantInfo.length).toBeGreaterThan(0);
    expect(assistantInfo.every(info => info.providerID === "openai" && info.modelID === world.modelId)).toBe(true);
    expect(await inventory()).toHaveLength(1);
    expect((await appProbe.composer()).draftText).toBe(unsentDraft);
    await appUser.screenshot();
    evidence.recordAssertionEvidence("Saving and provider sign-in resume the original task with a real service call", `Exactly one Den row was saved before authorization, including after pausing and retrying sign-in; OAuth app repair fields were available. The app showed Ready only after sign-in. The real model called read_connection_status ${calls.length} time(s) with a member credential and rendered the service-only verification code; the prompt contained neither the code nor a connection ID, and an unrelated unsent composer draft was preserved.`, true);
  });

  await step("An ordinary member cannot create or use the admin's private connection", async () => {
    await agent.on(world.memberApp).send(`Help me set up the MCP service at ${endpoint}.`);
    await memberUser.see(setupButton, { timeoutMs: 120_000 });
    await probe.eventually(() => probe.on(world.memberApp).composer(), { within: 120_000, label: "member setup reply finishes before selecting its card", until: state => state.runTaskVisible });
    await memberUser.click(setupButton);
    await memberUser.see({ testId: "connection-setup-sheet" });
    await memberUser.see({ text: "An organization admin or connection manager needs to set up this service and grant you access." });
    await memberUser.notSee({ role: "button", label: "Save and sign in" });
    await memberUser.notSee({ role: "button", label: "Sign in" });
    await memberUser.screenshot();
    const memberInventory = await probe.api(world.den.members.member!, "/v1/mcp-connections");
    expect(memberInventory.response.status).toBe(200);
    expect(isRecord(memberInventory.body) ? records(memberInventory.body.connections) : []).toEqual([]);
    expect(await inventory()).toHaveLength(1);
    evidence.recordAssertionEvidence("A member sees an access explanation and cannot inherit the admin's account", "A second real model found setup for the same endpoint. The member saw no save or sign-in action and their usable inventory remained empty; the admin still has exactly one connection.", true);
  });

  await step("A service outage preserves sign-in without claiming readiness", async () => {
    await world.setToolsUnavailable(true);
    await appUser.click({ role: "button", label: `Manage ${hostname}` });
    await appUser.see({ role: "button", label: "Check connection" });
    await appUser.click({ role: "button", label: "Check connection" });
    await appUser.see({ text: "Sign-in is saved, but the service's tools could not be loaded. Try checking again." }, { timeoutMs: 90_000 });
    await appUser.notSee({ text: "Ready to use" });
    await appUser.screenshot();
    const saved = await inventory();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe(connectionId);
    expect(saved[0]?.connectedForMe).toBe(true);
    await world.setToolsUnavailable(false);
    await appUser.click({ role: "button", label: "Check connection" });
    await appUser.see({ text: "Ready to use" }, { timeoutMs: 90_000 });
    expect(await world.browserUrls.opened()).toHaveLength(4);
    expect(await inventory()).toHaveLength(1);
    await appUser.screenshot();
    await appUser.click({ role: "button", label: "Back to task" });
    await appUser.see({ role: "button", label: `Manage ${hostname}` });
    evidence.recordAssertionEvidence("Saved authorization and live tool readiness are separate, recoverable states", "An injected tools/list outage produced the explicit failure state while Den retained one connected row. Checking after recovery returned Ready in the sheet and restored the chat card's Connected action without creating a second row or opening OAuth again.", true);
  });

  await step("The same native sheet shows the required OAuth app fields", async () => {
    await agent.on(world.app).createSession();
    await agent.on(world.app).send("Show me all the quick-add connectors so I can set up Google Workspace. After showing the catalog, explain individual and shared accounts in three short paragraphs.");
    await appUser.see({ role: "button", label: "Set up Google Workspace" }, { timeoutMs: 120_000 });
    await appUser.click({ role: "button", label: "Set up Google Workspace" });
    await appUser.see({ role: "textbox", label: "Client ID" });
    await appUser.see({ text: "Client secret" });
    await appUser.see({ role: "textbox", label: "Redirect URI" });
    await appUser.type({ role: "textbox", label: "Connection name" }, "Workspace OAuth setup", { replace: true });
    await probe.eventually(() => appProbe.composer(), { within: 120_000, label: "real-model response finishes while setup stays open", until: state => state.runTaskVisible });
    await appUser.see({ role: "textbox", label: "Client ID" });
    expect(await appProbe.eval(() => document.querySelector<HTMLInputElement>('#connection-name')?.value)).toBe("Workspace OAuth setup");
    const callback = await appProbe.eval(() => document.querySelector<HTMLInputElement>('#connection-callback')?.value);
    expect(new URL(String(callback)).pathname).toBe("/v1/oauth-providers/google-workspace/connect/callback");
    expect(await appProbe.eval(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Save and sign in')?.disabled)).toBe(true);
    expect(await inventory()).toHaveLength(1);
    await appUser.screenshot();
    evidence.recordAssertionEvidence("Provider app configuration stays in the task and cannot save incomplete credentials", "The real model's catalog opens Google's native OAuth app form, with the provider callback and client fields. The form remains open with its entered name when the model response finishes. Save is disabled with no client ID, and Den has no new connection. No real Google authorization was attempted.", true);
  });
  await step("An older server retains its organization setup path", async () => {
    await appUser.click({ role: "button", label: "Close" });
    await probe.eventually(() => appProbe.dom('[data-testid="connection-setup-sheet"]'), { within: 10_000, label: "native sheet finishes closing", until: state => state.elements.length === 0 });
    await appUser.notSee({ testId: "connection-setup-sheet" });
    await world.proxy.faults.status("/api/den/v1/mcp-connections/setup", 404, { times: 100, body: { error: "not_found", message: "Not Found" } });
    await appUser.click({ role: "button", label: "Set up Google Workspace" });
    await appUser.see({ text: "This OpenWork server doesn't support setup in the app yet." });
    await appUser.notSee({ role: "button", label: "Save and sign in" });
    await appUser.screenshot();
    await appUser.click({ role: "button", label: "Open organization setup" });
    await probe.eventually(async () => (await world.browserUrls.opened()).length, { within: 30_000, label: "organization setup browser handoff", until: value => value === 5 });
    const opened = (await world.browserUrls.opened())[4];
    expect(opened).toBe(new URL("/dashboard/mcp-connections", world.proxy.ref.webUrl).toString());
    expect((await world.proxy.requestLog()).some(request => request.faulted && request.path.startsWith("/api/den/v1/mcp-connections/setup") && request.status === 404)).toBe(true);
    expect(await inventory()).toHaveLength(1);
    evidence.recordAssertionEvidence("An unsupported Den server keeps a usable setup path", "A transport proxy returned the older-server 404 for native setup. The real model's catalog showed the compatibility explanation and opened only the configured Den organization's setup URL, with no new connection created. This simulates the missing endpoint; it does not boot a historical Den release.", true);
  });
  await step("Den settings display the same terminal OAuth failure", async () => {
    await world.setToolsUnavailable(false, false);
    // A rejected grant retains client registration; an invalid client clears it.
    await world.setOAuthFault("grant_rejected");
    const denUser = user.on(world.web);
    await denUser.navigate(new URL("/dashboard/mcp-connections", world.den.ref.webUrl).toString());
    await denUser.click({ role: "button", label: "Advanced setup" });
    await denUser.type({ placeholder: "notion" }, "Den Diagnostic Service", { replace: true });
    await denUser.type({ placeholder: "https://mcp.example.com/mcp" }, endpoint, { replace: true });
    await probe.eventually(() => probe.on(world.web).eval(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="add-mcp-connection-dialog"] button')).some(button => button.textContent?.trim() === "Add connection" && !button.disabled)), { within: 45_000, label: "Den requirements allow creation", until: ready => ready });
    // Discovery adds scope fields and moves the account controls. Select only
    // after it settles, then prove the intended account mode before saving.
    await denUser.click({ role: "button", label: "One org account" });
    await probe.eventually(() => probe.on(world.web).eval(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="add-mcp-connection-dialog"] button')).some(button => button.textContent?.trim() === "One org account" && button.getAttribute("aria-pressed") === "true")), { within: 5_000, label: "Den selects a shared account", until: selected => selected });
    // Shared-account creation starts OAuth through the same human click.
    await denUser.click({ role: "button", label: "Add connection" });
    await denUser.see({ text: "Den Diagnostic Service" }, { timeoutMs: 60_000 });
    expect((await inventory()).find(row => row.name === "Den Diagnostic Service")?.credentialMode).toBe("shared");
    await denUser.see({ text: /MCP_OAUTH_INVALID_GRANT/ }, { timeoutMs: 45_000 });
    await denUser.see({ text: /AUTH_TOKEN_ACQUISITION/ });
    await denUser.notSee({ text: "Waiting for authorization…" });
    const after = await inventory();
    const id = after.find(row => row.name === "Den Diagnostic Service")?.id;
    expect(typeof id).toBe("string");
    expect(after.find(row => row.id === id)?.connected).toBe(false);
    expect(after.find(row => row.id === connectionId)?.connectedForMe).toBe(true);
    await denUser.screenshot();
    await denUser.click({ role: "button", label: "More actions for Den Diagnostic Service" });
    await denUser.click({ role: "menuitem", label: "Edit Den Diagnostic Service" });
    await denUser.see({ text: /A saved client ID does not confirm sign-in or tool access\./ });
    await denUser.see({ text: "Client authentication" });
    await denUser.screenshot();
    const registration = after.find(row => row.id === id)?.oauthRegistrationSource;
    expect(["dynamic", "client-metadata"]).toContain(registration);
    await denUser.type({ testId: "edit-mcp-name" }, "Renamed Diagnostic Service", { replace: true });
    await denUser.click({ role: "button", label: "Save changes" });
    await probe.eventually(() => probe.on(world.web).dom('[data-testid="edit-mcp-connection-dialog"]'), { within: 30_000, label: "Den saves and closes the edit dialog", until: state => state.elements.length === 0 });
    await denUser.notSee({ testId: "edit-mcp-connection-dialog" });
    const renamed = (await inventory()).find(row => row.id === id);
    expect(renamed?.name).toBe("Renamed Diagnostic Service");
    expect(renamed?.oauthRegistrationSource).toBe(registration);
    expect(renamed?.oauthClientId).toBe(after.find(row => row.id === id)?.oauthClientId);
    evidence.recordAssertionEvidence("Den and the task share OAuth outcomes while configuration stays separate", "A real Den Add connection click saved a shared connection and started OAuth against the controlled provider's automatic consent fixture, showing MCP_OAUTH_INVALID_GRANT at AUTH_TOKEN_ACQUISITION within 45 seconds. The failed shared connection stayed disconnected while the original member connection stayed connected. Edit explained that a saved client ID is not proof of sign-in and exposed client authentication settings. Saving a name-only edit preserved the automatically registered client ID and registration method.", true);
    await world.setOAuthFault(null);
  });
  } catch (error) {
    const connections = await inventory().catch(() => []);
    evidence.recordAssertionEvidence("Diagnostic: connection state at failure", JSON.stringify(connections.map(row => ({ name: row.name, authType: row.authType, credentialMode: row.credentialMode, connected: row.connected, connectedForMe: row.connectedForMe, registration: row.oauthRegistrationSource }))), false);
    await appUser.screenshot().catch(() => undefined);
    await memberUser.screenshot().catch(() => undefined);
    await user.on(world.web).screenshot().catch(() => undefined);
    const session = world.sessions.admin;
    if (session) {
      const transcript = await appProbe.desktopApi(`/workspace/${session.workspaceId}/opencode/session/${session.sessionId}/message`).catch(() => null);
      const calls = records(transcript?.body).flatMap(message => records(message.parts).filter(part => part.type === "tool").map(part => ({ tool: part.tool, state: isRecord(part.state) ? part.state.status : null })));
      evidence.recordAssertionEvidence("Diagnostic: real-model tool path at failure", JSON.stringify(calls), false);
    }
    throw error;
  }

});
