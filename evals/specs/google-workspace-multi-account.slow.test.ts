import { expect, onTestFinished, test } from "vitest";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import { startMockGoogle } from "@openwork/labs";
import {
  clickButton,
  clickText,
  control,
  createAndSelectWorkspace,
  createNativeConnector,
  deleteConnection,
  deleteConnectionsNamed,
  ensureMemberSession,
  evalIn,
  go,
  hasText,
  openConnectionsSurface,
  provisionOrg,
  readAvailableModels,
  readSessionToolCalls,
  readUsableConnection,
  revealText,
  selectModel,
  sendComposerMessage,
  signIn,
  signInDesktopAs,
  waitFor,
  waitForAssistantReply,
  waitForConnectionCard,
  waitForText,
  waitUntilInteractive,
} from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import type { DenRef, DenSession } from "@openwork/behaviors";
import type { DesktopHandle } from "@openwork/hosts";
import type { MockGoogleHandle } from "@openwork/labs";

/**
 * CLAIM: one organization can publish two independently configured Google
 * Workspace connectors, and one member can authorize a different Google
 * account for each. When the member asks for Acme Labs by name, the agent uses
 * that connector, the draft lands only in Labs, and the Gmail link selects the
 * same account. A one-domain organization still sees the old one-card flow.
 *
 * Faithfulness notes:
 *  - Both Google domains are served by the protocol-identical mock. OAuth,
 *    /userinfo, token exchange, chooser, and Gmail draft requests cross the
 *    same boundaries as production; the mock's per-mailbox draft log is the
 *    external authority on which credential was used.
 *  - The second authorization must carry prompt=select_account and is completed
 *    through the mock's real chooser page. Merely changing a token fixture or
 *    asserting app copy would not prove Google let Jordan choose.
 *  - The draft request goes through the real composer without a connector id.
 *    Session timeline observations prove the agent selected Acme Labs, while
 *    mailbox logs prove Acme Robotics received nothing from that request.
 *  - Start Den with DEN_GOOGLE_API_BASE_URL and the three DEN_GOOGLE_OAUTH_*
 *    endpoint variables pointed at the mock URLs for this spec. If Den is on a
 *    different host, publish the mock and set OPENWORK_EVAL_GOOGLE_MOCK_PUBLIC_URL.
 */

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const optedIn = process.env.OPENWORK_EVAL_GOOGLE_MULTI_ACCOUNT_SPEC === "1";
const title = !appSpecsEnabled || !apiUrl || !optedIn
  ? "google workspace multi-account skipped: set OPENWORK_EVAL_APP_SPECS=1, OPENWORK_EVAL_DEN_API_URL, and OPENWORK_EVAL_GOOGLE_MULTI_ACCOUNT_SPEC=1"
  : "two Google Workspace connectors keep one member's accounts and drafts isolated";

const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const adminEmail = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const memberEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan@acme.test";
const roboticsEmail = "jordan@acme.test";
const labsEmail = "jordan@acmelabs.test";
const modelId = process.env.OPENWORK_EVAL_MODEL?.trim() || "";

async function memberDesktop(den: DenRef, member: DenSession): Promise<{ app: DesktopHandle; workspaceId: string }> {
  const app = await desktop({
    name: "google-workspace-multi-account",
    bootstrap: { baseUrl: den.webUrl, apiBaseUrl: den.webUrl, requireSignin: false },
  });
  const path = `/tmp/openwork-google-workspace-multi-account-${Date.now()}`;
  await createAndSelectWorkspace(app, { path });
  await signInDesktopAs(app, den, member);
  const { workspaceId } = await createAndSelectWorkspace(app, { path });
  return { app, workspaceId };
}

async function countButtons(app: Surface, label: string, exact = false): Promise<number> {
  const value = await evalIn(app, `([...document.querySelectorAll('button')]
    .filter((button) => ${exact ? "(button.textContent ?? '').trim() ===" : "(button.textContent ?? '').includes"}(${JSON.stringify(label)})).length)`);
  if (typeof value !== "number") throw new Error(`Button count for ${label} was not a number: ${JSON.stringify(value)}`);
  return value;
}

