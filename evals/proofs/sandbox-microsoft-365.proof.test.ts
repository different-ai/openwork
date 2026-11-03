import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sandboxMicrosoft365World } from "../worlds/sandbox-microsoft-365.ts";

const test = spec.world(sandboxMicrosoft365World, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { commands: ["bun", "python3"] },
});

const MEETING = "Northwind pilot review";

test("a sandbox member connects the sample Microsoft 365 once and Workbot's calendar reads their own sample workspace, not anyone else's", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin), avery = user.on(world.webAvery), riley = user.on(world.webRiley);
  let organizationId = "", joinLink = "", connectionId = "", averyAccount = "";

  const createSandbox = async (name: string) => {
    await admin.click({ testId: "admin-sandbox-new" });
    await admin.type({ role: "textbox", label: "Sandbox name" }, name);
    await admin.type({ role: "textbox", label: "Sample work apps address" }, world.origin, { replace: true });
    await admin.click({ testId: "admin-sandbox-create-submit" });
    await admin.see({ testId: "admin-sandbox-status" }, { text: new RegExp(`Created ${name}`), timeoutMs: 60_000 });
    return (await world.sandboxes()).sandboxes.find((sandbox) => sandbox.name === name);
  };

  await step("before: with the feature off, a new sandbox gets five separate sample apps Workbot cannot read", async () => {
    const sandbox = await createSandbox("Before rollout");
    const ok = sandbox?.connectorCount === 5 && sandbox.sampleMicrosoft365 === false;
    evidence.recordAssertionEvidence("Off by default: Outlook, Calendar and Drive stay separate MCP connectors", `connectors=${sandbox?.connectorCount}; Microsoft 365=${sandbox?.sampleMicrosoft365}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the platform admin turns it on and creates a demo sandbox: one Microsoft 365 connector plus Jira and Confluence", async () => {
    await world.setRollout({ enabled: true });
    await admin.reload();
    const sandbox = await createSandbox("Demo sandbox");
    organizationId = sandbox?.organizationId ?? "";
    joinLink = sandbox?.joinLink ?? "";
    await admin.see({ testId: "admin-sandbox-microsoft" }, { text: /Microsoft 365 for Workbot/, timeoutMs: 30_000 });
    const ok = sandbox?.connectorCount === 3 && sandbox.sampleMicrosoft365 === true;
    evidence.recordAssertionEvidence("Microsoft 365 replaces Outlook, Calendar and Drive in a new sandbox", `connectors=${sandbox?.connectorCount}; Microsoft 365=${sandbox?.sampleMicrosoft365}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("Avery joins with the link and sees Microsoft 365, Jira and Confluence ready for her own sign-in", async () => {
    await avery.navigate(joinLink);
    await avery.click({ testId: "join-sandbox-submit" });
    await avery.see({ testId: "join-org-success" }, { timeoutMs: 30_000 });
    await avery.click({ testId: "join-org-continue-browser" });
    await avery.navigate(new URL("/dashboard/your-connections", joinLink).toString());
    await avery.see({ text: "Microsoft 365" }, { timeoutMs: 30_000 });
    const connections = await world.connections("avery", organizationId);
    connectionId = String(connections.find((connection) => connection.name === "Microsoft 365")?.id ?? "");
    const names = connections.map((connection) => String(connection.name)).sort();
    const ok = names.join() === "Confluence,Jira,Microsoft 365" && Boolean(connectionId);
    evidence.recordAssertionEvidence("Avery's connections", names.join(", "), ok);
    expect(ok).toBe(true);
    await avery.screenshot();
  });

  await step("Avery opens her sample calendar in her browser, then presses Connect: the consent page shows that same workspace", async () => {
    await avery.navigate(`${world.origin}/calendar`);
    await avery.see({ text: /Calendar/ }, { timeoutMs: 30_000 });
    const authorizeUrl = await world.connectStart("avery", organizationId, connectionId);
    const signsInAtWorkplace = new URL(authorizeUrl).origin === world.origin;
    await avery.navigate(authorizeUrl);
    await avery.see({ role: "button", label: "Allow workplace access" }, { timeoutMs: 30_000 });
    const text = await probe.on(world.webAvery).text();
    const ok = signsInAtWorkplace && text.includes("not a Microsoft account");
    evidence.recordAssertionEvidence("Connect goes to the sandbox's sample sign-in, clearly labeled, never Microsoft", `authorize origin=${new URL(authorizeUrl).origin}; labeled=${text.includes("not a Microsoft account")}`, ok);
    expect(ok).toBe(true);
    await avery.screenshot();
  });

  await step("after: Avery allows access once and Den has her own sample mailbox connected", async () => {
    await avery.click({ role: "button", label: "Allow workplace access" });
    const status = await probe.eventually(() => world.status("avery", organizationId, connectionId), { within: 60_000, label: "Avery's Microsoft 365 is connected", until: (value) => value.connected });
    averyAccount = status.account ?? "";
    const ok = status.connected && /^guest-[a-f0-9]{24}@acme\.test$/.test(averyAccount);
    evidence.recordAssertionEvidence("Avery's Microsoft 365 is her browser's sample mailbox", `connected=${status.connected}; account=${averyAccount}`, ok);
    expect(ok).toBe(true);
    await avery.screenshot();
  });

  await step("Workbot's calendar route puts a meeting on Avery's calendar and it appears in her Open Calendar", async () => {
    const created = await world.addMeeting("avery", organizationId, MEETING);
    const calendar = await world.calendar("avery", organizationId);
    await avery.navigate(`${world.origin}/calendar`);
    await avery.see({ text: MEETING }, { timeoutMs: 30_000 });
    const ok = created === 200 && calendar.status === 200 && calendar.events.includes(MEETING);
    evidence.recordAssertionEvidence("Den reads and writes Avery's sample calendar (what Workbot's Calendar tab and first hello read)", `create=${created}; read=${calendar.status}; ${calendar.events.length} events this week incl. "${MEETING}"=${calendar.events.includes(MEETING)}`, ok);
    expect(ok).toBe(true);
    await avery.screenshot();
  });

  await step("Riley joins and connects from his own browser: his calendar never shows Avery's meeting", async () => {
    await riley.navigate(joinLink);
    await riley.click({ testId: "join-sandbox-submit" });
    await riley.see({ testId: "join-org-success" }, { timeoutMs: 30_000 });
    await riley.navigate(await world.connectStart("riley", organizationId, connectionId));
    await riley.click({ role: "button", label: "Allow workplace access" });
    const status = await probe.eventually(() => world.status("riley", organizationId, connectionId), { within: 60_000, label: "Riley's Microsoft 365 is connected", until: (value) => value.connected });
    const calendar = await world.calendar("riley", organizationId);
    await riley.navigate(`${world.origin}/calendar`);
    await riley.see({ text: /Calendar/ }, { timeoutMs: 30_000 });
    const pageText = await probe.on(world.webRiley).text();
    const ok = status.connected && status.account !== averyAccount && calendar.status === 200 && !calendar.events.includes(MEETING) && !pageText.includes(MEETING);
    evidence.recordAssertionEvidence("Each member reads only their own sample workspace", `Riley account=${status.account}; Avery's meeting in Riley's Den calendar=${calendar.events.includes(MEETING)}; in Riley's Open Calendar=${pageText.includes(MEETING)}`, ok);
    expect(ok).toBe(true);
    await riley.screenshot();
  });

  await step("the kill switch stops the sample connector without sending anything to Microsoft", async () => {
    await world.setRollout({ killed: true });
    const calendar = await world.calendar("avery", organizationId);
    let startRefused = false;
    try { await world.connectStart("avery", organizationId, connectionId); } catch (error) { startRefused = error instanceof Error && !error.message.includes("login.microsoftonline.com"); }
    await avery.navigate(new URL("/dashboard/your-connections", joinLink).toString());
    await avery.see({ text: "Microsoft 365" }, { timeoutMs: 30_000 });
    const ok = calendar.status === 409 && /turned off/.test(calendar.message) && startRefused;
    evidence.recordAssertionEvidence("Turned off: Den refuses rather than falling back to Microsoft", `calendar=${calendar.status} "${calendar.message}"; connect refused=${startRefused}`, ok);
    expect(ok).toBe(true);
    await avery.screenshot();
    await world.setRollout({ killed: false });
  });
});
