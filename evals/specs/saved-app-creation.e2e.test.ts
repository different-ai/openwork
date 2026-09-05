import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { field, record, savedAppCreation } from "../worlds/saved-apps.ts";

const test = spec.world(savedAppCreation, { timeout: 900_000 });

test("create, preview, save and reopen an app without changing already-open results", async ({ world, user, probe, seed, step, evidence }) => {
  const appPath = `/apps/${world.appId}`;
  const dashboardAppPath = `/dashboard/apps/${world.appId}`;
  const originalPath = `${appPath}?revisionId=${world.revisionId}&receiptId=${world.receiptId}`;
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
    await world.open(`/dashboard${originalPath}`);
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
  const draftPlacement = await seed.api(world.den.admin, `/v1/apps/${world.appId}/dashboard`, {
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
    expect(saved).toMatchObject({ title: "Team briefing", activeRevisionId: world.revisionId, useInWorkflow: true });
    expect(record((await world.render())._meta).viewRevisionId).toBe(world.revisionId);
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
    expect(await readApp()).toMatchObject({ onDashboard: false, view: { activeRevisionId: world.revisionId } });
    await user.click({ role: "button", label: "Add" });
    await user.see("Create with OpenWork");
    await user.click("Choose an existing app");
    await user.click("Add Team briefing");
    await probe.eventually(readApp, { within: 30_000, label: "personal dashboard placement restored", until: (app) => app.onDashboard === true });
    await user.screenshot();
    await world.open("/dashboard");
    await user.reload();
    await user.see("Open Team briefing", { timeoutMs: 30_000 });
    await user.see({ text: "Project updates" });
    expect((await probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)).body).toEqual(companyBefore);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Removing and adding an existing app changes dashboard placement without deleting the app", "Remove kept the saved revision and company dashboard; Choose an existing app added the personal card again and it survived reload beside Project updates.", true);

  const newerRevision = await world.revise();
  expect(record((await readApp()).view)).toMatchObject({ title: "Team briefing", activeRevisionId: world.revisionId });
  expect(record((await world.render())._meta).viewRevisionId).toBe(world.revisionId);
  await world.run("Next week’s briefing");
  expect(record(record((await readApp()).payload).data).topic).toBe("Next week’s briefing");
  const original = await readApp(originalPath);
  expect(record(record(original.payload).data).topic).toBe("Launch briefing");
  expect(field(original.revision, "id")).toBe(world.revisionId);

  await step("save changes without automatic workflow use", async () => {
    await world.open(`${dashboardAppPath}?revisionId=${newerRevision}`);
    await user.click("Save changes");
    await user.click({ role: "checkbox" });
    await user.click({ role: "button", label: "Save changes", nth: 1 });
    await user.see({ text: "Saved to your dashboard. Open it whenever you need it." }, { timeoutMs: 30_000 });
    expect(record((await readApp()).view)).toMatchObject({ activeRevisionId: newerRevision, useInWorkflow: false });
    expect(record((await world.render())._meta)).not.toHaveProperty("openwork/mcpApp");
  });
  evidence.recordAssertionEvidence("Saving a new app version preserves original previews and respects workflow opt-out", "New data appeared only in the latest result, original revision and receipt remained fixed, and opting out removed automatic app selection.", true);

  const staleSave = await seed.api(world.den.admin, `/v1/apps/${world.appId}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: world.revisionId, title: "Stale overwrite", useInWorkflow: true, expectedActiveRevisionId: world.revisionId }),
  });
  expect(staleSave.response.status).toBe(409);
  expect(record((await readApp()).view).title).toBe("Team briefing");
  const colleague = world.den.members.colleague;
  if (!colleague) throw new Error("The second identity was not provisioned.");
  const denied = await probe.api(colleague, `/v1/apps/${world.appId}`);
  expect(denied.response.status).toBe(403);
  expect(denied.body).toMatchObject({ error: "forbidden", message: "Missing viewer access for config object." });
  expect(denied.text).not.toContain("Launch briefing");
  const colleagueList = await probe.api(colleague, "/v1/apps");
  expect(record(colleagueList.body).items).toEqual([]);
  const deniedAdd = await seed.api(colleague, `/v1/apps/${world.appId}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) });
  expect(deniedAdd.response.status).toBe(403);
  await seed.api(colleague, `/v1/apps/${world.appId}/dashboard`, { method: "POST", body: JSON.stringify({ added: false }) });
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
