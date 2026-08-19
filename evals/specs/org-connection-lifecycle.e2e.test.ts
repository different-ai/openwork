import { expect, onTestFinished, test } from "vitest";
import { createVisualEvidence, screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { startMockMcp } from "@openwork/labs";
import {
  clickButton,
  createAndSelectWorkspace,
  currentHash,
  deleteConnection,
  deleteConnectionsNamed,
  enabledButtons,
  ensureMemberSession,
  evalIn,
  go,
  readUsableConnection,
  signIn,
  signInDesktopAs,
  waitFor,
  waitForButtonGone,
  waitForText,
  createOrgConnection,
} from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = !e2eTestsEnabled
  ? "organization connection lifecycle skipped: set OPENWORK_EVAL_E2E_TESTS=1 to opt in"
  : !apiUrl
    ? "organization connection lifecycle skipped: set OPENWORK_EVAL_DEN_API_URL"
    : "member connects, reconnects, and disconnects an organization OAuth connection";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForConnectionCard(app: Surface, name: string, workspaceId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await evalIn(app, `([...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').includes(${JSON.stringify(name)})))`);
    if (found === true) return;
    const onExtensions = await evalIn(app, `window.location.hash.includes("/extensions")`).catch(() => false);
    if (onExtensions !== true) {
      await go(app, `/workspace/${workspaceId}/settings/extensions/connections`);
      await sleep(1_500);
      continue;
    }
    await evalIn(
      app,
      "window.__openworkControl.execute('extensions.refresh-marketplace', null)",
      { awaitPromise: true },
    ).catch(() => undefined);
    await evalIn(app, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => (element.textContent ?? '').trim() === 'Refresh' && !element.disabled);
      button?.click();
      return Boolean(button);
    })()`).catch(() => undefined);
    await sleep(2_000);
  }
  const seen = await evalIn(app, `({
    hash: window.location.hash,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40),
    text: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
  })`).catch(() => null);
  throw new Error(`The connection card ${name} never appeared. On screen: ${JSON.stringify(seen)}`);
}

async function revealText(app: Surface, text: string, timeoutMs = 45_000): Promise<void> {
  await waitFor(app, `(() => {
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const nodes = [...document.querySelectorAll("button, h1, h2, h3, p, span, div")];
    const node = nodes.reverse().find((element) => ((element.innerText ?? element.textContent ?? "")).toLowerCase().includes(wanted));
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    node.scrollIntoView({ block: "center" });
    return true;
  })()`, { timeoutMs, label: `visible text ${JSON.stringify(text)}` });
  await sleep(750);
}

async function openConnectionDetail(app: Surface, name: string): Promise<void> {
  const opened = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => (element.textContent ?? '').includes(${JSON.stringify(name)}) && !element.disabled);
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  expect(opened).toBe(true);
}

async function waitForNotConnected(app: Surface, name: string): Promise<void> {
  await waitFor(app, `(() => {
    const text = document.body.innerText;
    const hasConnect = [...document.querySelectorAll('button')]
      .some((element) => (element.textContent ?? '').trim() === 'Connect your account' && !element.disabled);
    return text.includes(${JSON.stringify(name)}) && text.includes('Not connected') && hasConnect;
  })()`, { timeoutMs: 60_000, label: "not connected connection detail" });
}

test.skipIf(!apiUrl || !e2eTestsEnabled)(title, async () => {
  const den = {
    apiUrl,
    webUrl: (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || apiUrl.replace("127.0.0.1", "localhost")).replace(/\/+$/, ""),
  };
  const admin = await signIn(den, {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    password: process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!",
  });
  const member = await ensureMemberSession(den, admin, {
    email: process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test",
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!",
    name: "Jordan Demo",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await using mock = await startMockMcp({
    port: Number(process.env.OPENWORK_EVAL_LIFECYCLE_MOCK_PORT ?? 3979),
    publicUrl: process.env.OPENWORK_EVAL_LIFECYCLE_MOCK_PUBLIC_URL?.trim() || undefined,
  });
  await deleteConnectionsNamed(admin, "Meeting Notes ");
  const connection = await createOrgConnection(admin, {
    name: `Meeting Notes ${Date.now()}`,
    url: `${mock.url}/mcp`,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(admin, connection.id));
  expect((await readUsableConnection(member, connection.id))?.connectedForMe).toBe(false);

  await using app = await desktop({
    name: "org-connection-lifecycle",
    bootstrap: { baseUrl: den.webUrl, apiBaseUrl: den.webUrl, requireSignin: false },
  });
  await using visualEvidence = createVisualEvidence("org-connection-lifecycle");
  // Workspace first, then the org sign-in: the signed-in org shell offers no
  // Add workspace entry, so a member's workspace exists before they connect.
  const workspacePath = `/tmp/openwork-org-connection-lifecycle-${Date.now()}`;
  await createAndSelectWorkspace(app, { path: workspacePath });
  await signInDesktopAs(app, den, member);
  const { workspaceId } = await createAndSelectWorkspace(app, { path: workspacePath });
  await go(app, `/workspace/${workspaceId}/settings/extensions/connections`);
  await waitFor(app, `window.location.hash.includes("/extensions") && document.body.innerText.includes("Library")`, {
    timeoutMs: 60_000,
    label: "extensions connections route (app canonicalises away /settings)",
  });

  await waitForConnectionCard(app, connection.name, workspaceId);
  await revealText(app, "NEEDS YOUR SIGN-IN", 30_000);
  await openConnectionDetail(app, connection.name);
  await waitForNotConnected(app, connection.name);
  await waitForText(app, "OAuth required", { timeoutMs: 30_000 });
  await revealText(app, "OAuth required");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The organization connection detail visibly says Not connected and OAuth required with a Connect your account action",
      "No generic error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  const connectClickedAt = new Date().toISOString();
  await clickButton(app, "Connect your account");
  const authorize = await mock.authorizeRequestSince(connectClickedAt);
  expect(authorize.params.get("state")).toBeTruthy();
  expect(authorize.params.get("client_id")).toBeTruthy();
  const redirectUri = authorize.params.get("redirect_uri") ?? "";
  expect(redirectUri).toContain("/v1/mcp-connections/");
  expect(redirectUri.includes("/oauth/callback") || redirectUri.includes(connection.id)).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The connection flow visibly indicates that browser authorization is in progress or required",
      "No OAuth launch error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  await waitForText(app, "Connected with your own account.", { timeoutMs: 90_000 });
  await waitForButtonGone(app, "Connect your account");
  await expect.poll(
    async () => (await readUsableConnection(member, connection.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);
  const firstConnectedAt = (await readUsableConnection(member, connection.id))?.connectedAt;
  expect(firstConnectedAt).toBeTruthy();
  if (!firstConnectedAt) throw new Error("The first OAuth connection did not record connectedAt.");
  await revealText(app, "Connected with your own account.");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The connection detail visibly says Connected with your own account",
      "Reconnect and Disconnect lifecycle actions are both visibly available",
      "No Connect your account action or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  const focused = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => (element.textContent ?? '').trim() === 'Reconnect');
    button?.scrollIntoView({ block: 'center' });
    button?.focus({ focusVisible: true });
    return Boolean(button);
  })()`);
  expect(focused).toBe(true);
  const actions = await enabledButtons(app);
  expect(actions).toContain("Reconnect");
  expect(actions).toContain("Disconnect");

  const reconnectClickedAt = new Date().toISOString();
  await clickButton(app, "Reconnect");
  await mock.authorizeRequestSince(reconnectClickedAt);
  await expect.poll(async () => {
    const current = await readUsableConnection(member, connection.id);
    return current?.connectedForMe === true && Boolean(current.connectedAt) && current.connectedAt !== firstConnectedAt;
  }, { timeout: 90_000, interval: 1_000 }).toBe(true);
  await waitForText(app, "Connected with your own account.", { timeoutMs: 90_000 });
  await revealText(app, "Connected with your own account.");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The connection visibly returns to Connected with your own account after reconnecting",
      "No reconnect error or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  await clickButton(app, "Disconnect");
  await expect.poll(
    async () => (await readUsableConnection(member, connection.id))?.connectedForMe,
    { timeout: 30_000, interval: 1_000 },
  ).toBe(false);
  await waitForNotConnected(app, connection.name);
  await waitForText(app, "Connect your account", { timeoutMs: 30_000 });
  await revealText(app, "Connect your account");
  expect(await currentHash(app)).toContain("/extensions/");
});
