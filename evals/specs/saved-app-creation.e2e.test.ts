import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { creationPrompt, creationReply, field, record, savedAppCreation } from "../worlds/saved-apps.ts";

const test = spec.world(savedAppCreation, { timeout: 900_000 });

test("create, preview, save and reopen an app without changing already-open results", async ({ world, user, probe, seed, step, evidence }) => {
  const viewsPath = `/v1/workflows/${world.configObjectId}/views`;
  expect(record((await probe.api(world.den.admin, viewsPath)).body).items).toEqual([]);
  await step("create an app through the Dashboard conversation", async () => {
    await world.open("/dashboard");
    await user.click({ role: "button", label: "Add" });
    await user.click("Create with OpenWork");
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "app creation prompt", until: (composer) => JSON.stringify(composer).includes("Create a reusable app for my dashboard that") });
    expect(creationPrompt).not.toContain(world.configObjectId);
    await user.type("composer", creationPrompt, { replace: true });
    await user.click("Run task");
    await user.see({ text: creationReply }, { timeoutMs: 90_000 });
    await user.see("Save", { timeoutMs: 60_000 });
    await probe.eventually(() => world.previewText(), { within: 30_000, label: "conversation generated the app preview", until: (text) => text.includes("Weekly overview") && text.includes("Launch briefing") });
    await user.screenshot();
  });
  const drafts = record((await probe.api(world.den.admin, viewsPath)).body).items;
  if (!Array.isArray(drafts) || drafts.length !== 1) throw new Error("The conversation must create exactly one draft.");
  const view = record(drafts[0]);
  const appId = field(view, "id");
  if (!Array.isArray(view.revisions) || !view.revisions[0]) throw new Error("The conversation draft has no revision.");
  const revisionId = field(view.revisions[0], "id");
  const requests = await world.den.mocks.agent.agentRequests({ promptMarker: creationPrompt });
  expect(requests.some((request) => request.toolName?.endsWith("save_artifact_view"))).toBe(true);
  expect(requests.some((request) => request.toolName?.includes("preview_artifact_"))).toBe(true);
  evidence.recordAssertionEvidence("A submitted Dashboard creation request builds a new app draft and opens its preview", "There were no app drafts before submission. The real conversation called the MCP builder and newly registered preview tool, persisted one revision, and rendered its workflow data in the artifact panel.", true);
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

  await step("reopen the saved app after a reload", async () => {
    await world.open("/dashboard");
    await user.reload();
    await user.click("Open Team briefing");
    await user.see({ text: "Saved app" }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  const companyBefore = (await probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)).body;
  await step("remove a personal card and add the saved app again", async () => {
    await world.open("/dashboard");
    await user.see({ text: "Project updates" });
    await user.see({ text: "From your company" });
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
