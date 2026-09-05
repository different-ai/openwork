import { expect } from "vitest";
import { saveWorkflow, runWorkflow } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { creationPrompt, creationReply, field, record, savedAppCreation } from "../worlds/saved-apps.ts";

const test = spec.world(savedAppCreation, { timeout: 900_000 });

test("create, preview, save and reopen an app without changing already-open results", async ({ world, user, probe, seed, step, evidence }) => {
  const viewsPath = `/v1/workflows/${world.configObjectId}/views`;
  expect(record((await probe.api(world.den.admin, viewsPath)).body).items).toEqual([]);
  await step("only offer sharing when the server supports it", async () => {
    for (const body of [{ enabled: true, items: [] }, { enabled: true, sharingEnabled: false, items: [] }]) {
      await world.proxy.faults.status("/v1/apps", 200, { times: 100, body });
      await world.proxy.faults.status("/api/den/v1/apps", 200, { times: 100, body });
      await world.open("/dashboard");
      await user.reload();
      await user.see({ role: "button", label: "Add" });
      expect((await world.proxy.requestLog()).some((request) => request.path.endsWith("/v1/apps") && request.faulted)).toBe(true);
      await user.notSee({ role: "button", label: "Share" });
      await world.resetProxy();
    }
    await user.reload();
    await user.see({ role: "button", label: "Share" });
    expect(record((await probe.api(world.den.admin, "/v1/apps")).body).sharingEnabled).toBe(true);
  });
  evidence.recordAssertionEvidence("Sharing requires explicit server support", "Older and disabled capability responses keep Add available but hide Share; the real supporting server exposes Share after reload.", true);
  await step("create an app through the Dashboard conversation", async () => {
    await world.open("/dashboard");
    await user.click({ role: "button", label: "Add" });
    await user.click("Create with OpenWork");
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "app creation prompt", until: (composer) => JSON.stringify(composer).includes("Create a reusable app for my dashboard that") });
    expect(creationPrompt).not.toContain(world.configObjectId);
    await user.type("composer", creationPrompt, { replace: true });
    await user.click("Run task");
    try {
      await user.see({ text: creationReply }, { timeoutMs: 90_000 });
      await user.see("Save", { timeoutMs: 60_000 });
    } finally {
      await user.screenshot();
    }
    await probe.eventually(() => world.previewText(), { within: 30_000, label: "conversation generated the app preview", until: (text) => text.includes("Weekly overview") && text.includes("Launch briefing") });
    await user.screenshot();
  });
  const drafts = record((await probe.api(world.den.admin, viewsPath)).body).items;
  if (!Array.isArray(drafts) || drafts.length !== 1) throw new Error("The conversation must create exactly one draft.");
  const view = record(drafts[0]);
  const appId = field(view, "id");
  if (!Array.isArray(view.revisions) || !view.revisions[0]) throw new Error("The conversation draft has no revision.");
  const revisionId = field(view.revisions[0], "id");
  const requests = await world.den.mocks.tracker.agentRequests({ promptMarker: creationPrompt });
  expect(requests.some((request) => request.toolName?.endsWith("save_artifact_view"))).toBe(true);
  expect(requests.filter((request) => request.kind === "tool")).toHaveLength(1);
  evidence.recordAssertionEvidence("A submitted Dashboard creation request builds a new app draft and opens its preview", "There were no app drafts before submission. The real conversation called the MCP builder once, persisted one revision, and rendered the receipt-pinned workflow data in the artifact panel without needing a newly registered tool.", true);
  const appPath = `/apps/${appId}`;
  const dashboardAppPath = `/dashboard/apps/${appId}`;
  const originalPath = `${appPath}?revisionId=${revisionId}&receiptId=${world.receiptId}`;
  const readApp = async (path = appPath) => {
    const response = await probe.api(world.den.admin, `/v1${path}`);
    expect(response.response.status, response.text).toBe(200);
    return record(response.body);
  };
  const before = await probe.api(world.den.admin, "/v1/apps");
  expect(record(before.body).items).toEqual([]);
  expect(record((await readApp(originalPath)).view).activeRevisionId).toBeNull();
  expect(record(await world.render())["_meta"]).not.toHaveProperty("openwork/mcpApp");

  await step("try a draft and cancel saving", async () => {
    await user.see("Save", { timeoutMs: 60_000 });
    await user.see({ text: "App draft" });
    try {
      const preview = await probe.eventually(() => world.previewText(), { within: 30_000, label: "generated preview rendered", until: (text) => text.includes("Weekly overview") && text.includes("Launch briefing") });
      expect(preview).not.toContain("could not render");
      await world.showDetails();
      await probe.eventually(() => world.previewText(), { within: 10_000, label: "preview interaction", until: (text) => text.includes("Hide details") && text.includes("Workers:") });
    } finally {
      await user.screenshot();
    }
    await user.click("Save");
    await user.see({ text: "Save to your dashboard" });
    await user.see({ label: "App name" }, { value: "Briefing app" });
    await user.screenshot();
    await user.click("Cancel");
    expect(record((await readApp(originalPath)).view).activeRevisionId).toBeNull();
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("The generated app renders workflow data and supports preview interactions", "The sandbox displayed Weekly overview and Launch briefing, and Show details revealed the worker count before saving.", true);

  const readWorkflow = async () => {
    const response = await probe.api(world.den.admin, `/v1/workflows/${world.configObjectId}`);
    expect(response.response.status, response.text).toBe(200);
    return record(record(response.body).script);
  };
  const workflowBefore = await readWorkflow();
  const snapshotsBefore = (await probe.api(world.den.admin, `/v1/workflows/${world.configObjectId}/snapshots`)).body;
  const draftPlacement = await seed.api(world.den.admin, `/v1/apps/${appId}/dashboard`, {
    method: "POST", body: JSON.stringify({ added: true }),
  });
  expect(draftPlacement.response.status).toBe(404);
  expect((await readApp(originalPath)).onDashboard).toBe(false);

  await step("save the workflow and app to the dashboard", async () => {
    await user.click("Save");
    await user.type({ label: "App name" }, "Team briefing", { replace: true });
    await user.click({ role: "button", label: "Save", nth: 1 });
    await user.see({ text: "Saved to your dashboard. The workflow and app are ready to use together." }, { timeoutMs: 30_000 });
    const saved = record((await readApp()).view);
    expect(saved).toMatchObject({ title: "Team briefing", activeRevisionId: revisionId, useInWorkflow: true });
    expect(record((await world.render())._meta).viewRevisionId).toBe(revisionId);
    const listed = record((await probe.api(world.den.admin, "/v1/apps")).body);
    expect(listed.items).toHaveLength(1);
    expect(await readApp()).toMatchObject({ onDashboard: true, view: { configObjectId: world.configObjectId } });
    const workflowAfter = await readWorkflow();
    expect(record(workflowAfter.currentVersion).id).toBe(record(workflowBefore.currentVersion).id);
    expect(record(workflowAfter.currentVersion).automationReferences).toEqual([]);
    expect((await probe.api(world.den.admin, `/v1/workflows/${world.configObjectId}/snapshots`)).body).toEqual(snapshotsBefore);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Drafts stay off the dashboard until saved, and Cancel does not save them", "Draft list was empty; Cancel retained a null active revision; Save persisted the exact revision, workflow link, and personal dashboard placement without executing or scheduling a run.", true);

  await step("saved app header stays readable in a narrow preview", async () => {
    await seed.evalIn(world.app, `document.querySelector('[data-app-header]').parentElement.style.width = '320px'`);
    const header = await probe.eval(world.app, `(() => {
      const header = document.querySelector('[data-app-header]');
      const title = header.querySelector('h2');
      return { width: header.getBoundingClientRect().width, height: header.getBoundingClientRect().height,
        titleWidth: title.getBoundingClientRect().width, titleFits: title.scrollWidth <= title.clientWidth,
        buttonLabels: [...header.querySelectorAll('button')].map(button => button.textContent.trim()) };
    })()`);
    expect(record(header).width).toBe(320);
    expect(record(header).height).toBeLessThan(72);
    expect(record(header).titleWidth).toBeGreaterThan(180);
    expect(record(header).titleFits).toBe(true);
    expect(record(header).buttonLabels).not.toContain("Saved");
    expect(record(header).buttonLabels).not.toContain("Delete");
    await user.screenshot();
    await user.click("App options for Team briefing");
    await user.see("Delete Team briefing");
    await user.screenshot();
    await user.click("App options for Team briefing");
    await seed.evalIn(world.app, `document.querySelector('[data-app-header]').parentElement.style.removeProperty('width')`);
  });
  evidence.recordAssertionEvidence("The saved app header preserves the title at a 320px panel width", "The real preview header remains under 72px tall with over 180px for the fully visible title. Saved is status text and Delete remains reachable in the options menu.", true);

  await step("reopen the saved app after a reload", async () => {
    await world.open("/dashboard");
    await user.reload();
    await user.click("Open Team briefing");
    await user.see({ text: "Saved app" }, { timeoutMs: 30_000 });
    await user.click("App options for Team briefing");
    await user.see("Run again");
    await user.see("Ask for changes");
    await user.see("Delete Team briefing");
    await user.screenshot();
    await user.click("App options for Team briefing");
  });

  const companyBefore = (await probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)).body;
  await step("remove a personal card and add the saved app again", async () => {
    await world.open("/dashboard");
    await user.see({ text: "Project updates" });
    await user.see({ text: "From your company" });
    await user.click("App options for Team briefing");
    await user.click("Remove Team briefing from dashboard");
    await user.see({ text: "Make this dashboard yours" }, { timeoutMs: 30_000 });
    expect(await readApp()).toMatchObject({ onDashboard: false, view: { activeRevisionId: revisionId } });
    await user.click({ role: "button", label: "Add" });
    await user.see("Create with OpenWork");
    await user.click("Choose an existing app");
    await user.click("Add Team briefing");
    await probe.eventually(readApp, { within: 30_000, label: "personal dashboard placement restored", until: (app) => app.onDashboard === true });
    await user.screenshot();
    await world.open("/dashboard");
    await user.reload();
    await user.see("Open Team briefing", { timeoutMs: 30_000 });
    await probe.eventually(() => world.previewText(), { within: 30_000, label: "saved app rendered on dashboard", until: (text) => text.includes("Weekly overview") && text.includes("Launch briefing") });
    await user.see({ text: "Project updates" });
    expect((await probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)).body).toEqual(companyBefore);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Removing and adding an existing app changes dashboard placement without deleting the app", "Remove kept the saved revision and company dashboard; Choose an existing app added the personal card again and it survived reload beside Project updates.", true);

  // Keep an exact preview mounted while another client changes the saved app.
  await world.open(`/dashboard${originalPath}`);
  await probe.eventually(() => world.previewText(), { within: 30_000, label: "original preview mounted", until: (text) => text.includes("Weekly overview") && text.includes("Launch briefing") });
  await world.showDetails();
  const mountedText = await world.previewText();
  expect(mountedText).toContain("Hide details");
  expect(mountedText).toContain("Workers:");
  const newerRevision = await world.revise(appId);
  expect(record((await readApp()).view)).toMatchObject({ title: "Team briefing", activeRevisionId: revisionId });
  expect(record((await world.render())._meta).viewRevisionId).toBe(revisionId);
  await world.run("Next week’s briefing");
  expect(record(record((await readApp()).payload).data).topic).toBe("Next week’s briefing");
  const original = await readApp(originalPath);
  expect(record(record(original.payload).data).topic).toBe("Launch briefing");
  expect(field(original.revision, "id")).toBe(revisionId);

  const concurrentSave = await seed.api(world.den.admin, `/v1/apps/${appId}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: newerRevision, title: "Team briefing", useInWorkflow: true, expectedActiveRevisionId: revisionId }),
  });
  expect(concurrentSave.response.status, concurrentSave.text).toBe(200);
  expect((await readApp()).revision).toMatchObject({ id: newerRevision });
  expect(await world.previewText()).toBe(mountedText);
  await user.screenshot();
  // A refetch must also honor both pinned identifiers.
  await user.reload();
  const restoredText = await probe.eventually(() => world.previewText(), { within: 30_000, label: "pinned preview after reload", until: (text) => text.includes("Weekly overview") && text.includes("Launch briefing") });
  expect(restoredText).not.toContain("Updated overview");
  expect(restoredText).not.toContain("Next week’s briefing");
  evidence.recordAssertionEvidence("An already-open preview retains its version and receipt when another client saves changes", "The mounted preview retained its original heading, topic, expanded details and worker count after a new run and revision activation; reloading the pinned URL still rendered the original result.", true);
  const optOutRevision = await world.revise(appId);
  await step("save changes without automatic workflow use", async () => {
    await world.open(`${dashboardAppPath}?revisionId=${optOutRevision}`);
    await user.click("Save changes");
    await user.click({ role: "checkbox" });
    await user.click({ role: "button", label: "Save changes", nth: 1 });
    await user.see({ text: "Saved to your dashboard. Open it whenever you need it." }, { timeoutMs: 30_000 });
    expect(record((await readApp()).view)).toMatchObject({ activeRevisionId: optOutRevision, useInWorkflow: false });
    expect(record((await world.render())._meta)).not.toHaveProperty("openwork/mcpApp");
  });
  evidence.recordAssertionEvidence("Saving a new app version preserves original previews and respects workflow opt-out", "New data appeared only in the latest result, original revision and receipt remained fixed, and opting out removed automatic app selection.", true);

  const staleSave = await seed.api(world.den.admin, `/v1/apps/${appId}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: revisionId, title: "Stale overwrite", useInWorkflow: true, expectedActiveRevisionId: revisionId }),
  });
  expect(staleSave.response.status).toBe(409);
  expect(record((await readApp()).view).title).toBe("Team briefing");
  const colleague = world.den.members.colleague;
  if (!colleague) throw new Error("The second identity was not provisioned.");
  const denied = await probe.api(colleague, `/v1/apps/${appId}`);
  expect(denied.response.status).toBe(403);
  expect(denied.body).toMatchObject({ error: "forbidden", message: "Missing viewer access for config object." });
  expect(denied.text).not.toContain("Launch briefing");
  const colleagueList = await probe.api(colleague, "/v1/apps");
  expect(record(colleagueList.body).items).toEqual([]);
  const deniedAdd = await seed.api(colleague, `/v1/apps/${appId}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) });
  expect(deniedAdd.response.status).toBe(403);
  await seed.api(colleague, `/v1/apps/${appId}/dashboard`, { method: "POST", body: JSON.stringify({ added: false }) });
  expect((await readApp()).onDashboard).toBe(true);
  evidence.recordAssertionEvidence("Stale saves and members without workflow access cannot overwrite or read the saved app", "Stale activation returned 409 and kept the title; the ungranted colleague received 403 for missing workflow access without result content.", true);

  const deniedDelete = await seed.api(colleague, `/v1/artifact-views/${appId}/retire`, { method: "POST" });
  expect(deniedDelete.response.status).toBe(403);
  expect((await readApp()).onDashboard).toBe(true);

  await step("a regular member deletes their own saved app", async () => {
    const memberCode = 'return { topic: input.topic, total: 7 };';
    const memberInput = { topic: "Personal report" };
    await world.rpc("execute_capability_script", { code: memberCode, input: memberInput }, colleague);
    const memberSaved = await saveWorkflow(colleague, {
      name: "Personal report", code: memberCode, currentInput: memberInput,
      inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      outputSchema: { type: "object", properties: { topic: { type: "string" }, total: { type: "number" } }, required: ["topic", "total"] },
    });
    expect(memberSaved.status, memberSaved.text).toBe(201);
    const memberWorkflowId = field(memberSaved.body, "configObjectId");
    await runWorkflow(colleague, memberWorkflowId, {
      pluginId: field(memberSaved.body, "pluginId"), configObjectVersionId: field(memberSaved.body, "configObjectVersionId"), input: memberInput,
    });
    const memberBuilt = await world.rpc("save_artifact_view", {
      configObjectId: memberWorkflowId, title: "Personal report", reactSource: 'export default function Report({data}) { return <p>{data.topic}</p> }',
    }, colleague);
    const memberView = record(record(memberBuilt.structuredContent).view);
    const memberAppId = field(memberView, "id");
    if (!Array.isArray(memberView.revisions)) throw new Error("Member app has no revisions");
    const memberRevisionId = field(memberView.revisions[0], "id");
    const memberSave = await seed.api(colleague, `/v1/apps/${memberAppId}/save`, {
      method: "POST", body: JSON.stringify({ revisionId: memberRevisionId, title: "Personal report", useInWorkflow: true, expectedActiveRevisionId: null }),
    });
    expect(memberSave.response.status, memberSave.text).toBe(200);
    expect((await probe.api(colleague, `/v1/apps/${memberAppId}`)).body).toMatchObject({ canManage: true, onDashboard: true });
    const memberSnapshots = (await probe.api(colleague, `/v1/workflows/${memberWorkflowId}/snapshots`)).body;
    const removed = await seed.api(colleague, `/v1/artifact-views/${memberAppId}/retire`, { method: "POST" });
    expect(removed.response.status, removed.text).toBe(200);
    expect(removed.body).toMatchObject({ status: "retired", activeRevisionId: null, useInWorkflow: false });
    expect(record((await probe.api(colleague, "/v1/apps")).body).items).toEqual([]);
    expect((await probe.api(colleague, `/v1/apps/${memberAppId}?revisionId=${memberRevisionId}`)).body).toMatchObject({ onDashboard: false, payload: { data: memberInput } });
    expect((await probe.api(colleague, `/v1/workflows/${memberWorkflowId}/snapshots`)).body).toEqual(memberSnapshots);
    expect((await readApp()).onDashboard).toBe(true);
  });
  evidence.recordAssertionEvidence("Members can delete their own apps but cannot delete another member's private app", "The member created and retired their own saved app, removing its placement and workflow selection while preserving historical results; deleting the admin's app was rejected and that app stayed saved.", true);

  // Use a separate workflow so sharing the selected app cannot grant indirect access to this one.
  const privateInput = { topic: "Private planning" };
  const privateCode = 'return { topic: input.topic };';
  await world.rpc("execute_capability_script", { code: privateCode, input: privateInput });
  const privateWorkflow = await saveWorkflow(world.den.admin, {
    name: "Private planning", code: privateCode, currentInput: privateInput,
    inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    outputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
  });
  expect(privateWorkflow.status, privateWorkflow.text).toBe(201);
  const privateWorkflowId = field(privateWorkflow.body, "configObjectId");
  await runWorkflow(world.den.admin, privateWorkflowId, {
    pluginId: field(privateWorkflow.body, "pluginId"), configObjectVersionId: field(privateWorkflow.body, "configObjectVersionId"), input: privateInput,
  });
  const privateBuilt = await world.rpc("save_artifact_view", {
    configObjectId: privateWorkflowId, title: "Private planning", reactSource: 'export default function Planning({data}) { return <p>{data.topic}</p> }',
  });
  const privateView = record(record(privateBuilt.structuredContent).view);
  const privateAppId = field(privateView, "id");
  if (!Array.isArray(privateView.revisions)) throw new Error("Private app has no revisions");
  const privateSave = await seed.api(world.den.admin, `/v1/apps/${privateAppId}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: field(privateView.revisions[0], "id"), title: "Private planning", useInWorkflow: true, expectedActiveRevisionId: null }),
  });
  expect(privateSave.response.status, privateSave.text).toBe(200);

  const companionBuilt = await world.rpc("save_artifact_view", {
    configObjectId: world.configObjectId, title: "Briefing companion", reactSource: 'export default function Companion({data}) { return <p>{data.topic}</p> }',
  });
  const companionView = record(record(companionBuilt.structuredContent).view);
  const companionAppId = field(companionView, "id");
  if (!Array.isArray(companionView.revisions)) throw new Error("Companion app has no revisions");
  const companionSave = await seed.api(world.den.admin, `/v1/apps/${companionAppId}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: field(companionView.revisions[0], "id"), title: "Briefing companion", useInWorkflow: false, expectedActiveRevisionId: null }),
  });
  expect(companionSave.response.status, companionSave.text).toBe(200);
  const unpinCompanion = await seed.api(world.den.admin, `/v1/apps/${companionAppId}/dashboard`, { method: "POST", body: JSON.stringify({ added: false }) });
  expect(unpinCompanion.response.status, unpinCompanion.text).toBe(200);
  expect((await probe.api(colleague, `/v1/apps/${companionAppId}`)).response.status).toBe(403);

  await step("share dashboard apps with a teammate", async () => {
    await world.open("/dashboard");
    await user.click({ role: "button", label: "Share" });
    await user.see({ text: "Share your dashboard" });
    await user.click("Cancel");
    expect((await probe.api(colleague, `/v1/apps/${appId}`)).response.status).toBe(403);
    const deniedShare = await seed.api(colleague, `/v1/apps/${appId}/share`, {
      method: "POST", body: JSON.stringify({ email: world.den.admin.email }),
    });
    expect(deniedShare.response.status).toBe(403);
    await user.click({ role: "button", label: "Share" });
    await user.click({ role: "checkbox", label: "Private planning" });
    await user.screenshot();
    await user.type({ label: "Teammate’s email" }, "unknown@openwork.test");
    await user.click("Share apps");
    await user.see({ text: /No teammate with that email belongs to this organization/ });
    expect((await probe.api(colleague, `/v1/apps/${appId}`)).response.status).toBe(403);
    await user.type({ label: "Teammate’s email" }, colleague.email, { replace: true });
    await user.click("Share apps");
    await user.see({ text: `Shared 1 app with ${colleague.email}. They’ll appear when your teammate opens or reloads their dashboard.` }, { timeoutMs: 30_000 });
    const sharedApp = await probe.api(colleague, `/v1/apps/${appId}`);
    expect(sharedApp.response.status, sharedApp.text).toBe(200);
    expect(sharedApp.body).toMatchObject({ onDashboard: true, canManage: false, view: { id: appId }, payload: { data: { topic: "Next week’s briefing" } } });
    const sharedWorkflow = await probe.api(colleague, `/v1/workflows/${world.configObjectId}`);
    expect(sharedWorkflow.response.status, sharedWorkflow.text).toBe(200);
    const companion = await probe.api(colleague, `/v1/apps/${companionAppId}`);
    expect(companion.response.status, companion.text).toBe(200);
    expect(companion.body).toMatchObject({ onDashboard: false, canManage: false, view: { id: companionAppId }, payload: { data: { topic: "Next week’s briefing" } } });
    const repeat = await seed.api(world.den.admin, `/v1/apps/${appId}/share`, {
      method: "POST", body: JSON.stringify({ email: colleague.email }),
    });
    expect(repeat.response.status, repeat.text).toBe(200);
    const listed = record((await probe.api(colleague, "/v1/apps")).body).items;
    expect(listed).toHaveLength(2);
    if (!Array.isArray(listed)) throw new Error("Expected the recipient app list");
    expect(listed.map((item) => field(record(item).view, "id")).sort()).toEqual([appId, companionAppId].sort());
    expect(listed.filter((item) => record(item).onDashboard)).toHaveLength(1);
    expect((await probe.api(colleague, `/v1/apps/${privateAppId}`)).response.status).toBe(403);
    expect((await probe.api(colleague, `/v1/workflows/${privateWorkflowId}`)).response.status).toBe(403);
    expect((await probe.api(world.den.admin, `/v1/apps/${privateAppId}`)).body).toMatchObject({ onDashboard: true, canManage: true });
    const reshare = await seed.api(colleague, `/v1/apps/${appId}/share`, {
      method: "POST", body: JSON.stringify({ email: world.den.admin.email }),
    });
    expect(reshare.response.status).toBe(403);
    expect((await probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)).body).toEqual(companyBefore);
    expect((await readApp()).onDashboard).toBe(true);
    await user.screenshot();
    await user.click("Done");
  });
  evidence.recordAssertionEvidence("Dashboard Share grants a teammate view access and adds the selected app to their dashboard", "Cancel and an unknown email left the app private. Sharing made one saved app visible on the recipient dashboard without manager access; repeat sharing did not duplicate it, the unchecked app and its separate workflow remained private, viewers could not reshare, and company dashboards stayed unchanged.", true);
  evidence.recordAssertionEvidence("Sharing includes the workflow, saved results, and sibling apps without adding every sibling to the dashboard", "The recipient could read the workflow and the latest saved result in both the selected app and its previously inaccessible companion. Both appeared in the accessible app list, but only the selected app was on their dashboard; the separate private workflow stayed inaccessible.", true);

  const cleanupCompanion = await seed.api(world.den.admin, `/v1/artifact-views/${companionAppId}/retire`, { method: "POST" });
  expect(cleanupCompanion.response.status, cleanupCompanion.text).toBe(200);
  const cleanupPrivate = await seed.api(world.den.admin, `/v1/artifact-views/${privateAppId}/retire`, { method: "POST" });
  expect(cleanupPrivate.response.status, cleanupPrivate.text).toBe(200);

  const beforeDelete = await readWorkflow();
  const beforeDeleteSnapshots = (await probe.api(world.den.admin, `/v1/workflows/${world.configObjectId}/snapshots`)).body;
  await step("an admin cancels deletion in the app and confirms it on the dashboard", async () => {
    await world.open(dashboardAppPath);
    await user.click("App options for Team briefing");
    await user.click("Delete Team briefing");
    await user.see({ text: "Delete “Team briefing”?" });
    await user.see({ text: "This removes the saved app from everyone’s dashboards and the app list. Its workflow and past results stay available." });
    await user.screenshot();
    await user.click("Cancel");
    expect((await readApp()).onDashboard).toBe(true);
    await world.open("/dashboard");
    await user.click("App options for Team briefing");
    await user.click("Delete Team briefing");
    await user.click("Delete app");
    await user.see({ text: "Make this dashboard yours" }, { timeoutMs: 30_000 });
    await user.reload();
    await user.see({ text: "Make this dashboard yours" }, { timeoutMs: 30_000 });
    expect(record((await probe.api(world.den.admin, "/v1/apps")).body).items).toEqual([]);
    expect((await readApp(originalPath))).toMatchObject({ onDashboard: false, view: { status: "retired", activeRevisionId: null }, payload: { data: { topic: "Launch briefing" } } });
    expect((await readWorkflow()).currentVersion).toEqual(beforeDelete.currentVersion);
    expect((await probe.api(world.den.admin, `/v1/workflows/${world.configObjectId}/snapshots`)).body).toEqual(beforeDeleteSnapshots);
    expect((await probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)).body).toEqual(companyBefore);
    const readd = await seed.api(world.den.admin, `/v1/apps/${appId}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) });
    expect(readd.response.status).toBe(404);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Admins can delete their own apps from the dashboard after a clear confirmation", "Delete is available in the open app and dashboard. Cancel preserves it; confirming removes it across reloads while retaining the workflow, historical results, and unrelated company dashboard.", true);

  await step("Dashboard Add opens a creation conversation", async () => {
    await world.open("/dashboard");
    await user.click({ role: "button", label: "Add" });
    await user.see("Choose an existing app");
    await user.screenshot();
    await user.click("Create with OpenWork");
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "app creation prompt", until: (composer) => JSON.stringify(composer).includes("Create a reusable app for my dashboard that") });
    await user.screenshot();
  });
});
