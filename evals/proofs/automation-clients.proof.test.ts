import { expect } from "vitest";
import { isRecord, records } from "../worlds/library.ts";
import { spec } from "@openwork/testkit";
import { desktopAutomationOnDenMonitor } from "../worlds/automation-client.ts";

/**
 * CORE JOURNEY: Den's "My Automations" is a monitor, not an authoring surface.
 * The creating surface owns immutable execution placement — Desktop creates
 * Desktop work and OpenWork Web creates Cloud work — so Den shows what is
 * scheduled and running, links each Automation to the surface that manages
 * it, and keeps exactly one operational control: cancelling an in-flight run.
 */

const test = spec.world(desktopAutomationOnDenMonitor, {
  resources: { surfaces: ["web", "appWeb"], services: ["den"] },
  timeout: 420_000,
});

test("Automation clients preserve lifecycle, run receipts, and owner boundaries", async ({ world, user: driver, probe, step, evidence }) => {
  const user = driver.on(world.web);
  await step("before: inspect the Den Automation monitor", async () => {
    await user.see({ text: "My Automations" }, { timeoutMs: 60_000 });
    await user.see({ text: world.name }, { timeoutMs: 60_000 });
    // The routing copy is one clause of the page intro, so match within it.
    await user.see({ text: /Create and edit Cloud Automations in OpenWork Web/ });
    await user.see({ text: "Open in OpenWork Web" });
    // The group heading renders with CSS uppercase, which innerText reflects.
    await user.see({ text: /^scheduled$/i });
    await user.notSee({ text: /New Automation/ });
    const monitorButtons = await probe.on(world.web).dom("button");
    evidence.recordAssertionEvidence(
      "Den monitor has no authoring entry",
      "The Den Automations page lists Den-scheduled work grouped by attention and routes creation to OpenWork Web instead of offering its own form.",
      monitorButtons.elements.every((button) => !button.text.includes("New Automation")),
    );
  });

  await step("inspect the Desktop Automation detail", async () => {
    // The card is a button whose text is the whole summary; its title is the exact-text target.
    await user.click({ text: world.name });
    await user.see({ text: "Run receipt" }, { timeoutMs: 30_000 });
    await user.see({ text: "Manage in OpenWork Desktop" });
    // No run is in flight, so the only operational control stays hidden too.
    for (const forbidden of ["Edit", "Deactivate", "Activate", "Run now", "Archive", "Save revision", "Create in Cloud", "Cancel run"]) {
      await user.notSee({ role: "button", text: forbidden });
    }
    const controls = await probe.on(world.web).dom("button");
    evidence.recordAssertionEvidence(
      "Den detail is read-only apart from cancelling an in-flight run",
      "A Desktop-placed Automation shows its schedule, receipts, and a Desktop management pointer without any edit, state, run-now, or archive control.",
      controls.elements.every((button) => !["Edit", "Deactivate", "Activate", "Run now", "Archive", "Cancel run"].includes(button.text.trim())),
    );

    await user.screenshot();
  });
  const owner = driver.on(world.app);
  const detail = async () => {
    const response = await probe.api(world.den.admin, `/v1/automations/${world.automationId}`);
    expect(response.response.status).toBe(200);
    if (!isRecord(response.body) || !isRecord(response.body.automation)) throw new Error("Missing Automation detail");
    return response.body.automation;
  };
  await step("the owner deactivates and reactivates the same Automation in the app", async () => {
    await owner.click({ role: "button", label: "Automations" });
    await owner.click({ text: world.name });
    await owner.see({ role: "heading", label: world.name }, { timeoutMs: 90_000 });
    await owner.click({ role: "button", label: "Deactivate" });
    await owner.see({ role: "button", label: "Activate" }, { timeoutMs: 30_000 });
    expect((await detail()).state).toBe("inactive");
    await owner.click({ role: "button", label: "Activate" });
    await owner.see({ role: "button", label: "Deactivate" }, { timeoutMs: 30_000 });
    const reactivated = await detail();
    expect(reactivated.state).toBe("active");
    evidence.recordAssertionEvidence("SDK state mutations preserve the Automation identity", "The app changed active → inactive → active on the same Den record.", reactivated.state === "active");
    await owner.screenshot();
  });
  await step("the owner edits the Automation without losing its definition", async () => {
    await owner.click({ role: "button", label: "Edit" });
    await owner.type({ label: "Name" }, `${world.name} updated`, { replace: true });
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ role: "heading", label: `${world.name} updated` }, { timeoutMs: 30_000 });
    const response = await probe.api(world.den.admin, `/v1/automations/${world.automationId}`);
    expect(response.body).toMatchObject({
      automation: { name: `${world.name} updated` },
      revision: { instructions: "Desktop-created Automation visible to the Den monitor.", model: { providerId: "opencode", modelId: "big-pickle" } },
    });
    evidence.recordAssertionEvidence("SDK edits preserve the saved definition", "The renamed Automation kept its instructions and exact provider/model identity.", isRecord(response.body) && isRecord(response.body.automation) && response.body.automation.name === `${world.name} updated`);
    await owner.screenshot();
  });
  let runId = "";
  await step("the owner queues a run in the app and Den displays its durable receipt", async () => {
    await owner.click({ role: "button", label: "Run now" });
    await owner.see({ text: "Automation queued" }, { timeoutMs: 30_000 });
    const history = await probe.api(world.den.admin, `/v1/automations/${world.automationId}/runs`);
    const runs = isRecord(history.body) ? records(history.body.items) : [];
    expect(runs.length).toBeGreaterThan(0);
    const run = runs[0];
    if (typeof run?.id !== "string") throw new Error("Run now returned no run");
    runId = run.id;
    expect(["queued", "claimed", "running"]).toContain(run.status);
    await user.navigate(`${world.den.ref.webUrl}/dashboard/automations?automation=${world.automationId}&run=${runId}`);
    await user.see({ role: "button", label: "Cancel run" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("the queued run crossed both frontend clients", `The app created run ${runId}; Den fetched its run history and receipt and offered cancellation.`, ["queued", "claimed", "running"].includes(String(run.status)));
    await user.screenshot();
  });
  await step("after: Den cancels the run and a teammate cannot see or cancel the owner's work", async () => {
    await user.click({ role: "button", label: "Cancel run" });
    await probe.eventually(async () => {
      const response = await probe.api(world.den.admin, `/v1/automation-runs/${runId}`);
      return isRecord(response.body) && isRecord(response.body.run) ? response.body.run.status : null;
    }, { within: 30_000, label: "run cancelled", until: (status) => status === "cancelled" });
    await user.notSee({ role: "button", label: "Cancel run" });
    const member = user.on(world.memberWeb);
    await member.reload();
    await member.see({ text: "No Automations yet. Create one in OpenWork Web or in the desktop app; it will show up here once Den is scheduling it." }, { timeoutMs: 60_000 });
    await member.notSee({ text: world.name });
    const denied = await world.deniedCancellation(runId);
    expect(denied.response.status).toBe(404);
    evidence.recordAssertionEvidence("run ownership remains personal", "The owner cancelled their run; a teammate sees an empty list and cancellation of the owner's run returns 404.", denied.response.status === 404);
    await member.screenshot();
  });

  await step("the owner creates a Desktop Automation from the app", async () => {
    await owner.click({ role: "button", label: "Automations" });
    await owner.click({ role: "button", label: "New Automation" });
    await owner.see({ role: "heading", label: "Create Automation" }, { timeoutMs: 60_000 });
    await owner.type({ label: "Name" }, "Created through the SDK", { replace: true });
    await owner.type({ label: "Instructions" }, "Summarize the local project notes.", { replace: true });
    await owner.click({ role: "button", label: "Create and activate" });
    await owner.see({ role: "heading", label: "Created through the SDK" }, { timeoutMs: 30_000 });
    const list = await probe.api(world.den.admin, "/v1/automations");
    const rows = isRecord(list.body) ? records(list.body.items) : [];
    const created = rows.find((row) => isRecord(row.automation) && row.automation.name === "Created through the SDK");
    expect(created).toMatchObject({ automation: { state: "active" }, revision: { executionTarget: "desktop", instructions: "Summarize the local project notes." } });
    evidence.recordAssertionEvidence("SDK creation sends the complete definition", "The app's create form produced a distinct active Desktop Automation with the requested instructions.", rows.some((row) => isRecord(row.automation) && row.automation.name === "Created through the SDK"));
    await owner.screenshot();
  });
  await step("archiving hides the Automation while retaining its saved history", async () => {
    const list = await probe.api(world.den.admin, "/v1/automations");
    const rows = isRecord(list.body) ? records(list.body.items) : [];
    const created = rows.find((row) => isRecord(row.automation) && row.automation.name === "Created through the SDK");
    const createdId = created && isRecord(created.automation) ? created.automation.id : null;
    if (typeof createdId !== "string") throw new Error("Created Automation not found");
    await owner.click({ role: "button", label: "Archive Automation" });
    await owner.see({ role: "heading", label: "Archive Automation?" });
    await owner.click({ role: "button", label: /^Archive$/ });
    await owner.see({ text: "Automation archived" }, { timeoutMs: 30_000 });
    await owner.notSee({ role: "heading", label: "Created through the SDK" });
    const archived = await probe.api(world.den.admin, `/v1/automations/${createdId}`);
    expect(archived.body).toMatchObject({ automation: { state: "archived" }, revision: { instructions: "Summarize the local project notes." } });
    evidence.recordAssertionEvidence("archive preserves the durable definition", "The app archived the new Automation; its history remains readable from Den.", isRecord(archived.body) && isRecord(archived.body.automation) && archived.body.automation.state === "archived");
    await owner.screenshot();
  });
});
