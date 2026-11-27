import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudCodingOverview, CloudCodingPushApproval } from "@openwork/types/den/cloud-coding";
import type { DynamicToolUIPart } from "ai";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { QueryClient, QueryClientProvider, notifyManager, timeoutManager } = await import("@tanstack/react-query");
const { CloudCodingApprovalDock, useCloudCodingApprovals } = await import("../src/react-app/domains/cloud-coding/cloud-coding-approval-dock");
const { CloudCodingConnectionCard } = await import("../src/react-app/domains/cloud-coding/cloud-coding-connection-card");
const { PushApprovalPanel } = await import("../src/react-app/domains/cloud-coding/push-approval-panel");
const { connectionFromChatToolPart } = await import("../src/components/tools/error-attribution");
const { nativeChatConnectionDecision } = await import("../src/react-app/domains/session/surface/mcp-chat-reconnect");

const first: CloudCodingPushApproval = {
  id: "approval-one", taskId: "task-one", status: "pending", repositoryFullName: "acme/storefront",
  branch: "improve-checkout", baseBranch: "main", headSha: "a".repeat(40), title: "Improve checkout",
  files: [{ path: "src/checkout.ts", change: "modified" }], fileCount: 3,
  tests: { status: "passed", command: "pnpm test", summary: "Checkout tests passed" },
  requestedAt: "2026-11-27T12:00:00Z", expiresAt: "2026-11-28T12:00:00Z", decidedAt: null, pullRequest: null,
};
const second: CloudCodingPushApproval = { ...first, id: "approval-two", repositoryFullName: "acme/billing-api", requestedAt: "2026-11-27T13:00:00Z" };
const opened: CloudCodingPushApproval = { ...first, status: "pushed", pullRequest: { number: 42, url: "https://github.com/acme/storefront/pull/42", state: "open" } };

let root: Root;
let host: HTMLDivElement;
let queryClient: InstanceType<typeof QueryClient>;
const nativeTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
let clock = 0;
let timerId = 0;
const timers = new Map<number, { at: number; run: () => void; repeat?: number }>();
function schedule(run: () => void, delay: number, repeat?: number) {
  const id = ++timerId;
  timers.set(id, { at: clock + delay, run, repeat });
  return id;
}
function cancel(id: unknown) { if (typeof id === "number") timers.delete(id); }
async function tick(milliseconds: number) {
  const end = clock + milliseconds;
  while (true) {
    const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    const [id, timer] = next;
    clock = timer.at;
    if (timer.repeat === undefined) timers.delete(id);
    else timer.at += timer.repeat;
    await act(async () => { timer.run(); });
  }
  clock = end;
}

