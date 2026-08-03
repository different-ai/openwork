import { expect, onTestFinished } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import { daytonaSandbox } from "@openwork/hosts";
import {
  clickButton,
  createOrgConnection,
  deleteConnection,
  deleteConnectionsNamed,
  evalIn,
  go,
  openConnectionsSurface,
  readAvailableModels,
  readUsableConnection,
  revealText,
  selectModel,
  waitFor,
  waitForConnectionCard,
  waitForText,
  writeComposerText,
} from "@openwork/behaviors";
import { app, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { Surface } from "@openwork/cdp";
import type { NeedsSpec } from "@openwork/testkit";

/**
 * CORE JOURNEY: an admin publishes one organization MCP connector; two different
 * people each connect their OWN account and then actually use its tools from the
 * composer. Neither inherits the other's credential.
 *
 * Faithfulness notes:
 *  - Two SEPARATE desktops, each with its own isolated profile, signed in as
 *    different members. A single desktop clearing localStorage only simulates
 *    per-member isolation; two desktops make it real.
 *  - The connector itself is the authority on "was it used": we assert on the
 *    tool calls it actually served, and on DISTINCT bearer-token fingerprints,
 *    rather than trusting the app's own "Connected" text.
 *  - The tool call is a real agent task through the product's composer.
 *
 * PLACEMENT: set OPENWORK_EVAL_DAYTONA_SANDBOX_A and _B to put each member's
 * desktop on its own Daytona sandbox (the driver must run outside any sandbox).
 * That is the reliable shape: two desktops plus two engines starve renderers on
 * one 9GB sandbox. Without A/B both desktops use the testkit's resolved place.
 *
 * When the desktops are remote, the mock connector cannot live on the driver's
 * loopback: Den dials it server-side (discovery, DCR, token, tool calls), each
 * desktop's browser opens its /authorize, and the driver polls /requests. Host
 * it somewhere all three can reach and point
 * OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL at it (ISSUER must be that same URL).
 *
 * OPT-IN because it needs provisioned placement, not because anything is broken.
 * (An earlier revision blamed a product defect for a blank connections surface;
 * that was this spec racing the app's route rewrite and the panel's first paint,
 * both fixed here and in org-connection-lifecycle. Retracted.)
 * The tool-call phase runs two desktops and two engines at once — more than one
 * eval sandbox reliably gives. Run it with OPENWORK_EVAL_DAYTONA_SANDBOX_A/_B
 * placing each desktop on its own sandbox, a Den both can reach, and the mock
 * published at OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL.
 *
 * Testkit migration: needs() now owns the model, env, and exact opt-in skips;
 * server()/mcpMock() own reused-Den, member, and connector lifecycle; app() owns
 * the workspace-then-sign-in dance; ambient evidence replaces photoRoll/add.
 * The three route/paint waits moved verbatim to @openwork/behaviors so this spec
 * no longer carries private copies of shared product behavior.
 */

const requirements: NeedsSpec = {
  model: "tool-capable",
  env: ["OPENWORK_EVAL_DEN_API_URL"],
  optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_CONNECTOR_SPEC"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `org connector two members skipped — needs: ${missingRequirements.join(", ")}`
  : "two members each connect their own account to one org connector and call its tools";

const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const aEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const bEmail = process.env.OPENWORK_EVAL_MEMBER_B_EMAIL?.trim() || "riley.demo@acme.test";
const modelId = process.env.OPENWORK_EVAL_MODEL?.trim() || "";
const sandboxA = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_A?.trim() ?? "";
const sandboxB = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_B?.trim() ?? "";

async function openConnectionDetail(appSurface: Surface, name: string): Promise<void> {
  await waitFor(appSurface, `(() => {
    const card = [...document.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!card) return false;
    card.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `opened connection detail ${name}` });
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  // Half-specified placement would silently recreate the one-sandbox squeeze.
  if (Boolean(sandboxA) !== Boolean(sandboxB)) {
    throw new Error("Set both OPENWORK_EVAL_DAYTONA_SANDBOX_A and _B (or neither).");
  }
  if (sandboxA) expect(sandboxA).not.toBe(sandboxB);

  // ── The connector we own, with OAuth per member ──────────────────────
  await using den = await server({
    place,
    mocks: {
      connector: mcpMock({
        port: Number(process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PORT ?? 3979),
        publicUrl: process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL?.trim() || undefined,
      }),
    },
    reuseMembers: {
      a: { email: aEmail, password, name: "Jordan Demo" },
      b: { email: bEmail, password, name: "Riley Demo" },
    },
  });
  const conn = den.mocks.connector;
  const memberA = den.members.a;
  const memberB = den.members.b;
  if (!memberA || !memberB) throw new Error("The reused Den did not provision both connector members.");

  await deleteConnectionsNamed(den.admin, "Acme Tickets ");
  const connection = await createOrgConnection(den.admin, {
    name: `Acme Tickets ${Date.now()}`,
    url: conn.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(den.admin, connection.id));

  // Published, but nobody has connected their own account yet.
  expect((await readUsableConnection(memberA, connection.id))?.connectedForMe).toBe(false);
  expect((await readUsableConnection(memberB, connection.id))?.connectedForMe).toBe(false);

  // ── Member A connects their own account ──────────────────────────────
  await using appA = await app({
    den,
    as: "a",
    place,
    host: sandboxA ? daytonaSandbox(sandboxA) : undefined,
  });
  if (sandboxA) expect(appA.handle.sandboxId).toBe(sandboxA);
  await openConnectionsSurface(appA, appA.workspaceId);
  await waitForConnectionCard(appA, connection.name, appA.workspaceId);
  await waitForText(appA, "NEEDS YOUR SIGN-IN", { timeoutMs: 60_000 });
  await openConnectionDetail(appA, connection.name);
  await waitForText(appA, "OAuth required", { timeoutMs: 30_000 });
  await revealText(appA, "Connect your account");
  {
    const shot = await screenshot(appA);
    const seen = await validate(shot, [
      "An organization connection detail is visible saying the person must connect their own account",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const aClickedAt = new Date().toISOString();
  await clickButton(appA, "Connect your account");
  await conn.authorizeRequestSince(aClickedAt);
  await waitForText(appA, "Connected with your own account.", { timeoutMs: 120_000 });
  await expect.poll(
    async () => (await readUsableConnection(memberA, connection.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);
  await revealText(appA, "Connected with your own account.");
  {
    const shot = await screenshot(appA);
    const seen = await validate(shot, [
      "The connection detail visibly says the person is connected with their own account",
      "No Connect your account action or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // ── THE ISOLATION ASSERTION — why two desktops exist ─────────────────
  await using appB = await app({
    den,
    as: "b",
    place,
    host: sandboxB ? daytonaSandbox(sandboxB) : undefined,
  });
  if (sandboxB) expect(appB.handle.sandboxId).toBe(sandboxB);
  await openConnectionsSurface(appB, appB.workspaceId);
  await waitForConnectionCard(appB, connection.name, appB.workspaceId);
  // A is connected. B must NOT have inherited A's credential.
  await waitForText(appB, "NEEDS YOUR SIGN-IN", { timeoutMs: 60_000 });
  expect((await readUsableConnection(memberB, connection.id))?.connectedForMe).toBe(false);
  expect((await readUsableConnection(memberA, connection.id))?.connectedForMe).toBe(true);
  await revealText(appB, "NEEDS YOUR SIGN-IN");
  {
    const shot = await screenshot(appB);
    const seen = await validate(shot, [
      "A second person's app still shows the organization connection needing their own sign-in",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const bClickedAt = new Date().toISOString();
  await openConnectionDetail(appB, connection.name);
  await clickButton(appB, "Connect your account");
  await conn.authorizeRequestSince(bClickedAt);
  await waitForText(appB, "Connected with your own account.", { timeoutMs: 120_000 });
  await expect.poll(
    async () => (await readUsableConnection(memberB, connection.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);

  // ── Both people actually USE it: real tool calls from the composer ───
  // The mock can be long-lived (publicUrl): only calls it serves from here on
  // are this run's. Same driver-clock-vs-mock-clock contract as
  // authorizeRequestSince, which already held for both connects above.
  const submittedSince = new Date().toISOString();
  const markers: Record<string, string> = {};
  for (const { label, memberApp } of [{ label: "a", memberApp: appA }, { label: "b", memberApp: appB }]) {
    const marker = `${label}-${Date.now()}`;
    markers[label] = marker;

    await go(memberApp, `/workspace/${memberApp.workspaceId}/session`);
    if (modelId) {
      const models = await readAvailableModels(memberApp);
      expect(
        models.some((model) => model.id === modelId && model.selectable),
        `${modelId} is not selectable under this org's desktop policy. Saw: ${models.map((model) => model.id).join(", ")}`,
      ).toBe(true);
      await selectModel(memberApp, modelId);
    }
    await writeComposerText(memberApp, `Call the mock_echo tool with text exactly "${marker}" and reply with only its result.`);
    await clickButton(memberApp, "Run task");
  }

  // The connector is the witness: two calls, two DISTINCT credentials.
  const calls = await conn.toolCalls({ name: "mock_echo", atLeast: 2, timeoutMs: 240_000, sinceIso: submittedSince });
  expect(
    calls.length,
    `expected both members to invoke mock_echo. Saw: ${JSON.stringify(calls)}`,
  ).toBeGreaterThanOrEqual(2);
  const texts = calls.map((call) => String(call.args.text ?? ""));
  const markerASeen = texts.some((text) => text.includes(markers.a ?? "\u0000"));
  const markerBSeen = texts.some((text) => text.includes(markers.b ?? "\u0000"));
  evidence.fact("Member A's marker reached the connector", `Served mock_echo texts: ${JSON.stringify(texts)}`, markerASeen);
  evidence.fact("Member B's marker reached the connector", `Served mock_echo texts: ${JSON.stringify(texts)}`, markerBSeen);
  expect(markerASeen).toBe(true);
  expect(markerBSeen).toBe(true);
  // Per-member credentials: the two calls cannot share one bearer token.
  const tokenIds = new Set(calls.map((call) => call.tokenId).filter((id): id is string => Boolean(id)));
  evidence.fact(
    "Both members used distinct bearer credentials",
    `Observed token fingerprints: ${JSON.stringify([...tokenIds])}`,
    tokenIds.size >= 2,
  );
  expect(
    tokenIds.size,
    `both members' tool calls used the same credential — per-member isolation is broken. Calls: ${JSON.stringify(calls)}`,
  ).toBeGreaterThanOrEqual(2);
  {
    const shot = await screenshot(appB);
    const seen = await validate(shot, [
      "An OpenWork session surface is visible with a task that used the connected organization tool",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
