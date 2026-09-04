import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { field, record, savedAppCreation } from "../worlds/saved-apps.ts";

const test = spec.world(savedAppCreation, { timeout: 900_000 });

test("create, preview, save and reopen an app without changing already-open results", async ({ world, user, probe, seed, step, evidence }) => {
  const appPath = `/apps/${world.appId}`;
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
    await user.navigate(originalPath);
    await user.see("Save app", { timeoutMs: 60_000 });
    await user.see({ text: "App draft" });
    await user.click("Save app");
    await user.see("Save to Apps");
    await user.see({ label: "App name" }, { value: "Briefing app" });
    await user.click("Cancel");
    expect(record((await readApp(originalPath)).view).activeRevisionId).toBeNull();
    await user.screenshot();
  });

  await step("save the app with its workflow", async () => {
    await user.click("Save app");
    await user.type({ label: "App name" }, "Team briefing", { replace: true });
    await user.click("Save app");
    await user.see({ text: "Saved to Apps. Future results from Weekly briefing will use this app." }, { timeoutMs: 30_000 });
    const saved = record((await readApp()).view);
    expect(saved).toMatchObject({ title: "Team briefing", activeRevisionId: world.revisionId, useInWorkflow: true });
    expect(record((await world.render())._meta).viewRevisionId).toBe(world.revisionId);
    const listed = record((await probe.api(world.den.admin, "/v1/apps")).body);
    expect(listed.items).toHaveLength(1);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Drafts stay out of Apps until saved, and Cancel does not save them", "Draft list was empty; Cancel retained a null active revision; Save persisted the exact selected revision and workflow use.", true);

  await step("reopen the saved app after a reload", async () => {
    await user.navigate("/apps");
    await user.reload();
    await user.click("Open Team briefing");
    await user.see("Saved", { timeoutMs: 30_000 });
    await user.screenshot();
  });

  const newerRevision = await world.revise();
  expect(record((await readApp()).view)).toMatchObject({ title: "Team briefing", activeRevisionId: world.revisionId });
  expect(record((await world.render())._meta).viewRevisionId).toBe(world.revisionId);
  await world.run("Next week’s briefing");
  expect(record(record((await readApp()).payload).data).topic).toBe("Next week’s briefing");
  const original = await readApp(originalPath);
  expect(record(record(original.payload).data).topic).toBe("Launch briefing");
  expect(field(original.revision, "id")).toBe(world.revisionId);

  await step("save changes without automatic workflow use", async () => {
    await user.navigate(`${appPath}?revisionId=${newerRevision}`);
    await user.click("Save changes");
    await user.click({ role: "checkbox" });
    await user.click("Save changes");
    await user.see({ text: "Saved to Apps. Open it whenever you need it." }, { timeoutMs: 30_000 });
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
  expect(denied.response.status).toBe(404);
  expect(denied.text).not.toContain("Launch briefing");
  evidence.recordAssertionEvidence("Stale saves and members without workflow access cannot overwrite or read the saved app", "Stale activation returned 409 and kept the title; the ungranted colleague received 404 without result content.", true);

  await step("New app returns to a creation conversation", async () => {
    await user.navigate("/apps");
    await user.click("New app");
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "app creation prompt", until: (composer) => JSON.stringify(composer).includes("Create a reusable app that") });
    await user.screenshot();
  });
});
