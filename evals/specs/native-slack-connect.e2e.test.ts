import { expect } from "vitest";
import { spec, type Agent, type Probe, type User } from "@openwork/testkit";
import { nativeSlackConnect } from "../worlds/native-slack-connect.ts";

const test = spec.world(nativeSlackConnect, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den", "mock"] },
  // Native HTTP provider mocks currently have no remote co-location interface.
  // The runner still owns placement; a non-local placement reports needs, never
  // silently switches to local or contacts Slack. This is not packaged proof.
  needs: { commands: ["pnpm", "bun"] },
});

type AppActor = {
  user: User;
  probe: Probe;
  agent: Agent;
  email: string;
  workspaceId: string;
  url: string;
  label: string;
};

async function closeConnections(user: User, probe: Probe) {
  // The picker handles Escape as Back in a submenu and Close at the root.
  // Focus each observed search field so both keys reach that menu, not a
  // different browser window left in front by an admin/OAuth interaction.
  await user.click({ placeholder: "Search connectors" });
  await user.press("Escape");
  await user.click({ placeholder: "Search files, skills, connectors" });
  await user.press("Escape");
  await probe.eventually(() => probe.dom("[data-composer-plus-menu]"), {
    within: 5_000, label: "the picker has finished closing",
    until: value => value.elements.every(element => element.rect.width === 0 || element.rect.height === 0),
  });
  await user.notSee({ role: "option", label: /^Connectors/ });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected feature state");
  return Object.fromEntries(Object.entries(value));
}