beforeAll(() => {
  timeoutManager.setTimeoutProvider({
    setTimeout: (run, delay = 0) => schedule(run, delay), clearTimeout: cancel,
    setInterval: (run, delay = 0) => schedule(run, delay, delay), clearInterval: cancel,
  });
  notifyManager.setScheduler(callback => { queueMicrotask(callback); });
});
beforeEach(() => {
  clock = 0;
  timers.clear();
  spyOn(Date, "now").mockImplementation(() => 1_796_000_000_000 + clock);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  root = createRoot(host);
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
  spyOn(Date, "now").mockRestore();
});
afterAll(async () => {
  timeoutManager.setTimeoutProvider(nativeTimers);
  notifyManager.setScheduler(callback => { setTimeout(callback, 0); });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function render(node: ReactNode) { await act(async () => root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)); }
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing button: ${label}: ${host.textContent}`);
  return result;
}
async function click(label: string) { await act(async () => button(label).click()); }

function denFixture() {
  let pending = [first];
  let status: CloudCodingPushApproval = { ...first, status: "approved" };
  const choices: string[] = [];
  const trackUse = mock(() => {});
  let failure = false;
  const scope = {
    denBaseUrl: "https://den.example.test", organizationId: "acme", principal: "maya",
    client: {
      listCloudCodingApprovals: mock(async () => pending),
      getCloudCodingApproval: mock(async () => status),
      decideCloudCodingApproval: mock(async (_orgId: string, approvalId: string, choice: "allow_once" | "deny"): Promise<CloudCodingPushApproval> => {
        choices.push(choice);
        if (failure) throw new Error("Request failed");
        const selected = pending.find(item => item.id === approvalId) ?? first;
        pending = pending.filter(item => item.id !== approvalId);
        return { ...selected, status: choice === "deny" ? "denied" : "approved" };
      }),
    },
  };
  const openPullRequest = mock(async (_url: string) => {});
  function Harness() {
    const dock = useCloudCodingApprovals(scope, true, trackUse);
    return dock.approval ? <PushApprovalPanel {...dock} approval={dock.approval} onOpenPullRequest={openPullRequest} /> : null;
  }
  return { Harness, scope, choices, trackUse, openPullRequest, setPending: (next: CloudCodingPushApproval[]) => { pending = next; },
    setStatus: (next: CloudCodingPushApproval) => { status = next; }, fail: (value: boolean) => { failure = value; } };
}

test("the panel names the push risk and has two actions and two collapsed disclosures", () => {
  const html = renderToStaticMarkup(<PushApprovalPanel approval={first} phase="pending" count={2} decide={() => {}} dismiss={() => {}} onOpenPullRequest={async () => {}} />);
  for (const label of ["Push to acme/storefront?", "New branch", "improve-checkout", "3 files changed", "Tests passed", "Nothing has been sent to GitHub yet.", "Files changed", "Test result", "and 2 more", "1 of 2", "src/checkout.ts", "Changed", "pnpm test", "Checkout tests passed", "ext-github.svg", "Deny", "Allow once"]) expect(html).toContain(label);
  expect(html.match(/<button\b/g)).toHaveLength(2);
  expect(html.match(/<details\b/g)).toHaveLength(2);
  expect(html).not.toMatch(/<details[^>]*\bopen(?:[\s=>]|$)/);
  expect(html).not.toContain("Always");
});

test("singular file, failed tests and tests not run", () => {
  const markup = (status: CloudCodingPushApproval["tests"]["status"]) => renderToStaticMarkup(<PushApprovalPanel phase="pending"
    approval={{ ...first, fileCount: 1, tests: { status, command: null, summary: null } }} decide={() => {}} dismiss={() => {}} onOpenPullRequest={async () => {}} />);
  expect(markup("failed")).toContain("1 file changed");
  expect(markup("failed")).toContain('class="text-destructive">Tests failed');
  expect(markup("not_run")).toContain("Tests not run");
  expect(markup("not_run")).not.toContain("Test result");
});

test("only the oldest request shows, and Allow once becomes a pull request link after polling", async () => {
  const f = denFixture();
  f.setPending([second, first]);
  await render(<f.Harness />);
  expect(host.textContent).toContain("1 of 2");
  expect(host.textContent).toContain("Push to acme/storefront?");
  expect(host.textContent).not.toContain("acme/billing-api");
  await click("Allow once");
  expect(f.choices).toEqual(["allow_once"]);
  expect(f.trackUse).toHaveBeenCalledWith("cloudCoding");
  expect(host.textContent).toContain("Allowed. Pushing improve-checkout…");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  await tick(2_999);
  expect(f.scope.client.getCloudCodingApproval).not.toHaveBeenCalled();
  await tick(1);
  expect(f.scope.client.getCloudCodingApproval).toHaveBeenCalledTimes(1);
  f.setStatus(opened);
  await tick(3_000);
  expect(host.textContent).toContain("Pull request opened · acme/storefront #42");
  await click("Open pull request");
  expect(f.openPullRequest).toHaveBeenCalledWith(opened.pullRequest?.url);
  await click("Dismiss");
  expect(host.textContent).toContain("Push to acme/billing-api?");
});

test("Deny sets a quiet result with no status polling", async () => {
  const f = denFixture();
  await render(<f.Harness />);
  await click("Deny");
  expect(f.choices).toEqual(["deny"]);
  expect(host.textContent).toBe("Denied. Nothing was pushed.");
  await tick(6_000);
  expect(f.scope.client.getCloudCodingApproval).not.toHaveBeenCalled();
  await click("Dismiss");
  expect(host.textContent).toBe("");
});

test("failed decision keeps the request and retries the same choice", async () => {
  const f = denFixture();
  f.fail(true);
  await render(<f.Harness />);
  await click("Deny");
  expect(host.textContent).toContain("Push to acme/storefront?");
  expect(host.textContent).toContain("Couldn't save your answer.");
  f.fail(false);
  await click("Try again");
  expect(f.choices).toEqual(["deny", "deny"]);
  expect(host.textContent).toBe("Denied. Nothing was pushed.");
});

test("a vanished approval disappears on the next list poll without deciding", async () => {
  const f = denFixture();
  await render(<CloudCodingApprovalDock scope={f.scope} active completedAt={0} />);
  expect(host.textContent).toContain("Push to acme/storefront?");
  f.setPending([]);
  await tick(5_000);
  expect(host.textContent).toBe("");
  expect(f.choices).toHaveLength(0);
});

test("a completed turn refreshes approvals without waiting for the next poll", async () => {
  const f = denFixture();
  f.setPending([]);
  await render(<CloudCodingApprovalDock scope={f.scope} active completedAt={0} />);
  expect(host.textContent).toBe("");
  f.setPending([second]);
  await render(<CloudCodingApprovalDock scope={f.scope} active completedAt={Date.now() + 1} />);
  expect(host.textContent).toContain("Push to acme/billing-api?");
  expect(f.scope.client.listCloudCodingApprovals).toHaveBeenCalledTimes(2);
});

test("flag off and inactive chat render no dock and perform no approval fetch", async () => {
  const f = denFixture();
  await render(<CloudCodingApprovalDock scope={null} active completedAt={Date.now()} />);
  await tick(5_000);
  expect(host.innerHTML).toBe("");
  await render(<CloudCodingApprovalDock scope={f.scope} active={false} completedAt={Date.now()} />);
  await tick(5_000);
  expect(host.innerHTML).toBe("");
  expect(f.scope.client.listCloudCodingApprovals).not.toHaveBeenCalled();
  expect(f.scope.client.getCloudCodingApproval).not.toHaveBeenCalled();
});

test("expired push shows an inline recovery line and stops polling", async () => {
  const f = denFixture();
  f.setStatus({ ...first, status: "expired" });
  await render(<f.Harness />);
  await click("Allow once");
  await tick(3_000);
  expect(host.textContent).toContain("The push didn't finish. Ask OpenWork to try again.");
  await tick(15_000);
  expect(f.scope.client.getCloudCodingApproval).toHaveBeenCalledTimes(1);
});

test("status polling times out even if a status request never settles", async () => {
  const f = denFixture();
  f.scope.client.getCloudCodingApproval.mockImplementation(() => new Promise(() => {}));
  await render(<f.Harness />);
  await click("Allow once");
  await tick(299_900);
  expect(host.textContent).toContain("Allowed. Pushing improve-checkout…");
  await tick(100);
  expect(host.textContent).toContain("The push didn't finish. Ask OpenWork to try again.");
  expect(f.scope.client.getCloudCodingApproval).toHaveBeenCalledTimes(1);
});

const overview: CloudCodingOverview = { configured: true, canManage: false, connection: null, enabled: true,
  access: { orgWide: true, teamIds: [], memberIds: [] }, repositories: [], people: [], pullRequests: [], me: { memberId: "maya", canUse: false, github: null } };
function roleFixture(canManage: boolean) {
  const ask = mock(async (_orgId: string) => ({ sent: true } as const));
  const openUrl = mock(async (_url: string) => {});
  const scope = { denBaseUrl: "https://den.example.test/", organizationId: "acme", principal: "maya",
    client: { getCloudCodingOverview: async () => ({ ...overview, canManage }), requestCloudCodingAdmin: ask } };
  return { ask, openUrl, card: <CloudCodingConnectionCard scope={scope} dismiss={() => {}} fallback={null} openUrl={openUrl} /> };
}

test("a connection manager opens the configured Cloud coding dashboard", async () => {
  const f = roleFixture(true);
  await render(f.card);
  expect(host.textContent).toContain("Connect GitHub to continue");
  await click("Connect GitHub");
  expect(f.openUrl).toHaveBeenCalledWith("https://den.example.test/dashboard/cloud-coding");
  expect(f.ask).not.toHaveBeenCalled();
});

test("a member sees the locked state and can ask their admins", async () => {
  const f = roleFixture(false);
  await render(f.card);
  expect(host.textContent).toContain("An admin needs to connect GitHub first.");
  expect(button("Dismiss")).toBeDefined();
  await click("Ask an admin");
  expect(f.ask).toHaveBeenCalledWith("acme");
  expect(host.textContent).toContain("Asked your admins");
  expect(host.textContent).not.toContain("Ask an admin");
});

test("Cloud coding member link uses the existing inline action and native question", () => {
  const connectionId = "github-cloud-coding";
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call-one", input: {}, state: "output-available", output: {
    version: 1, kind: "connection_action", source: "openwork-cloud", connectionId, connectionName: "GitHub", actor: "member", authType: "oauth",
    credentialMode: "per_member", state: "needs_connection", action: { type: "connect", surface: "openwork_your_connections", retry: "search_capabilities" },
  } };
  expect(connectionFromChatToolPart(part)?.action).toMatchObject({ connectionId, label: "Connect" });
  expect(nativeChatConnectionDecision({ owner: "chat", sessionId: "chat", messages: [
    { id: "turn", role: "user", parts: [{ type: "text", text: "Improve checkout" }] },
    { id: "answer", role: "assistant", parts: [part] },
  ], question: { id: "question", questions: [{ header: "Connection", question: "Connect GitHub to continue?", options: [{ label: "Authenticate" }, { label: "Skip" }], multiple: false }] } })).toMatchObject({ connectionId, toolCallId: "call-one" });
});