async function createFreshSession(app: Surface, workspaceId: string): Promise<string> {
  await control(app, "session.create_task");
  await waitUntilInteractive(app, { timeoutMs: 120_000 });
  const listed = await waitFor(app, `(async () => {
    const result = await window.__openworkControl.execute("session.list_sessions", null);
    const sessions = Array.isArray(result?.result) ? result.result : [];
    const withId = sessions.map((entry) => entry?.sessionId).filter((id) => typeof id === "string" && id.startsWith("ses_"));
    return withId.length > 0 ? withId[0] : false;
  })()`, { timeoutMs: 120_000, awaitPromise: true, label: "fresh Google task session id" });
  if (typeof listed !== "string") throw new Error(`Could not read the fresh session id: ${JSON.stringify(listed)}`);
  await go(app, `/workspace/${workspaceId}/session/${listed}`);
  await waitUntilInteractive(app, { timeoutMs: 120_000 });
  if (modelId) {
    const models = await readAvailableModels(app);
    expect(
      models.some((model) => model.id === modelId && model.selectable),
      `${modelId} is not selectable for the Google multi-account task. Saw: ${models.map((model) => model.id).join(", ")}`,
    ).toBe(true);
    await selectModel(app, modelId);
  }
  return listed;
}

test.skipIf(!appSpecsEnabled || !apiUrl || !optedIn)(title, async () => {
  const den: DenRef = {
    apiUrl,
    webUrl: (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || apiUrl.replace("127.0.0.1", "localhost")).replace(/\/+$/, ""),
  };
  await using roll = photoRoll("google-workspace-multi-account");
  await using google = await startMockGoogle({
    accounts: [roboticsEmail, labsEmail],
    port: Number(process.env.OPENWORK_EVAL_GOOGLE_MOCK_PORT ?? 3980),
    publicUrl: process.env.OPENWORK_EVAL_GOOGLE_MOCK_PUBLIC_URL?.trim() || undefined,
    autoApprove: false,
  });

  const admin = await signIn(den, { email: adminEmail, password });
  const member = await ensureMemberSession(den, admin, {
    email: memberEmail,
    password,
    name: "Jordan Demo",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await deleteConnectionsNamed(admin, "Acme Robotics");
  await deleteConnectionsNamed(admin, "Acme Labs");

  const robotics = await createNativeConnector(admin, {
    providerKey: "google-workspace",
    name: "Acme Robotics",
    clientId: "acme-robotics-google-client",
    clientSecret: "acme-robotics-google-secret",
    features: ["gmailDraft"],
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(admin, robotics.id));

  const memberApp = await memberDesktop(den, member);
  await using app = memberApp.app;
  await openConnectionsSurface(app, memberApp.workspaceId);
  await waitForConnectionCard(app, robotics.name, memberApp.workspaceId);
  expect(await hasText(app, "Acme Labs"), "Acme Labs must not exist before Alex registers the acquired domain").toBe(false);
  expect(await countButtons(app, robotics.name), "the original company should begin with exactly one Google connection card").toBe(1);
  // The DOM already has the card; a frame needs its pixels on screen.
  await revealText(app, robotics.name);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "Acme Robotics is visibly listed as a Google Workspace connection this person can sign in to",
      "No Acme Labs connection or 'Something went wrong' crash message is visible yet",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const labs = await createNativeConnector(admin, {
    providerKey: "google-workspace",
    name: "Acme Labs",
    clientId: "acme-labs-google-client",
    clientSecret: "acme-labs-google-secret",
    features: ["gmailDraft"],
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(admin, labs.id));
  await waitForConnectionCard(app, labs.name, memberApp.workspaceId);
  expect(await countButtons(app, robotics.name), "adding Labs must leave the original Robotics card untouched").toBe(1);
  expect(await countButtons(app, labs.name), "Alex's Acme Labs registration must create one separate card").toBe(1);
  await revealText(app, labs.name);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "Acme Robotics and Acme Labs are both visible, as two separate Google Workspace connections",
      "The original Acme Robotics connection is still present and no crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  expect(
    (await readUsableConnection(member, robotics.id))?.connectedForMe,
    "Jordan must not inherit a Robotics credential before connecting her own account",
  ).toBe(false);
  expect(
    (await readUsableConnection(member, labs.id))?.connectedForMe,
    "Jordan must not inherit a Labs credential before connecting her own account",
  ).toBe(false);
  // The list offers each connection a "Sign in" next action; the actual
  // authorization lives in the detail panel. Frame 3 is that panel — a
  // distinct state from the list frame above, or the photo roll rejects the
  // duplicate pixels.
  expect(await countButtons(app, robotics.name), "Robotics must still be exactly one card").toBe(1);
  expect(await countButtons(app, labs.name), "Labs must still be exactly one card").toBe(1);
  await clickText(app, robotics.name, { selector: "button" });
  await waitForText(app, "Connect your account", { timeoutMs: 30_000 });
  await revealText(app, "Connect your account");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A Google Workspace connection detail visibly offers connecting this person's own account",
      "No shared password is requested and no crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  // Connect Robotics from the open panel, then close it so the Labs card is reachable.
  const roboticsClickedAt = new Date().toISOString();
  await clickButton(app, "Connect your account");
  await google.authorizeRequestSince(roboticsClickedAt, { timeoutMs: 60_000 });
  await google.chooseAccount(roboticsEmail, { timeoutMs: 60_000 });
  await expect.poll(
    async () => (await readUsableConnection(member, robotics.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);
  await clickButton(app, "Close");
  await openConnectionsSurface(app, memberApp.workspaceId);
  await waitForConnectionCard(app, labs.name, memberApp.workspaceId);
  await clickText(app, labs.name, { selector: "button" });
  await waitForText(app, "Connect your account", { timeoutMs: 30_000 });
  const labsClickedAt = new Date().toISOString();
  await clickButton(app, "Connect your account");
  const labsAuthorize = await google.authorizeRequestSince(labsClickedAt, { timeoutMs: 60_000 });
  expect(
    labsAuthorize.params.get("prompt") ?? "",
    "Acme Labs OAuth must send prompt=select_account instead of silently reusing Robotics",
  ).toContain("select_account");
  await revealText(app, "Acme Labs");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "OpenWork visibly shows that Acme Labs browser authorization is in progress",
      "The app has not silently reported success and no OAuth launch error is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }
  await google.chooseAccount(labsEmail, { timeoutMs: 60_000 });
  await expect.poll(
    async () => (await readUsableConnection(member, labs.id))?.connectedForMe,
    {
      message: "Acme Labs did not become connected for Jordan after the account chooser callback",
      timeout: 90_000,
      interval: 1_000,
    },
  ).toBe(true);

  expect(
    (await readUsableConnection(member, robotics.id))?.connectedForMe,
    "connecting Acme Labs must not replace Jordan's Acme Robotics credential",
  ).toBe(true);
  expect(
    (await readUsableConnection(member, labs.id))?.connectedForMe,
    "Jordan's Acme Labs credential must remain connected independently",
  ).toBe(true);
  await openConnectionsSurface(app, memberApp.workspaceId);
  await waitForText(app, roboticsEmail, { timeoutMs: 60_000 });
  await waitForText(app, labsEmail, { timeoutMs: 60_000 });
  // Close the Labs panel and return to the list: the frame must show BOTH
  // rows at once, each badged with its own signed-in email.
  await clickButton(app, "Close");
  await openConnectionsSurface(app, memberApp.workspaceId);
  await waitForText(app, roboticsEmail, { timeoutMs: 60_000 });
  await waitForText(app, labsEmail, { timeoutMs: 60_000 });
  await revealText(app, labsEmail);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "Two Google connections are visibly Connected and each shows a different email address: jordan@acme.test and jordan@acmelabs.test",
      "Both sign-ins are present at once and no replacement or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  await createFreshSession(app, memberApp.workspaceId);
  const roboticsDraftSince = new Date().toISOString();
  await sendComposerMessage(
    app,
    "Using Acme Robotics, create a Gmail draft to archive@acme.test with body 'Robotics credential witness'. Return its Gmail link.",
  );
  const roboticsDrafts = await google.draftsFor(roboticsEmail, {
    since: roboticsDraftSince,
    timeoutMs: 180_000,
    atLeast: 1,
  });
  expect(roboticsDrafts.length, "the Robotics connector never produced its credential witness draft").toBeGreaterThanOrEqual(1);
  await waitForAssistantReply(app, { timeoutMs: 180_000 });
  const roboticsDraft = roboticsDrafts[0];
  if (!roboticsDraft) throw new Error("The Robotics credential witness draft disappeared after draftsFor returned it.");

  const labsSessionId = await createFreshSession(app, memberApp.workspaceId);
  const supplierMarker = `labs-supplier-${Date.now()}`;
  const supplierPrompt = `Draft an email in Acme Labs to supplier@parts.test with body exactly "${supplierMarker}". Return the Gmail draft link.`;
  expect(supplierPrompt, "the user-facing request must not smuggle in the Labs connector id").not.toContain(labs.id);
  expect(supplierPrompt, "the user-facing request must not smuggle in the Robotics connector id").not.toContain(robotics.id);
  const supplierRequestedAt = new Date().toISOString();
  await sendComposerMessage(app, supplierPrompt);
  await revealText(app, "Acme Labs");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "Jordan's visible task asks the AI coworker to draft the supplier email in Acme Labs by name",
      "The task does not expose a connector id or show a 'Something went wrong' crash message",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const labsDrafts = await google.draftsFor(labsEmail, {
    since: supplierRequestedAt,
    timeoutMs: 180_000,
    atLeast: 1,
  });
  const wrongMailboxDrafts = await google.draftsFor(roboticsEmail, {
    since: supplierRequestedAt,
    timeoutMs: 5_000,
  });
  expect(labsDrafts.length, "the supplier draft did not appear in jordan@acmelabs.test").toBeGreaterThanOrEqual(1);
  expect(
    wrongMailboxDrafts,
    `the Labs request leaked a draft into jordan@acme.test: ${JSON.stringify(wrongMailboxDrafts)}`,
  ).toEqual([]);
  const labsDraft = labsDrafts.find((draft) => draft.body.includes(supplierMarker));
  expect(labsDraft, `no Labs draft contained the unique supplier marker ${supplierMarker}`).toBeDefined();
  if (!labsDraft) throw new Error(`The Labs draft containing ${supplierMarker} was not returned.`);
  expect(labsDraft.to, "the Labs draft must be addressed to the requested supplier").toBe("supplier@parts.test");
  expect(
    labsDraft.tokenId,
    "the Labs and Robotics drafts used the same credential token",
  ).not.toBe(roboticsDraft.tokenId);

  const toolCalls = await readSessionToolCalls(app, { sessionId: labsSessionId, timeoutMs: 180_000 });
  expect(
    toolCalls.some((call) => call.connectionId === labs.id),
    `the supplier session never invoked the Acme Labs connector. Calls: ${JSON.stringify(toolCalls)}`,
  ).toBe(true);
  expect(
    toolCalls.some((call) => call.connectionId === robotics.id),
    `the supplier session invoked Acme Robotics despite naming Labs. Calls: ${JSON.stringify(toolCalls)}`,
  ).toBe(false);

  const reply = await waitForAssistantReply(app, { timeoutMs: 180_000 });
  const gmailLink = /https:\/\/mail\.google\.com\/[^\s<>)\]]+/.exec(reply.text)?.[0] ?? "";
  expect(gmailLink, `the assistant did not return a Gmail link. Reply: ${reply.text}`).toContain("authuser=");
  expect(gmailLink, `the Gmail link hard-coded the first signed-in account: ${gmailLink}`).not.toContain("/mail/u/0/");
  await revealText(app, "authuser=");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The completed Acme Labs supplier task visibly returns a Gmail draft link",
      "The result is successful and no wrong-inbox or 'Something went wrong' message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const singleDomain = await provisionOrg(den, { connectors: ["google-workspace"] });
  expect(singleDomain.orgId, "the single-domain fixture did not provision a separate organization").toBeTruthy();
  const singleAppHandle = await memberDesktop(den, singleDomain.admin);
  await using singleApp = singleAppHandle.app;
  await openConnectionsSurface(singleApp, singleAppHandle.workspaceId);
  await waitForConnectionCard(singleApp, "Google Workspace", singleAppHandle.workspaceId);
  expect(
    await countButtons(singleApp, "Google Workspace"),
    "a single-domain organization must still have exactly one Google Workspace card",
  ).toBe(1);
  expect(
    await countButtons(singleApp, "Connect your account", true),
    "a single-domain organization must still have exactly one Connect your account button",
  ).toBe(1);
  expect(await hasText(singleApp, "Acme Labs"), "the single-domain flow must not introduce a second-domain decision").toBe(false);
  await revealText(singleApp, "Connect your account");
  {
    const shot = await screenshot(singleApp);
    const seen = await validate(shot, [
      "A single-domain company visibly has one Google Workspace card and one Connect your account button",
      "No second-domain choice, additional decision, or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }
});
