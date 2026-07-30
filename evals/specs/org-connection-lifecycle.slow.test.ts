import { expect, onTestFinished, test } from "vitest";
import { attachSurface } from "@openwork/cdp";
import { fraimz } from "@openwork/fraimz";
import { startMockMcp } from "@openwork/labs";
import {
  clickButton,
  currentHash,
  deleteConnection,
  deleteConnectionsNamed,
  enabledButtons,
  ensureFreshWorkspace,
  ensureMemberSession,
  evalIn,
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
const cdpUrl = process.env.OPENWORK_EVAL_CDP_URL?.trim() ?? "";
const title = !apiUrl
  ? "organization connection lifecycle skipped: set OPENWORK_EVAL_DEN_API_URL"
  : !cdpUrl
    ? "organization connection lifecycle skipped: set OPENWORK_EVAL_CDP_URL"
    : "member connects, reconnects, and disconnects an organization OAuth connection";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForConnectionCard(app: Surface, name: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = await evalIn(app, `([...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').includes(${JSON.stringify(name)})))`);
    if (found === true) return;
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
  throw new Error(`Connection card did not render: ${name}`);
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

test.skipIf(!apiUrl || !cdpUrl)(title, async ({ annotate }) => {
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

  await using app = await attachSurface({
    name: "running-app",
    kind: "electron",
    hostKind: "attached",
    cdpUrl,
  });
  await signInDesktopAs(app, den, member);
  await ensureFreshWorkspace(app, { path: `/tmp/openwork-org-connection-lifecycle-${Date.now()}` });
  const frame = fraimz((message, attachment) => annotate(message, typeof attachment === "string" ? attachment : undefined));

  await waitForConnectionCard(app, connection.name);
  await waitForText(app, "NEEDS YOUR SIGN-IN", { timeoutMs: 30_000 });
  await openConnectionDetail(app, connection.name);
  await waitForNotConnected(app, connection.name);
  await waitForText(app, "OAuth required", { timeoutMs: 30_000 });
  await frame(app, "lifecycle-1-needs-signin");

  const connectClickedAt = new Date().toISOString();
  await clickButton(app, "Connect your account");
  const authorize = await mock.authorizeRequestSince(connectClickedAt);
  expect(authorize.params.get("state")).toBeTruthy();
  expect(authorize.params.get("client_id")).toBeTruthy();
  const redirectUri = authorize.params.get("redirect_uri") ?? "";
  expect(redirectUri).toContain("/v1/mcp-connections/");
  expect(redirectUri.includes("/oauth/callback") || redirectUri.includes(connection.id)).toBe(true);
  await frame(app, "lifecycle-2-browser-handoff");

  await waitForText(app, "Connected with your own account.", { timeoutMs: 90_000 });
  await waitForButtonGone(app, "Connect your account");
  await expect.poll(
    async () => (await readUsableConnection(member, connection.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);
  const firstConnectedAt = (await readUsableConnection(member, connection.id))?.connectedAt;
  expect(firstConnectedAt).toBeTruthy();
  if (!firstConnectedAt) throw new Error("The first OAuth connection did not record connectedAt.");
  await frame(app, "lifecycle-3-connected");

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
  await frame(app, "lifecycle-4-lifecycle-actions");

  const reconnectClickedAt = new Date().toISOString();
  await clickButton(app, "Reconnect");
  await mock.authorizeRequestSince(reconnectClickedAt);
  await expect.poll(async () => {
    const current = await readUsableConnection(member, connection.id);
    return current?.connectedForMe === true && Boolean(current.connectedAt) && current.connectedAt !== firstConnectedAt;
  }, { timeout: 90_000, interval: 1_000 }).toBe(true);
  await waitForText(app, "Connected with your own account.", { timeoutMs: 90_000 });
  await frame(app, "lifecycle-5-reconnected");

  await clickButton(app, "Disconnect");
  await expect.poll(
    async () => (await readUsableConnection(member, connection.id))?.connectedForMe,
    { timeout: 30_000, interval: 1_000 },
  ).toBe(false);
  await waitForNotConnected(app, connection.name);
  await waitForText(app, "Connect your account", { timeoutMs: 30_000 });
  expect(await currentHash(app)).toContain("/settings/extensions/");
  await frame(app, "lifecycle-6-disconnected");
});