test("a platform admin rolls Slack search out by organization while members keep their own private access", async ({ world, user, agent, probe, step, evidence }) => {
  const second = user.on(world.secondApp);
  const secondProbe = probe.on(world.secondApp);
  const firstApp: AppActor = { user, probe, agent, email: world.first.email, workspaceId: world.workspaceId, url: world.appUrl, label: "First member" };
  const secondApp: AppActor = { user: second, probe: secondProbe, agent: agent.on(world.secondApp), email: world.second.email, workspaceId: world.secondWorkspaceId, url: world.secondAppUrl, label: "Second member" };
  const admin = user.on(world.adminWeb);
  const adminProbe = probe.on(world.adminWeb);
  const otherOwner = user.on(world.otherWeb);
  const member = user.on(world.memberWeb);
  const memberProbe = probe.on(world.memberWeb);
  const denUrl = (path: string) => new URL(path, world.connectionsUrl).toString();
  const recordedReadyApps = new Set<string>();
  const waitForAccountReady = async (app: AppActor) => {
    // An editable hero can precede Den restoration. Its draft-owner key changes
    // when the verified identity arrives, remounting the composer and its menu.
    // Both members were signed in by world setup; a persisted credential alone
    // or an unavailable/checking auth state is not readiness for these actions.
    const auth = await app.probe.eventually(async () => {
      const state = record(await app.agent.run("auth.status"));
      const member = state.user === null ? null : record(state.user);
      return { status: state.status, expectedMember: member?.email === app.email };
    }, {
      within: 60_000, label: `${app.label}: the expected account has finished restoring`,
      until: state => state.status === "signed_in" && state.expectedMember,
    });
    const route = await app.probe.eventually(() => app.probe.workspaceReadiness(app.workspaceId), {
      within: 60_000, label: `${app.label}: the expected workspace is connected and loaded`,
      until: state => Object.values(state).every(value => value === true),
    });
    if (!recordedReadyApps.has(app.workspaceId)) {
      evidence.recordAssertionEvidence(`${app.label}: account and workspace readiness`, JSON.stringify({ auth, route }), true);
      recordedReadyApps.add(app.workspaceId);
    }
  };
  const waitForAppDocument = async (app: AppActor, previousTimeOrigin: number, requiresNewDocument: boolean) => {
    await app.probe.eventually(() => app.probe.documentState(app.url), {
      within: 60_000, label: `${app.label}: ${requiresNewDocument ? "a new app document has loaded" : "the app document is ready"}`,
      until: state => state.sameOrigin && state.complete && (!requiresNewDocument || state.timeOrigin !== previousTimeOrigin),
    });
    await waitForAccountReady(app);
  };
  const reloadApp = async (app: AppActor) => {
    const before = await app.probe.documentState(app.url);
    await app.user.reload();
    // readyState alone can still describe the retiring document after Page.reload.
    await waitForAppDocument(app, before.timeOrigin, true);
  };
  const navigateToApp = async (app: AppActor) => {
    const before = await app.probe.documentState(app.url);
    // user.navigate uses Page.navigate. Returning from OAuth changes the document;
    // a fragment-only navigation or an exact-URL no-op does not require a new epoch.
    if (!before.sameUrl) await app.user.navigate(app.url);
    // The web router may canonicalize the fragment URL to a pathname. Observe
    // the app origin plus the public selected-workspace state, not a frozen URL.
    await waitForAppDocument(app, before.timeOrigin, !before.sameUrl && !before.sameDocumentFragment);
  };
  const navigateAdmin = async (url: string) => {
    const before = await adminProbe.documentState(url);
    // Do not reload an already-selected /admin page and type into its retiring
    // input. Page.navigate only dispatches navigation; wait for the new document
    // before observing controls. Fragment-only transitions keep the current epoch.
    if (!before.sameUrl) await admin.navigate(url);
    const requiresNewDocument = !before.sameUrl && !before.sameDocumentFragment;
    await adminProbe.eventually(() => adminProbe.documentState(url), {
      within: 60_000, label: "the requested admin document is ready",
      until: state => state.sameUrl && state.sameOrigin && state.complete
        && (!requiresNewDocument || state.timeOrigin !== before.timeOrigin),
    });
  };
  const openConnections = async (app: AppActor) => {
    await waitForAccountReady(app);
    await app.user.click({ role: "button", label: "Add files, skills, connectors, and more" });
    await app.user.click({ role: "option", label: /^Connectors/ });
  };
  const preparePrompt = async (app: AppActor, prompt: string, label: string) => {
    const { user: actor, probe: actorProbe } = app;
    await step(`${label}: verify the draft and submission readiness`, async () => {
      await waitForAccountReady(app);
      const readReadiness = async () => {
        const state = await actorProbe.composer();
        // Compare the actual draft exactly; evidence contains only flags and
        // length, never arbitrary draft contents or credentials.
        return {
          draftMatchesPrompt: state.draftText === prompt,
          draftLength: state.draftText.length,
          composerEditable: state.composerEditable,
          runTaskVisible: state.runTaskVisible,
          runTaskEnabled: state.runTaskEnabled,
          modelUnavailable: state.modelUnavailable,
        };
      };
      const before = await readReadiness();
      let afterTyping: Awaited<ReturnType<typeof readReadiness>> | null = null;
      let last = before;
      const assertion = `${label}: the exact draft is ready for one Run task click`;
      try {
        await actor.type("composer", prompt, { verify: true });
        afterTyping = await readReadiness();
        last = afterTyping;
        const ready = await actorProbe.eventually(async () => {
          last = await readReadiness();
          return last;
        }, {
          within: 30_000, label: assertion,
          until: state => state.draftMatchesPrompt && state.composerEditable && state.runTaskVisible
            && state.runTaskEnabled && !state.modelUnavailable,
        });
        expect(ready).toMatchObject({ draftMatchesPrompt: true, composerEditable: true, runTaskVisible: true, runTaskEnabled: true, modelUnavailable: false });
        evidence.recordAssertionEvidence(assertion, `Before typing: ${JSON.stringify(before)}; after verified typing: ${JSON.stringify(afterTyping)}; ready: ${JSON.stringify(ready)}.`, true);
      } catch (error) {
        const current = await readReadiness().catch(() => null);
        evidence.recordAssertionEvidence(assertion, `Before typing: ${JSON.stringify(before)}; after typing: ${JSON.stringify(afterTyping)}; last observed: ${JSON.stringify(last)}; current: ${JSON.stringify(current)}. No submission was attempted.`, false);
        // Diagnostics must not replace the original typing/readiness failure.
        await actor.screenshot().catch(() => undefined);
        throw error;
      }
    });
  };
  const privateConversation = world.slack.conversations.find(entry => entry.type === "private_channel");
  if (!privateConversation) throw new Error("The synthetic private conversation is missing");
  let retainedSearchName = "";
  const retainedAccounts = new Map<"first" | "other", { connectedAt: string; externalAccountId: string }>();
  const rememberAccount = async (identity: "first" | "other") => {
    const account = await world.connection(identity);
    if (typeof account?.connectedAt !== "string" || typeof account.externalAccountId !== "string") {
      throw new Error("Expected a connected account before changing availability");
    }
    retainedAccounts.set(identity, { connectedAt: account.connectedAt, externalAccountId: account.externalAccountId });
  };
  const featureState = async (organizationId: string) =>
    record(record((await world.organizationFeatures(organizationId)).featureStates).nativeSlack);
  const expectFeature = async (organizationId: string, enabled: boolean, override: boolean | null, source: string) => {
    const state = await probe.eventually(() => featureState(organizationId), {
      within: 30_000, label: "the shared feature setting is saved",
      until: value => value.enabled === enabled && value.override === override && value.source === source,
    });
    expect(state).toMatchObject({ enabled, override, source });
  };
  const openOrganization = async (slug: string) => {
    await navigateAdmin(world.adminUrl);
    await admin.see({ role: "button", label: /Organizations \(/ });
    await admin.click({ role: "button", label: /Organizations \(/ });
    await admin.see({ placeholder: "Org name, slug, or id" }, { editable: true });
    // The loading banner sits above the filter. Wait for the known organization
    // inventory before measuring/clicking an input that can still move vertically.
    await adminProbe.eventually(async () => {
      const rows = await adminProbe.dom('[data-testid^="admin-org-row-"]');
      const busy = await adminProbe.dom('[aria-busy="true"]');
      return { rows: rows.elements.length, busy: busy.elements.some(element => element.rect.width > 0 && element.rect.height > 0) };
    }, { within: 30_000, label: "the organization inventory has loaded", until: value => value.rows > 0 && !value.busy });
    await admin.type({ placeholder: "Org name, slug, or id" }, slug, { replace: true, verify: true });
    await probe.eventually(() => adminProbe.dom('[data-testid^="admin-org-row-"]'), {
      within: 30_000, label: "only the requested organization is on screen", until: value => value.elements.length === 1,
    });
    await admin.see({ testId: `admin-org-row-${slug}` });
    await admin.see({ testId: "admin-capability-nativeSlack" });
  };
  const toggleOrganization = async (organizationId: string, slug: string, enabled: boolean) => {
    await openOrganization(slug);
    expect((await featureState(organizationId)).enabled).toBe(!enabled);
    await admin.click({ testId: "admin-capability-nativeSlack" });
    await expectFeature(organizationId, enabled, enabled, "override");
    await admin.see({ testId: "admin-capability-source-nativeSlack" }, { text: "Set for this organization" });
    expect((await adminProbe.dom('[data-testid="admin-capability-nativeSlack"]:checked')).elements).toHaveLength(enabled ? 1 : 0);
  };
  const setEveryone = async (enabled: boolean) => {
    await navigateAdmin(world.featuresUrl);
    await admin.see({ testId: "admin-feature-nativeSlack" });
    // Testkit targets cannot be scoped to an ancestor. Resolve the radio index
    // from the actual generated rows, never from a copied registry key order.
    const rows = await adminProbe.dom('li[data-testid^="admin-feature-"]');
    const index = rows.elements.findIndex(entry => entry.text.startsWith("Slack search"));
    expect(index).toBeGreaterThanOrEqual(0);
    await admin.click({ role: "radio", label: enabled ? "On" : "Off", nth: index });
    const saved = await probe.eventually(() => world.globalSlackFeature(), {
      within: 30_000, label: "the everyone setting is saved", until: value => value?.enabled === enabled,
    });
    expect(saved).toMatchObject({ enabled, killed: false, lock: null });
    await admin.see({ testId: "admin-feature-state-nativeSlack" }, {
      text: enabled ? "On for everyone · organization overrides apply" : "Off · organization overrides only",
    });
  };
  const expectBlocked = async (identity: "first" | "other") => {
    const before = world.slack.calls().length;
    const starts = [];
    for (const path of ["/v1/mcp-connections/slack/connect/start", "/v1/oauth-providers/slack/connect/start", "/v1/oauth-providers/slack/status"]) {
      starts.push(await world.memberRequest(identity, path));
    }
    expect(starts.every(response => response.status === 403)).toBe(true);
    const search = await world.memberRequest(identity, "/v1/capabilities/slack/search?query=Amber%20launch");
    const thread = await world.memberRequest(identity, `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}`);
    for (const result of [search, thread]) expect(result).toMatchObject({ status: 403, body: { error: "policy_blocked" } });
    const catalog = await world.mcp(identity, "search_capabilities", { query: "slack", type: "api", limit: 20 });
    expect(catalog.status).toBe(200);
    expect(world.objects(catalog.body).some(entry => typeof entry.name === "string" && entry.name.startsWith("native:") && /slack(?:search|threads)$/i.test(entry.name))).toBe(false);
    if (retainedSearchName) {
      const retained = await world.mcp(identity, "execute_capability", { name: retainedSearchName, query: { query: "Amber launch" } });
      expect(retained.status).toBe(200);
      expect(world.objects(retained.body).some(entry => entry.error === "policy_blocked")).toBe(true);
    }
    expect(world.slack.calls()).toHaveLength(before);
    return [...starts.map(result => result.status), search.status, thread.status];
  };

  await step("given: both members have isolated, working agent runtimes", async () => {
    await user.see("composer", { editable: true });
    await second.see("composer", { editable: true });
    if (world.engine === "v2") {
      const runtimes = [];
      const identities: Array<"first" | "second"> = ["first", "second"];
      for (const identity of identities) {
        const result = await probe.eventually(() => world.appRequest(identity, "/experimental/engine-v2-preview/status"), {
          within: 60_000, label: "the pinned V2 runtime is running", until: result => result.status === 200 && world.objects(result.body).some(entry => entry.running === true),
        });
        const runtime = world.objects(result.body).find(entry => entry.running === true);
        expect(runtime).toMatchObject({ enabled: true, chatRouting: true, running: true, version: world.engineVersion, binSource: "env" });
        expect(typeof runtime?.pid).toBe("number");
        runtimes.push(runtime);
      }
      expect(runtimes[0]?.pid).not.toBe(runtimes[1]?.pid);
      evidence.recordAssertionEvidence("The two app profiles use distinct pinned V2 runtimes", `Both public runtime status calls confirm ${world.engineVersion}, enabled chat routing, and distinct running process IDs. No engine settings were changed by the spec.`, true);
    } else {
      expect((await world.appRequest("first", "/health")).status).toBe(200);
      expect((await world.appRequest("second", "/health")).status).toBe(200);
      evidence.recordAssertionEvidence("Both legacy app profiles are healthy", "Two independently launched app servers returned HTTP 200; no V2-specific runtime claim is made for this selection.", true);
    }
  });

  await step("before: deployment credentials alone do not offer Slack to either organization", async () => {
    await openOrganization(world.organizationSlug);
    await admin.see({ testId: "admin-capability-source-nativeSlack" }, { text: "Off for everyone" });
    await expectFeature(world.organizationId, false, null, "everyone");
    await expectFeature(world.otherOrganizationId, false, null, "everyone");
    expect(await world.globalSlackFeature()).toMatchObject({ default: false, enabled: false, killed: false, lock: null, available: true, deployments: ["cloud"] });
    expect((await adminProbe.dom('[data-testid="admin-capability-nativeSlack"]:checked')).elements).toHaveLength(0);
    expect(await world.connection("first")).toBeUndefined();
    expect(await world.connection("other")).toBeUndefined();
    await expectBlocked("first");
    await expectBlocked("other");
    expect(world.slack.calls()).toHaveLength(0);
    await user.see("composer", { editable: true });
    await openConnections(firstApp);
    await user.notSee({ role: "button", label: "Connect Slack" });
    evidence.recordAssertionEvidence("Credentials do not grant the feature", "Both organizations inherit Slack search=false; neither has a native connection or catalog entry. Start/status/search/threads are denied and Slack received 0 requests despite configured synthetic client credentials.", true);
    await admin.screenshot();
    await user.screenshot();
    await closeConnections(user, probe);
  });

  await step("before: managed Slack stays out of Dashboard and the catalogs while its feature is off", async () => {
    await navigateAdmin(denUrl("/dashboard"));
    await admin.see({ testId: "dashboard-activity" });
    await admin.notSee({ testId: "dashboard-managed-slack" });
    await admin.notSee({ testId: "connect-slack-search" });
    await admin.screenshot();
    await navigateAdmin(denUrl("/dashboard/mcp-connections/new"));
    await admin.see({ testId: "slack-custom-app-disclosure" });
    await admin.notSee({ testId: "connector-picker-slack-search" });
    await admin.notSee({ testId: "connect-slack-search" });
    await admin.screenshot();
    await member.navigate(denUrl("/dashboard/library/connectors/new"));
    await member.see({ testId: "slack-custom-app-disclosure" });
    await member.notSee({ testId: "connector-picker-slack-search" });
    await member.notSee({ testId: "connect-slack-search" });
    expect(await world.connection("first")).toBeUndefined();
    evidence.recordAssertionEvidence("The organization switch also controls web discovery", "Dashboard keeps Activity without a managed Slack action. The loaded admin catalog retains the custom-app choice but offers no managed Slack row or action. The member catalog likewise has no managed action, and the server has no native connection for the member.", true);
    await member.screenshot();
  });

  await step("an organization owner cannot grant themselves a platform feature", async () => {
    await otherOwner.see({ role: "heading", label: "Admin access required" }, { timeoutMs: 60_000 });
    const context = await world.memberRequest("other", "/v1/org");
    expect(context).toMatchObject({ status: 200, body: { organization: { id: world.otherOrganizationId }, currentMember: { isOwner: true } } });
    const denied = await world.memberRequest("other", `/v1/admin/organizations/${world.otherOrganizationId}/capabilities`, "PUT", { capabilities: { nativeSlack: true } });
    expect(denied.status).toBe(403);
    const global = await world.memberRequest("other", "/v1/admin/features/nativeSlack", "PUT", { enabled: true });
    expect(global.status).toBe(403);
    await expectFeature(world.otherOrganizationId, false, null, "everyone");
    evidence.recordAssertionEvidence("Organization ownership is not platform administration", `The authenticated owner of B sees Admin access required; organization override and everyone-setting writes both returned ${denied.status}. B remains default-off.`, true);
    await otherOwner.screenshot();
  });

  await step("the platform admin enables Slack search for the first organization only", async () => {
    await toggleOrganization(world.organizationId, world.organizationSlug, true);
    await expectFeature(world.otherOrganizationId, false, null, "everyone");
    const report = await world.organizationFeatures(world.organizationId);
    expect(report.capabilities).toMatchObject({ nativeSlack: true, slackAssistant: false, slackWorkbotReplies: false });
    expect(record(report.capabilities).mcpConnections).toBeUndefined();
    const context = await world.memberRequest("first", "/v1/org");
    expect(context).toMatchObject({ status: 200, body: { capabilities: { mcpConnections: true }, features: { nativeSlack: true } } });
    expect(await world.connection("first")).toMatchObject({ id: "slack", connectedForMe: false });
    expect(await world.connection("other")).toBeUndefined();
    const statuses = await expectBlocked("other");
    expect(world.slack.calls()).toHaveLength(0);
    evidence.recordAssertionEvidence("One organization receives the shared feature override", `The generated Slack search checkbox saved A=true while B inherits false. Slack Assistant and its Workbot replies feature remain false. B's start/status/search/threads returned ${statuses.join(" / ")}; 0 provider requests.`, true);
    await admin.screenshot();
  });

  await step("after: the first member gets Connect Slack while the other organization has no entry", async () => {
    await reloadApp(firstApp);
    await user.see("composer", { editable: true });
    await openConnections(firstApp);
    await user.see({ role: "button", label: "Connect Slack" });
    await user.notSee({ text: /^Client ID$/i });
    await user.notSee({ text: /^Client secret$/i });
    await otherOwner.navigate(world.connectionsUrl);
    await otherOwner.see({ role: "heading", text: "Your Connections" });
    await otherOwner.notSee({ testId: "connect-my-mcp-account-slack" });
    expect(await world.connection("other")).toBeUndefined();
    evidence.recordAssertionEvidence("The member experience follows the organization switch", "A offers Connect Slack without developer credential fields. B's Your Connections has no Slack connect action and its usable-connection response has no Slack row; no provider request has occurred.", true);
    await user.screenshot();
    await otherOwner.screenshot();
    await closeConnections(user, probe);
  });

  await step("Connect is GA: its retired opt-out is ignored without granting Slack access", async () => {
    await openOrganization(world.organizationSlug);
    await admin.notSee({ testId: "admin-capability-mcpConnections" });
    const before = world.slack.calls().length;
    const legacy = await world.submitRetiredConnectOverride(world.organizationId);
    expect(legacy).toMatchObject({ status: 200, body: { ok: true } });
    const report = await world.organizationFeatures(world.organizationId);
    expect(record(report.capabilities).mcpConnections).toBeUndefined();
    expect(record(report.featureStates).mcpConnections).toBeUndefined();
    await expectFeature(world.organizationId, true, true, "override");
    const context = await world.memberRequest("first", "/v1/org");
    expect(context).toMatchObject({ status: 200, body: { capabilities: { mcpConnections: true }, features: { nativeSlack: true } } });
    expect(record(record(context.body).features).mcpConnections).toBeUndefined();
    for (const path of ["/v1/mcp-connections/slack/connect/start", "/v1/oauth-providers/slack/connect/start"]) {
      expect((await world.memberRequest("first", path)).status).toBe(200);
    }
    const unconnected = await world.memberRequest("first", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(unconnected).toMatchObject({ status: 409, body: { error: "needs_connection" } });
    await expectFeature(world.otherOrganizationId, false, null, "everyone");
    await expectBlocked("other");
    expect(world.slack.calls()).toHaveLength(before);
    await navigateAdmin(world.featuresUrl);
    await admin.see({ testId: "admin-feature-nativeSlack" });
    await admin.notSee({ testId: "admin-feature-mcpConnections" });
    evidence.recordAssertionEvidence("Retired Connect controls cannot disable GA or grant Slack consent", "The legacy mcpConnections=false input is accepted and ignored, with no organization or deployment control. The member API keeps compatibility=true while registry features omit the retired key. A's Slack override stays true: starts succeed, but search still needs its own account (409). B stays policy-blocked; 0 provider calls.", true);
    await admin.screenshot();
  });

  await step("GA Connect leaves the enabled member's authorization entry available", async () => {
    await reloadApp(firstApp);
    await user.see("composer", { editable: true });
    await openConnections(firstApp);
    await user.see({ role: "button", label: "Connect Slack" });
    expect(await world.connection("first")).toMatchObject({ connectedForMe: false });
    expect(await world.connection("other")).toBeUndefined();
    evidence.recordAssertionEvidence("Slack rollout and personal consent remain separate requirements", "A retains its Connect Slack entry after the ignored legacy opt-out. B remains off and both members still need their own OAuth consent. No account was injected.", true);
    await user.screenshot();
  });

  await step("a forwarded Slack authorization link cannot connect another person's account", async () => {
    const before = world.slack.calls().length;
    // A legitimate initiating member hands their whole signed provider URL to
    // another person's independently signed-in Den browser. State is not identity.
    await otherOwner.navigate(await world.startAuthorization("first"));
    await otherOwner.see({ text: "Synthetic Slack consent" });
    await otherOwner.click({ role: "button", text: "Authorize member two" });
    await otherOwner.see({ role: "heading", text: /^(Connection failed|You're connected)$/ }, { timeoutMs: 30_000 });
    const account = await world.connection("first");
    expect(account?.connectedForMe).toBe(false);
    expect(world.slack.calls()).toHaveLength(before);
    await otherOwner.see({ role: "heading", text: "Connection failed" });
    evidence.recordAssertionEvidence("A signed state cannot transfer someone else's Slack authorization", "The callback rejects a different OpenWork browser user before token exchange. The initiating member stays disconnected and the provider receives zero API requests.", true);
    await otherOwner.screenshot();
    await otherOwner.navigate(world.connectionsUrl);
  });

  await step("a signed-out browser cannot finish Connect with only the link or a bearer token", async () => {
    const unsigned = user.on(world.signedOutWeb);
    const before = world.slack.calls().length;
    await unsigned.navigate(await world.startAuthorization("first"));
    await unsigned.see({ text: "Synthetic Slack consent" });
    await unsigned.click({ role: "button", text: "Authorize member one" });
    await unsigned.see({ role: "heading", text: "Connection failed" }, { timeoutMs: 30_000 });
    await unsigned.see({ text: /Sign in to OpenWork in this browser/ });
    const bearer = await world.replayUnsignedCallbackWithBearer();
    expect(bearer.status).toBe(400);
    expect(bearer.text).toContain("Sign in to OpenWork in this browser");
    const transport = await world.callbackTransportBoundaries();
    expect(transport).toMatchObject({ method: 405, duplicate: 400, generic: 403 });
    expect(transport.genericBody).toContain("forbidden_origin");
    expect((await world.connection("first"))?.connectedForMe).toBe(false);
    expect(world.slack.calls()).toHaveLength(before);
    evidence.recordAssertionEvidence("Browser authentication cannot be replaced by URL possession or bearer authority", "Both the signed-out browser and a direct callback with the initiator's valid bearer are rejected before exchange. No member grant is saved; provider API requests remain unchanged.", true);
    await unsigned.screenshot();
  });

  await step("signing out during the token exchange prevents the account from being saved", async () => {
    const browser = user.on(world.revokedWeb);
    await browser.navigate(await world.startAuthorization("first"));
    await browser.see({ text: "Synthetic Slack consent" });
    const held = world.slack.pauseNextTokenExchange();
    try {
      await browser.click({ role: "button", text: "Authorize member one" });
      await probe.eventually(() => held.received, { within: 10_000, label: "the authorized callback has entered token exchange", until: value => value });
      expect(await world.revokeAuthorizingBrowserSession()).toBe(200);
    } finally {
      held.release();
    }
    await browser.see({ role: "heading", text: "Connection failed" }, { timeoutMs: 30_000 });
    expect((await world.connection("first"))?.connectedForMe).toBe(false);
    const before = world.slack.calls().length;
    expect(await world.memberRequest("first", "/v1/capabilities/slack/search?query=Amber%20launch")).toMatchObject({ status: 409, body: { error: "needs_connection" } });
    expect(world.slack.calls()).toHaveLength(before);
    evidence.recordAssertionEvidence("A revoked browser session cannot complete a late account link", "The test held a real token exchange after browser verification, signed out that browser session, then released the response. The callback saved no usable grant; search still requires a connection and makes no provider request.", true);
    await browser.screenshot();
  });

  await step("after: the dashboard and catalogs offer the OpenWork app without custom setup", async () => {
    await navigateAdmin(denUrl("/dashboard"));
    await admin.see({ testId: "dashboard-managed-slack" });
    await admin.see({ testId: "dashboard-activity" });
    await admin.see({ testId: "connect-slack-search" }, { text: "Connect Slack" });
    await admin.see({ text: "Provided by OpenWork" });
    await admin.screenshot();
    await navigateAdmin(denUrl("/dashboard/mcp-connections/new"));
    await admin.see({ testId: "connector-picker-slack-search" });
    await admin.see({ testId: "connect-slack-search" }, { text: "Connect Slack" });
    expect((await adminProbe.dom('[data-testid="slack-custom-app-disclosure"][open]')).elements).toHaveLength(0);
    await admin.click({ testId: "slack-custom-app-disclosure" });
    await admin.see({ text: "Slack (custom app)" });
    await admin.see({ role: "link", text: "Set up your app" });
    await admin.screenshot();
    await member.navigate(denUrl("/dashboard/library/connectors/new"));
    await member.see({ testId: "connector-picker-slack-search" });
    await member.see({ testId: "connect-slack-search" }, { text: "Connect Slack" });
    expect((await memberProbe.dom('[data-testid="slack-custom-app-disclosure"][open]')).elements).toHaveLength(0);
    await member.notSee({ text: /^Client ID$/i });
    await member.notSee({ text: /^Client secret$/i });
    expect(await world.connection("first")).toMatchObject({ connectedForMe: false });
    evidence.recordAssertionEvidence("Managed Slack is discoverable without configuring a custom app", "Dashboard keeps Activity and offers Slack search alongside it; both catalogs show the same personal Connect Slack action. The admin's custom-app option opens only on request; the member catalog asks for no developer credentials. No member is connected by these page visits.", true);
    await member.screenshot();
  });

  await step("the member authorizes their own read-only Slack identity from the catalog", async () => {
    await member.click({ testId: "connect-slack-search" });
    const consent = user.on(await world.oauthSurface(world.memberWeb));
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.screenshot();
    await consent.click({ role: "button", text: "Authorize member one" });
    const connected = await probe.eventually(() => world.connection("first"), {
      within: 60_000, label: "the first member's own Slack identity is connected", until: value => value?.connectedForMe === true,
    });
    expect(JSON.stringify(connected)).toContain("TSYNTHETIC");
    expect(JSON.stringify(connected)).toContain("USYNTHFIRST");
    const authorization = world.slack.authorizations().at(-1);
    if (!authorization) throw new Error("Missing the member's Slack authorization request");
    expect(authorization).toMatchObject({ statePresent: true, botScopes: [], redirectUri: denUrl("/oauth/slack/callback") });
    expect(new URL(world.slack.origin).hostname).not.toBe(new URL(authorization.redirectUri).hostname);
    expect(authorization.scopes).toEqual(expect.arrayContaining(["search:read.public", "search:read.private", "search:read.im", "search:read.mpim"]));
    expect(authorization.scopes.some(scope => /write|files/.test(scope))).toBe(false);
    const identity = world.slack.calls().find(call => call.path === "/api/auth.test");
    expect(identity).toMatchObject({ member: "first", workspace: "TSYNTHETIC", error: null });
    expect(await world.connection("second")).toMatchObject({ connectedForMe: false });
    await member.see({ testId: "connect-slack-search" }, { text: "Manage account", timeoutMs: 30_000 });
    await member.click({ testId: "connect-slack-search" });
    await member.see({ testId: "slack-search-account" });
    await member.see({ testId: "disconnect-slack-search" });
    await member.screenshot();
    await member.navigate(world.connectionsUrl);
    await reloadApp(firstApp);
    await user.see("composer", { editable: true });
    await openConnections(firstApp);
    await probe.eventually(async () => (await probe.dom('button[aria-label="Connect Slack"]')).elements.length, {
      within: 60_000, label: "the connection menu observes the completed authorization", until: count => count === 0,
    });
    await user.notSee({ role: "button", label: "Connect Slack" });
    evidence.recordAssertionEvidence("Own-member OAuth does not connect another member", "Slack received state and comma-separated read-only user scopes; auth.test used the nested user token for the first identity. The second member remains disconnected.", true);
    await user.screenshot();
    await closeConnections(user, probe);
  });

  await step("after: a natural request returns public, private and direct-message sources with bounded thread context", async () => {
    for (const conversation of world.slack.conversations) expect(world.prompt.first).not.toContain(conversation.id);
    expect(world.prompt.first).not.toContain("native:");
    await preparePrompt(firstApp, world.prompt.first, "First member");
    await user.click("Run task");
    for (const conversation of world.slack.conversations) await user.see({ text: conversation.text }, { timeoutMs: 90_000 });
    await user.see({ text: "Incomplete thread context: this is a bounded excerpt, not the complete thread." });
    await user.see("Run task");
    const links = await probe.dom('a[href^="https://synthetic.slack.com/archives/"]');
    expect(links.elements.length).toBeGreaterThanOrEqual(4);
    const search = world.slack.calls().filter(call => call.path === "/api/assistant.search.context" && call.member === "first");
    expect(search).toHaveLength(1);
    expect(search[0].returnedChannels.sort()).toEqual(world.slack.conversations.map(entry => entry.id).sort());
    const threads = world.slack.calls().filter(call => call.path === "/api/conversations.replies");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ member: "first", returnedMessages: 2, error: null });
    expect(threads[0].parameters.cursor).toBeUndefined();
    expect(world.model.failures()).toEqual([]);
    const answer = world.model.outputs().find(entry => entry.prompt === world.prompt.first);
    expect(answer).toBeDefined();
    expect(world.incomplete(answer?.result)).toBe(true);
    const excerpt = world.objects(answer?.result).find(entry => entry.context === "thread_excerpt");
    expect(excerpt).toMatchObject({ partial: true, hasMore: true, nextCursor: "synthetic-thread-next" });
    expect(excerpt?.messages).toHaveLength(2);
    if (world.engine === "v2") {
      // A newly created split-pane conversation can retain the session-home URL.
      // Read actual native session IDs and find this unique prompt in persisted
      // native history instead of inventing a session ID from that URL.
      const mount = `/workspace/${encodeURIComponent(world.workspaceId)}/opencode2/api`;
      const listed = await world.appRequest("first", `${mount}/session`);
      expect(listed.status).toBe(200);
      const candidates = world.objects(listed.body).filter(entry => typeof entry.id === "string").slice(0, 10);
      let witnessed = false;
      for (const candidate of candidates) {
        if (typeof candidate.id !== "string") continue;
        const nativeHistory = await world.appRequest("first", `${mount}/session/${encodeURIComponent(candidate.id)}/message`);
        if (nativeHistory.status !== 200 || !JSON.stringify(nativeHistory.body).includes(world.prompt.first)) continue;
        expect(JSON.stringify(nativeHistory.body)).toContain(world.slack.conversations[0].text);
        witnessed = true;
        break;
      }
      expect(witnessed).toBe(true);
    }
    const catalog = await world.mcp("first", "search_capabilities", { query: "slack", type: "api", limit: 20 });
    const match = world.objects(catalog.body).find(entry => typeof entry.name === "string" && entry.name.startsWith("native:") && /slacksearch$/i.test(entry.name));
    if (!match || typeof match.name !== "string") throw new Error("The real catalog omitted the retained Slack search capability");
    expect(match).toMatchObject({ method: "GET", path: "/v1/capabilities/slack/search" });
    retainedSearchName = match.name;
    evidence.recordAssertionEvidence("Four conversation categories and an incomplete excerpt came from live synthetic HTTP responses", "One RTS request returned four member-visible categories. One replies request returned two of 105 fixture messages; four clickable source links and the real incomplete-context flag reached the answer. The prompt supplied no connection or channel IDs. Inference and Slack are synthetic; app, engine and Connect are real.", true);
    await user.screenshot();
  });

  await step("a read-only client can search Slack without receiving permission to write", async () => {
    await user.see("composer", { editable: true });
    const before = world.slack.calls().length;
    const result = await world.mcp("first", "execute_capability", { name: retainedSearchName, query: { query: "Amber launch", limit: 4 } });
    expect(result.status).toBe(200);
    expect(result.body).not.toMatchObject({ isError: true });
    expect(world.objects(result.body).find(entry => entry.context === "search_results")).toMatchObject({ ok: true, partial: true });
    const additional = world.slack.calls().slice(before);
    expect(additional).toHaveLength(1);
    expect(additional[0]).toMatchObject({ method: "POST", path: "/api/assistant.search.context", member: "first", error: null });
    evidence.recordAssertionEvidence("Native search remains usable with read-only gateway authority", "The token mint returned exactly mcp:read. Executing the discovered GET search capability succeeded and caused one internal Slack RTS POST; no mcp:write or Slack write scope was granted.", true);
  });

  await step("another Slack workspace connects automatically and cannot read the first workspace", async () => {
    await second.see("composer", { editable: true });
    await openConnections(secondApp);
    await second.click({ role: "button", label: "Connect Slack" });
    const consent = user.on(await world.oauthSurface(world.secondApp));
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.screenshot();
    await consent.click({ role: "button", text: "Authorize another workspace" });
    await consent.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    const connected = await world.connection("second");
    expect(connected).toMatchObject({ connectedForMe: true });
    expect(JSON.stringify(connected)).toContain(world.slack.otherWorkspace);
    const found = await world.memberRequest("second", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(found.status).toBe(200);
    expect(found.text).toContain(world.slack.otherConversations[0].text);
    const denied = await world.memberRequest("second", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}`);
    expect(denied).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(denied.text).not.toContain(privateConversation.text);
    expect(world.slack.calls().findLast(call => call.path === "/api/conversations.replies")).toMatchObject({ workspace: world.slack.otherWorkspace, error: "channel_not_found" });
    evidence.recordAssertionEvidence("A second Slack workspace connects without environment changes and retains its own access boundary", "OAuth and auth.test identified another workspace automatically. Its search returned that workspace's fixtures; a guessed thread from the original workspace returned not_found using the second workspace's token.", true);
    await consent.screenshot();
  });

  await step("the second member connects a separate Slack identity with the same read permissions", async () => {
    // Explicit reauthorization replaces the one member-owned workspace slot.
    await second.navigate(await world.startAuthorization("second"));
    const consent = second;
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.click({ role: "button", text: "Authorize member two" });
    await consent.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    const connected = await probe.eventually(() => world.connection("second"), {
      within: 60_000, label: "the second member's replacement Slack identity connects", until: value => value?.externalAccountId === "slack:TSYNTHETIC:USYNTHSECOND",
    });
    expect(JSON.stringify(connected)).toContain("USYNTHSECOND");
    const firstIdentity = world.slack.calls().find(call => call.path === "/api/auth.test" && call.member === "first" && call.workspace === "TSYNTHETIC");
    const secondIdentity = world.slack.calls().find(call => call.path === "/api/auth.test" && call.member === "second");
    expect(secondIdentity?.tokenId).toBeTruthy();
    expect(secondIdentity?.tokenId).not.toBe(firstIdentity?.tokenId);
    await navigateToApp(secondApp);
    await second.see("composer", { editable: true });
    evidence.recordAssertionEvidence("Each member authorizes a distinct user token", "Both accounts completed the same read-only OAuth request, but auth.test observed different user-token fingerprints and different Slack user IDs in the same synthetic workspace.", true);
    await second.screenshot();
  });

  await step("the second member cannot search or directly read the first member's private conversation", async () => {
    await preparePrompt(secondApp, world.prompt.second, "Second member");
    await second.click("Run task");
    const publicConversation = world.slack.conversations.find(entry => entry.type === "public_channel");
    if (!publicConversation) throw new Error("Missing public fixture");
    await second.see({ text: publicConversation.text }, { timeoutMs: 90_000 });
    await second.see("Run task");
    for (const conversation of world.slack.conversations.filter(entry => entry.type !== "public_channel")) {
      await second.notSee({ text: conversation.text });
    }
    const search = world.slack.calls().filter(call => call.path === "/api/assistant.search.context" && call.member === "second");
    expect(search).toHaveLength(1);
    expect(search[0].returnedChannels).toEqual([publicConversation.id]);
    expect(JSON.stringify(search[0].parameters.channel_types)).toContain("private_channel");
    const denied = await world.memberRequest("second", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}&limit=2`);
    expect(denied).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(denied.text).not.toContain(privateConversation.text);
    expect(world.slack.calls().findLast(call => call.path === "/api/conversations.replies")).toMatchObject({ member: "second", error: "channel_not_found", returnedMessages: 0 });
    expect((await secondProbe.text()).includes(privateConversation.text)).toBe(false);
    evidence.recordAssertionEvidence("Private access follows Slack membership, not the shared OpenWork organization", `The second user's fully scoped search returned only the public channel. A guessed private thread request returned HTTP ${denied.status}; the provider observed the second token and rejected it with channel_not_found. No private text reached that member's answer.`, true);
    await second.screenshot();
  });

  await step("after: declining optional permissions leaves useful public access and names what was not searched", async () => {
    // The public OAuth start endpoint is the real reconnection boundary. Follow
    // its returned link; no token, scope or connection row is injected by seed.
    await user.navigate(await world.startAuthorization("first"));
    await user.see({ text: "Synthetic Slack consent" });
    await user.click({ role: "button", text: "Authorize public access only" });
    await user.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    await navigateToApp(firstApp);
    await user.see("composer", { editable: true });
    await preparePrompt(firstApp, world.prompt.partial, "First member with partial consent");
    await user.click("Run task");
    await user.see({ text: "Limited access: private channels and direct messages were not searched, not reported as empty." }, { timeoutMs: 90_000 });
    await user.see("Run task");
    const search = world.slack.calls().findLast(call => call.path === "/api/assistant.search.context" && call.member === "first");
    expect(search).toMatchObject({ error: null });
    expect(JSON.stringify(search?.parameters.channel_types)).not.toMatch(/private_channel|mpim|\bim\b/);
    expect(search?.returnedChannels).toEqual(["CSYNTHPUBLIC"]);
    const answer = world.model.outputs().find(entry => entry.prompt === world.prompt.partial);
    expect(world.limited(answer?.result)).toBe(true);
    expect(world.objects(answer?.result).find(entry => entry.context === "search_results")).toMatchObject({
      searchedConversationTypes: ["public_channel"], omittedConversationTypes: ["private_channel", "im", "mpim"],
    });
    expect(answer?.text).not.toContain(privateConversation.text);
    expect(await world.connection("first")).toMatchObject({ connectedForMe: true });
    const beforeDenied = world.slack.calls().length;
    const missing = await world.memberRequest("first", "/v1/capabilities/slack/search?query=Amber%20launch&conversationTypes=private_channel");
    expect(missing).toMatchObject({ status: 409, body: { error: "missing_permission" } });
    expect(world.slack.calls()).toHaveLength(beforeDenied);
    evidence.recordAssertionEvidence("Partial consent stays connected and does not mislabel unsearched categories as empty", "The replacement member grant contains public search/history only. The provider received only public channel types and returned useful content; native omitted-category metadata reached the answer. Explicitly requesting private search returned missing_permission (409) without a provider call.", true);
    await user.screenshot();
  });

  await step("the connection itself shows limited access without exposing internal account identifiers", async () => {
    await user.click("Library");
    await user.see({ text: "Connected with limited access" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "slack:TSYNTHETIC:USYNTHFIRST" });
    const connection = await world.connection("first");
    expect(connection).toMatchObject({ connected: true, connectedForMe: true, needsReconnect: false });
    expect(connection?.policyBlocked).not.toBe(true);
    expect(connection?.policyOwner).toBeUndefined();
    expect(connection?.missingFeatures).toEqual(expect.arrayContaining(["privateChannels", "directMessages", "groupMessages"]));
    evidence.recordAssertionEvidence("Limited access is product state, not just model prose", "The Library says Connected with limited access while the native account remains connected and does not require reconnect. Optional private/DM feature omissions are retained; the encoded workspace/user identifier is not displayed.", true);
    await user.screenshot();
    await navigateToApp(firstApp);
  });

  await step("the platform admin separately enables Slack search for the other organization", async () => {
    await toggleOrganization(world.otherOrganizationId, world.otherOrganizationSlug, true);
    await expectFeature(world.organizationId, true, true, "override");
    expect(await world.connection("other")).toMatchObject({ connectedForMe: false });
    await otherOwner.reload();
    await otherOwner.see({ testId: "connect-my-mcp-account-slack" });
    evidence.recordAssertionEvidence("The second rollout is an explicit admin action", "The same generated checkbox saved B=true. B now offers Connect but has no authorized account; A's member-owned grant is not inherited.", true);
    await admin.screenshot();
    await otherOwner.screenshot();
  });

  await step("Slack search does not enable an assistant or accept organization app credentials", async () => {
    await otherOwner.see({ testId: "connect-my-mcp-account-slack" });
    expect((await world.organizationFeatures(world.otherOrganizationId)).capabilities).toMatchObject({
      nativeSlack: true, slackAssistant: false, slackWorkbotReplies: false,
    });
    const before = world.slack.calls().length;
    const custom = await world.memberRequest("other", "/v1/oauth-providers/slack/client", "POST", {
      clientId: "synthetic-rejected-custom-client", clientSecret: "synthetic-rejected-not-a-credential",
    });
    expect(custom).toMatchObject({ status: 403, body: { error: "forbidden", message: "Slack search uses the OpenWork-provided app. Organization app configuration is not supported." } });
    expect(world.slack.calls()).toHaveLength(before);
    evidence.recordAssertionEvidence("Search availability does not enable adjacent Slack products", "B's Slack search is true while both Slack Assistant flags are false. Its ordinary owner cannot save a custom Slack OAuth app (403, OpenWork-provided app required); 0 provider calls.", true);
    await otherOwner.screenshot();
  });

  await step("the newly enabled organization must still authorize its own Slack account", async () => {
    await user.see("composer", { editable: true });
    const authenticated = await world.memberRequest("other", "/v1/org");
    expect(authenticated).toMatchObject({ status: 200, body: { organization: { id: world.otherOrganizationId } } });
    const before = world.slack.calls().length;
    const responses = [];
    for (const path of ["/v1/mcp-connections/slack/connect/start", "/v1/oauth-providers/slack/connect/start"]) {
      responses.push(await world.memberRequest("other", path));
    }
    responses.push(await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch"));
    responses.push(await world.memberRequest("other", `/v1/capabilities/slack/threads?channelId=${privateConversation.id}&ts=${privateConversation.ts}`));
    expect(responses.slice(0, 2).every(response => response.status === 200)).toBe(true);
    expect(responses.slice(2).every(response => response.status === 409)).toBe(true);
    const retained = await world.mcp("other", "execute_capability", { name: retainedSearchName, query: { query: "Amber launch" } });
    expect(retained.status).toBe(200);
    expect(world.objects(retained.body).some(entry => entry.error === "needs_connection")).toBe(true);
    expect(world.slack.calls()).toHaveLength(before);
    await otherOwner.navigate(denUrl("/dashboard"));
    await otherOwner.see({ testId: "dashboard-activity" });
    await otherOwner.see({ testId: "dashboard-managed-slack" });
    await otherOwner.see({ testId: "connect-slack-search" }, { text: "Connect Slack" });
    await otherOwner.click({ testId: "connect-slack-search" });
    const consent = user.on(await world.oauthSurface(world.otherWeb));
    await consent.see({ text: "Synthetic Slack consent" });
    await consent.click({ role: "button", text: "Authorize another workspace" });
    await consent.see({ role: "heading", text: "You're connected" }, { timeoutMs: 30_000 });
    expect(await world.connection("other")).toMatchObject({ connectedForMe: true });
    await otherOwner.see({ testId: "connect-slack-search" }, { text: "Manage account", timeoutMs: 30_000 });
    await rememberAccount("other");
    const ownSearch = await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(ownSearch.status).toBe(200);
    expect(ownSearch.text).toContain(world.slack.otherConversations[0].text);
    expect(JSON.stringify(await world.connection("first"))).toContain("TSYNTHETIC");
    evidence.recordAssertionEvidence("Availability never substitutes for member consent", "After B's explicit rollout, both start aliases returned 200 but search/threads returned 409 and retained execution required a connection. B's owner used Dashboard's Connect Slack action to authorize their own workspace in their independently signed-in browser; the row became Manage account and search succeeded without sharing A's grant.", true);
    await otherOwner.screenshot();
    await otherOwner.navigate(world.connectionsUrl);
  });

  await step("turning off the first organization blocks retained grants while the second keeps working", async () => {
    await rememberAccount("first");
    await toggleOrganization(world.organizationId, world.organizationSlug, false);
    await expectFeature(world.otherOrganizationId, true, true, "override");
    const authenticated = await world.memberRequest("first", "/v1/org");
    expect(authenticated).toMatchObject({ status: 200, body: { organization: { id: world.organizationId } } });
    const statuses = await expectBlocked("first");
    expect(await world.connection("first")).toMatchObject({
      policyBlocked: true, policyOwner: "openwork", connected: false, connectedForMe: true, needsReconnect: false,
    });
    const before = world.slack.calls().length;
    const otherSearch = await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(otherSearch.status).toBe(200);
    expect(otherSearch.text).toContain(world.slack.otherConversations[0].text);
    expect(world.slack.calls().slice(before)).toEqual([expect.objectContaining({ path: "/api/assistant.search.context", workspace: world.slack.otherWorkspace, error: null })]);
    evidence.recordAssertionEvidence("A live organization override blocks the next requests, not just discovery", `A=false rejected start/status/search/threads (${statuses.join(" / ")}) and its retained MCP capability with 0 provider calls. Its stored account is blocked by OpenWork, not disconnected. B=true still searched its own workspace (200; 1 provider call).`, true);
    await admin.screenshot();
  });

  await step("the blocked account remains visible without asking the member to reconnect", async () => {
    await member.reload();
    await member.see({ role: "heading", text: "Your Connections" });
    await member.see({ text: /^Blocked$/ });
    await member.see({ testId: "disconnect-my-mcp-account-slack" });
    await member.notSee({ testId: "connect-my-mcp-account-slack" });
    const account = await world.connection("first");
    expect(account).toMatchObject({ policyBlocked: true, policyOwner: "openwork", connectedForMe: true, needsReconnect: false });
    expect(account?.connectedAt).toBe(retainedAccounts.get("first")?.connectedAt);
    evidence.recordAssertionEvidence("Blocking does not erase the account", "The first member sees Blocked and Disconnect, not a Connect/Reconnect action. The saved account's connectedAt marker is unchanged, with connectedForMe=true, policyOwner=openwork and needsReconnect=false. The blocked summary does not need to disclose its internal Slack identity.", true);
    await member.screenshot();
  });

  await step("enabling Slack for everyone still respects the first organization's explicit off setting", async () => {
    await setEveryone(true);
    await expectFeature(world.organizationId, false, false, "override");
    await expectFeature(world.otherOrganizationId, true, true, "override");
    await expectBlocked("first");
    evidence.recordAssertionEvidence("Everyone is a default, not a forced grant", "The shared everyone control is On, but A's explicit false override stays effective and its retained search remains policy_blocked. B's explicit true override remains enabled.", true);
    await admin.screenshot();
  });

  await step("using everyone's setting removes the override and restores the existing account", async () => {
    await openOrganization(world.organizationSlug);
    await admin.click({ testId: "admin-capability-reset-nativeSlack" });
    await expectFeature(world.organizationId, true, null, "everyone");
    await admin.see({ testId: "admin-capability-source-nativeSlack" }, { text: "On for everyone" });
    expect((await adminProbe.dom('[data-testid="admin-capability-nativeSlack"]:checked')).elements).toHaveLength(1);
    expect(await world.connection("first")).toMatchObject({ connected: true, connectedForMe: true, needsReconnect: false });
    const before = world.slack.calls().length;
    const result = await world.mcp("first", "execute_capability", { name: retainedSearchName, query: { query: "Amber launch" } });
    expect(result.status).toBe(200);
    expect(result.body).not.toMatchObject({ isError: true });
    expect(world.slack.calls().slice(before)).toEqual([expect.objectContaining({ path: "/api/assistant.search.context", member: "first", workspace: "TSYNTHETIC", error: null })]);
    evidence.recordAssertionEvidence("Null means inherit rather than false", "Use everyone's setting saved override=null; A now inherits On. Its retained read-only MCP token searches with the existing account (1 RTS request, 0 OAuth exchanges).", true);
    await admin.screenshot();
  });

  await step("turning everyone's default off leaves the explicitly enabled organization available", async () => {
    await setEveryone(false);
    await expectFeature(world.organizationId, false, null, "everyone");
    await expectFeature(world.otherOrganizationId, true, true, "override");
    await expectBlocked("first");
    const otherSearch = await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(otherSearch.status).toBe(200);
    expect(otherSearch.text).toContain(world.slack.otherConversations[0].text);
    evidence.recordAssertionEvidence("Default-off and an explicit organization grant are different", "Everyone=Off disables inheriting A without removing its account; explicitly enabled B still returns its own workspace results (200). This is not the global kill switch.", true);
    await admin.screenshot();
  });

  await step("the platform admin restores an explicit grant before testing the emergency stop", async () => {
    await toggleOrganization(world.organizationId, world.organizationSlug, true);
    await expectFeature(world.otherOrganizationId, true, true, "override");
    expect(await world.connection("first")).toMatchObject({ connected: true, connectedForMe: true });
    expect(await world.connection("other")).toMatchObject({ connected: true, connectedForMe: true });
    evidence.recordAssertionEvidence("Both organizations have real retained grants before the kill", "A=true and B=true both override the Off default; both stored accounts are usable without new authorization. This witnesses the explicit grants the kill must override.", true);
    await admin.screenshot();
  });

  await step("turning Slack off everywhere overrides both explicit grants without erasing either account", async () => {
    await navigateAdmin(world.featuresUrl);
    await admin.see({ testId: "admin-feature-kill-nativeSlack" });
    await Promise.all([world.confirmAdminKill(), admin.click({ testId: "admin-feature-kill-nativeSlack" })]);
    await admin.see({ testId: "admin-feature-state-nativeSlack" }, { text: "Turned off everywhere" });
    expect(await world.globalSlackFeature()).toMatchObject({ enabled: false, killed: true });
    await expectFeature(world.organizationId, false, true, "killed");
    await expectFeature(world.otherOrganizationId, false, true, "killed");
    const before = world.slack.calls().length;
    await expectBlocked("first");
    await expectBlocked("other");
    expect(await world.connection("first")).toMatchObject({ connectedAt: retainedAccounts.get("first")?.connectedAt, policyBlocked: true, policyOwner: "openwork", connectedForMe: true, needsReconnect: false });
    expect(await world.connection("other")).toMatchObject({ connectedAt: retainedAccounts.get("other")?.connectedAt, policyBlocked: true, policyOwner: "openwork", connectedForMe: true, needsReconnect: false });
    expect(world.slack.calls()).toHaveLength(before);
    evidence.recordAssertionEvidence("The global kill outranks both true overrides", "Both organizations resolve source=killed while retaining override=true, connectedForMe=true and their original connectedAt markers. Subsequent starts/status/search/threads and retained MCP execution are blocked for both, with 0 provider calls. Identity is rechecked after restore; no claim is made about already in-flight requests.", true);
    await admin.screenshot();
  });

  await step("restoring the feature resumes both saved accounts without another consent flow", async () => {
    await admin.click({ testId: "admin-feature-restore-nativeSlack" });
    await admin.see({ testId: "admin-feature-state-nativeSlack" }, { text: "Off · organization overrides only" });
    await expectFeature(world.organizationId, true, true, "override");
    await expectFeature(world.otherOrganizationId, true, true, "override");
    const restoredIdentities: Array<"first" | "other"> = ["first", "other"];
    for (const identity of restoredIdentities) {
      expect(await world.connection(identity)).toMatchObject({
        connectedAt: retainedAccounts.get(identity)?.connectedAt,
        externalAccountId: retainedAccounts.get(identity)?.externalAccountId,
      });
    }
    const before = world.slack.calls().length;
    const firstSearch = await world.memberRequest("first", "/v1/capabilities/slack/search?query=Amber%20launch");
    const otherSearch = await world.memberRequest("other", "/v1/capabilities/slack/search?query=Amber%20launch");
    expect(firstSearch.status).toBe(200);
    expect(otherSearch.status).toBe(200);
    expect(firstSearch.text).toContain(world.slack.conversations[0].text);
    expect(firstSearch.text).not.toContain(world.slack.otherConversations[0].text);
    expect(otherSearch.text).toContain(world.slack.otherConversations[0].text);
    const calls = world.slack.calls().slice(before);
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.path === "/api/assistant.search.context" && call.error === null)).toBe(true);
    expect(calls.map(call => call.workspace)).toEqual(["TSYNTHETIC", world.slack.otherWorkspace]);
    evidence.recordAssertionEvidence("Restore preserves account and organization boundaries", "The Off default remains, both true overrides resume, and the two existing accounts return their own workspace results (200 / 200; 2 RTS requests, 0 OAuth exchanges).", true);
    await admin.screenshot();
  });

  await step("a member can disconnect their blocked account without affecting the other organization", async () => {
    await toggleOrganization(world.organizationId, world.organizationSlug, false);
    await member.reload();
    await member.see({ text: /^Blocked$/ });
    await member.see({ testId: "disconnect-my-mcp-account-slack" });
    await member.notSee({ testId: "connect-my-mcp-account-slack" });
    const before = world.slack.calls().length;
    await member.click({ testId: "disconnect-my-mcp-account-slack" });
    await probe.eventually(() => world.connection("first"), {
      within: 30_000, label: "the member removed their blocked Slack account", until: value => value === undefined,
    });
    await memberProbe.eventually(() => memberProbe.dom('[data-testid="disconnect-my-mcp-account-slack"]'), {
      within: 30_000, label: "the account list reflects the completed disconnect",
      until: value => value.elements.length === 0,
    });
    await member.notSee({ testId: "disconnect-my-mcp-account-slack" });
    expect(world.slack.calls()).toHaveLength(before);
    expect(await world.connection("other")).toMatchObject({ connected: true, connectedForMe: true });
    expect(world.model.failures()).toEqual([]);
    const allowedMethods = ["/api/oauth.v2.access", "/api/auth.test", "/api/assistant.search.context", "/api/conversations.replies", "/api/chat.getPermalink"];
    expect(world.slack.calls().every(call => allowedMethods.includes(call.path))).toBe(true);
    expect(world.slack.calls().every(call => call.error === null || call.error === "channel_not_found")).toBe(true);
    evidence.recordAssertionEvidence("Blocked accounts remain removable by their owner", "A's member clicked Disconnect while Slack was blocked; their account disappeared with 0 provider calls. B's account remains connected. Every witnessed provider method was read/OAuth-only and the deterministic model reported 0 failures.", true);
    await member.screenshot();
  });
});
