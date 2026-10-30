import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sandboxOrganizationsWorld } from "../worlds/sandbox-organizations.ts";

const test = spec.world(sandboxOrganizationsWorld, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { commands: ["bun", "python3"] },
});

const apps = ["Outlook", "Calendar", "Drive", "Jira", "Confluence"];

test("a platform admin creates a sandbox organization from /admin and people who open its link get their own sample work apps and included models", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), avery = user.on(world.webAvery), riley = user.on(world.webRiley);
  const casey = user.on(world.webCasey), anonymous = user.on(world.anonymous);
  let organizationId = "", joinLink = "", outlookId = "";

  await step("Sandbox organizations are available by default", async () => {
    await admin.see({ testId: "admin-sandbox-orgs" });
    const state = await world.sandboxes();
    evidence.recordAssertionEvidence("The Sandboxes page opens with nothing created yet", `enabled=${state.enabled}; sandboxes=${state.sandboxes.length}`, state.enabled && state.sandboxes.length === 0);
    expect(state.enabled).toBe(true);
    await admin.screenshot();
  });

  await step("the admin creates a two-week sandbox with the sample work apps and three seats", async () => {
    await admin.click({ testId: "admin-sandbox-new" });
    await admin.type({ role: "textbox", label: "Sandbox name" }, "OpenWork Sandbox");
    await admin.type({ role: "textbox", label: "Sample work apps address" }, world.origin);
    await admin.type({ label: "Seats" }, "3", { replace: true });
    await admin.screenshot();
    await admin.click({ testId: "admin-sandbox-create-submit" });
    await admin.see({ testId: "admin-sandbox-status" }, { text: /Created OpenWork Sandbox/, timeoutMs: 60_000 });
    const sandbox = (await world.sandboxes()).sandboxes[0];
    organizationId = sandbox?.organizationId ?? "";
    joinLink = sandbox?.joinLink ?? "";
    const freeAuto = organizationId ? await world.freeAutoOffered(organizationId) : null;
    const ok = sandbox?.state === "open" && sandbox.connectorCount === 5 && sandbox.memberCount === 1 && sandbox.memberLimit === 3 && freeAuto === true;
    evidence.recordAssertionEvidence("One click creates the organization, five per-person connectors, included models and a join link",
      `state=${sandbox?.state}; connectors=${sandbox?.connectorCount}; seats=${sandbox?.memberCount}/${sandbox?.memberLimit}; Free Auto=${freeAuto}; link=${joinLink ? "issued" : "missing"}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("a signed-out visitor with an unknown link is told it is not valid", async () => {
    await anonymous.see({ role: "heading", label: "This link isn't available." }, { timeoutMs: 30_000 });
    const text = await probe.on(world.anonymous).text();
    const ok = !text.includes("OpenWork Sandbox");
    evidence.recordAssertionEvidence("Guessing a link reveals no sandbox", ok ? "unknown token -> not available; no sandbox name shown" : "sandbox name leaked", ok);
    expect(ok).toBe(true);
    await anonymous.screenshot();
  });

  await step("Avery opens the link, sees what the sandbox includes and joins as an admin", async () => {
    await avery.navigate(joinLink);
    await avery.see({ testId: "join-sandbox-connectors" }, { text: /Outlook, Calendar, Drive, Jira, Confluence/, timeoutMs: 30_000 });
    await avery.screenshot();
    await avery.click({ testId: "join-sandbox-submit" });
    await avery.see({ testId: "join-org-success" }, { timeoutMs: 30_000 });
    const membership = await world.membership("avery", organizationId);
    evidence.recordAssertionEvidence("Joining makes Avery an admin of the sandbox, never its owner", `status=${membership.status}; role=${membership.role}`, membership.status === 200 && membership.role === "admin");
    expect(membership.role).toBe("admin");
    await avery.screenshot();
  });

  await step("after: Avery's connections list the five sample apps, ready for Avery's own sign-in", async () => {
    await avery.click({ testId: "join-org-continue-browser" });
    await avery.navigate(new URL("/dashboard/your-connections", joinLink).toString());
    for (const app of apps) await avery.see({ text: app }, { timeoutMs: 30_000 });
    const connections = await world.connections("avery", organizationId);
    const names = connections.map(connection => String(connection.name)).sort();
    outlookId = String(connections.find(connection => connection.name === "Outlook")?.id ?? "");
    const ok = names.join() === [...apps].sort().join() && connections.every(connection => connection.connectedForMe === false);
    evidence.recordAssertionEvidence("Every sample app is shared with the sandbox but signed in per person", `apps=${names.join(", ")}; connected for Avery=${connections.filter(connection => connection.connectedForMe).length}`, ok);
    expect(ok).toBe(true);
    await avery.screenshot();
  });

  await step("Avery connects Outlook with Avery's own sample account", async () => {
    await avery.navigate(await world.oauthStart("avery", organizationId, outlookId));
    const text = await probe.eventually(() => probe.on(world.webAvery).text(), { within: 60_000, label: "the sample service asks Avery to allow access", until: value => value.includes("Allow workplace access") });
    evidence.recordAssertionEvidence("The sample service asks for consent without a password", text.includes("Workshop password") ? "password prompt shown" : "consent shown directly", !text.includes("Workshop password"));
    await avery.screenshot();
    await avery.click({ role: "button", label: "Allow workplace access" });
    const connected = await probe.eventually(async () => (await world.connections("avery", organizationId)).find(connection => connection.id === outlookId), { within: 60_000, label: "Avery's Outlook is connected", until: value => value?.connectedForMe === true });
    evidence.recordAssertionEvidence("Avery's Outlook connection is Avery's alone", `Avery connected=${connected?.connectedForMe}`, connected?.connectedForMe === true);
    await avery.screenshot();
  });

  await step("Riley opens the link signed out, enters an email that already has an account and is asked for the password, not a code", async () => {
    await riley.navigate(joinLink);
    await riley.type({ role: "textbox" }, world.rileyLogin.email);
    await riley.click({ role: "button", label: "Next" });
    await riley.see({ role: "textbox", label: /^password$/i }, { timeoutMs: 30_000 });
    const text = await probe.on(world.webRiley).text();
    const ok = !/verification code|check your inbox/i.test(text);
    evidence.recordAssertionEvidence("An existing account signs in instead of waiting for an email that never comes", ok ? "password step shown" : "code screen shown", ok);
    expect(ok).toBe(true);
    await riley.screenshot();
  });

  await step("Riley signs in, joins and starts with nothing connected", async () => {
    await riley.type({ role: "textbox", label: /^password$/i }, world.rileyLogin.password, { sensitive: true });
    await riley.press("Enter");
    await riley.see({ testId: "join-sandbox-submit" }, { timeoutMs: 30_000 });
    await riley.click({ testId: "join-sandbox-submit" });
    await riley.see({ testId: "join-org-success" }, { timeoutMs: 30_000 });
    const outlook = (await world.connections("riley", organizationId)).find(connection => connection.id === outlookId);
    const membership = await world.membership("riley", organizationId);
    const ok = membership.role === "admin" && outlook?.connectedForMe === false;
    evidence.recordAssertionEvidence("Avery's sign-in does not carry over to Riley", `Riley role=${membership.role}; Riley Outlook connected=${outlook?.connectedForMe}`, ok);
    expect(ok).toBe(true);
    await riley.screenshot();
  });

  await step("Casey arrives after the three seats are taken and cannot join", async () => {
    await casey.navigate(joinLink);
    await casey.see({ role: "heading", label: "This sandbox is full." }, { timeoutMs: 30_000 });
    const membership = await world.membership("casey", organizationId);
    evidence.recordAssertionEvidence("The seat limit holds", `Casey /v1/org in the sandbox=${membership.status}`, membership.status !== 200);
    expect(membership.status).not.toBe(200);
    await casey.screenshot();
  });

  await step("the admin closes the sandbox: the link stops and included models end, members stay", async () => {
    await admin.reload();
    await admin.click({ role: "button", label: "Close" });
    await admin.see({ testId: "admin-sandbox-state" }, { text: "Closed", timeoutMs: 30_000 });
    const sandbox = (await world.sandboxes()).sandboxes[0];
    const freeAuto = await world.freeAutoOffered(organizationId);
    const ok = sandbox?.state === "closed" && sandbox.memberCount === 3 && freeAuto === false;
    evidence.recordAssertionEvidence("Closing keeps people and data but stops joins and Free Auto", `state=${sandbox?.state}; members=${sandbox?.memberCount}; Free Auto=${freeAuto}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
    await casey.reload();
    await casey.see({ role: "heading", label: "This sandbox is closed." }, { timeoutMs: 30_000 });
    await casey.screenshot();
  });

  await step("a sandbox member cannot list or create sandboxes", async () => {
    const access = await world.memberAccess();
    const ok = access.read === 403 && access.write === 403;
    evidence.recordAssertionEvidence("Owning or joining a sandbox does not grant platform administration", `member read=${access.read}; member create=${access.write}`, ok);
    expect(ok).toBe(true);
  });
});
