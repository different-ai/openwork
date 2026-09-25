import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { ComposerDraft } from "../src/app/types";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
let observeIdle = () => {};
const syncModule = await import("../src/react-app/domains/session/sync/session-sync");

const session = { id: "rejected-session", slug: "rejected", projectID: "project", directory: "/workspace", title: "Rejected turn", version: "1", time: { created: 1, updated: 1 } };
const nativeModule = await import("../src/app/lib/opencode-session-native");

const { startGlobalQueueDrainer } = await import("../src/react-app/domains/session/sync/global-queue-drainer");
const { setQueuedSendContext, clearQueuedSendContext } = await import("../src/react-app/domains/session/sync/queued-send-context");
const { useComposerStateStore, claimComposerSessionDraftScope } = await import("../src/react-app/domains/session/surface/composer-state-store");
const { startQueuedDraftPersistence } = await import("../src/react-app/domains/session/sync/queued-draft-persistence");
const { createSessionDraftStore, rejectedTurnOwner, sessionDraftScopeKey, saveSessionDraft, cloudSessionDraftScope, getRejectedTurns } = await import("../src/react-app/domains/session/sync/draft-store");
const { mergeRejectedTurns, retainRejectedTurn } = await import("../src/react-app/domains/session/sync/rejected-turn");
const { claimQueuedSend, getQueuedDrainState, resetQueuedDrainForTests } = await import("../src/react-app/domains/session/surface/queued-drain-machine");
const { createOpenworkServerClient } = await import("../src/app/lib/openwork-server");
const { AUTO_MODEL_ID, AUTO_PROVIDER_ID } = await import("../src/react-app/domains/models/model-catalog");
const { unavailableDesktopFreeStatus } = await import("../src/app/lib/inference-access");
const { AutoAccessNotice, AutoRejectedTurnRecoveryBridge } = await import("../src/react-app/domains/cloud/auto-access-ui");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const den = await import("../src/app/lib/den");
const originalFetch = globalThis.fetch;
afterAll(async () => { mock.restore(); globalThis.fetch = originalFetch; await GlobalRegistrator.unregister(); });

const owner = rejectedTurnOwner({ draftScope: "local", denBaseUrl: "https://den.example", opencodeBaseUrl: "http://native.test/opencode", workspaceId: "rejected-workspace", sessionId: session.id, localRuntime: true });
const draft = (text: string): ComposerDraft => ({ text, resolvedText: text, parts: [{ type: "text", text }], mode: "prompt", attachments: [] });
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("Expected rejection to settle");
}

test("background Auto rejection is durable, actionable after restart and sign-in, and never resends on idle or account recovery", async () => {
  localStorage.clear();
  const boundaries = [
    spyOn(syncModule, "ensureWorkspaceSessionSync").mockImplementation((input) => {
      observeIdle = () => input.onSessionStatus?.({ sessionId: session.id, status: { type: "idle" } });
      return () => {};
    }),
    spyOn(syncModule, "trackWorkspaceSessionSync").mockImplementation(() => () => {}),
    spyOn(nativeModule, "getNativeSession").mockResolvedValue(session),
    spyOn(nativeModule, "composeNativeSessionSnapshot").mockResolvedValue({ session, messages: [], todos: [], status: { type: "idle" } }),
  ];
  resetQueuedDrainForTests();
  useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, pendingMessages: {}, failedDrafts: {} });
  const preflight = Promise.withResolvers<Response>();
  let preflights = 0;
  let sends = 0;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/anonymous-inference/preflight") { preflights++; return preflight.promise; }
    if (request.method === "POST") sends++;
    throw new Error(`Unexpected native call: ${request.method} ${new URL(request.url).pathname}`);
  });
  const client = createOpenworkServerClient({ baseUrl: "http://native.test", token: "fixture" });
  claimComposerSessionDraftScope(session.id, sessionDraftScopeKey("local", owner.workspaceId, session.id));
  saveSessionDraft("local", owner.workspaceId, session.id, { text: "newer edits", mode: "prompt" });
  const stopPersistence = startQueuedDraftPersistence();
  useComposerStateStore.getState().setDraft(session.id, "newer edits");
  useComposerStateStore.getState().appendQueuedDraft(session.id, draft("Blocked request"));
  useComposerStateStore.getState().appendQueuedDraft(session.id, draft("Do not send the follower"));
  const item = useComposerStateStore.getState().queuedDrafts[session.id][0];
  setQueuedSendContext(session.id, { workspaceId: owner.workspaceId, workspaceRoot: "/workspace", opencodeBaseUrl: "http://native.test/opencode", openworkToken: "fixture", client,
    agent: null, variant: null, model: { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID }, environmentRuntimeKey: null,
    rejectedOwner: owner, localRuntime: true, isCurrent: () => true,
  });
  const stopDrainer = startGlobalQueueDrainer();
  const rootElement = document.createElement("div"); document.body.append(rootElement);
  const root = createRoot(rootElement);
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", isSignedIn: false, user: null, verifiedIdentity: null, error: null, refresh: async () => {} });
  const settings = den.readDenSettings();
  const settingsSpy = spyOn(den, "readDenSettings").mockReturnValue({ ...settings, baseUrl: owner.denBaseUrl, activeOrgId: "org-verified" });
  try {
    await waitFor(() => preflights === 1);
    observeIdle(); observeIdle();
    expect(claimQueuedSend(session.id, item.id, true)).toBe(false);
    preflight.resolve(Response.json({ ...unavailableDesktopFreeStatus(), state: "exhausted" }));
    await waitFor(() => getQueuedDrainState(session.id).phase.kind === "halted");
    expect(preflights).toBe(1);
    expect(sends).toBe(0);
    expect(useComposerStateStore.getState().queuedDrafts[session.id].map((entry) => entry.draft.text)).toEqual(["Do not send the follower"]);
    expect(useComposerStateStore.getState().sessions[session.id].draft).toBe("newer edits");
    const restarted = createSessionDraftStore({ storage: localStorage });
    const turns = restarted.getRejected(owner);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Blocked request");
    expect(restarted.get("local", owner.workspaceId, session.id)?.queued).toEqual(["Do not send the follower"]);
    expect(mergeRejectedTurns([], turns, owner)[0]).toMatchObject({ role: "user", metadata: { unprocessed: true, autoAccessWall: { state: "limit" } } });
    await act(async () => root.render(<><AutoRejectedTurnRecoveryBridge /><AutoAccessNotice wall={turns[0].wall} sessionId={session.id} recovery={{ owner, id: turns[0].id }} /></>));
    expect(rootElement.textContent).toContain("This week’s free limit is used up");
    const signIn = [...rootElement.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Sign in to OpenWork");
    await act(async () => signIn?.click());
    expect(window.location.hash).toContain("settings/cloud-account");
    expect(useComposerStateStore.getState().queuedDrafts[session.id]).toBeUndefined();
    expect(createSessionDraftStore({ storage: localStorage }).get("local", owner.workspaceId, session.id)?.queued).toEqual(["Do not send the follower"]);
    authSpy.mockReturnValue({ status: "signed_in", isSignedIn: true, user: null, verifiedIdentity: { principalId: "member-verified", organizationId: "org-verified" }, error: null, refresh: async () => {} });
    await act(async () => root.render(<AutoRejectedTurnRecoveryBridge />));
    const memberOwner = { ...owner, scopeId: cloudSessionDraftScope({ principalId: "member-verified", organizationId: "org-verified" }) };
    expect(getRejectedTurns(memberOwner).map((turn) => turn.text)).toEqual(["Blocked request"]);
    expect(getRejectedTurns(owner)).toEqual([]);
    observeIdle(); observeIdle();
    expect(preflights).toBe(1);
    expect(sends).toBe(0);
    expect(getQueuedDrainState(session.id).phase.kind).toBe("halted");
    expect(getRejectedTurns({ ...memberOwner, scopeId: cloudSessionDraftScope({ principalId: "another-member", organizationId: "org-verified" }) })).toEqual([]);
  } finally {
    stopDrainer(); stopPersistence(); clearQueuedSendContext(session.id);
    for (const boundary of boundaries) boundary.mockRestore();
    await act(async () => root.unmount()); rootElement.remove(); authSpy.mockRestore(); settingsSpy.mockRestore();
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, pendingMessages: {}, failedDrafts: {} }); resetQueuedDrainForTests(); globalThis.fetch = originalFetch;
  }
});

test("rejected files use the existing local inbox transport and persist only file references, not inline bytes", async () => {
  localStorage.clear();
  const file = new File(["fixture private bytes"], "notes.txt", { type: "text/plain" });
  const client = createOpenworkServerClient({ baseUrl: "http://native.test", token: "fixture" });
  const upload = spyOn(client, "uploadInbox").mockImplementation(async (_workspace, input, options) => ({ ok: true, bytes: input.size, path: options?.path ?? "notes.txt" }));
  try {
    expect(await retainRejectedTurn({ owner, opencodeBaseUrl: "http://native.test/opencode", draft: { ...draft("Keep this task"), messageId: "file-rejected",
      attachments: [{ id: "file", name: file.name, mimeType: file.type, size: file.size, kind: "file", file }] }, wall: { state: "limit" }, client, workspaceRoot: "/workspace", localRuntime: true })).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    const stored = createSessionDraftStore({ storage: localStorage }).getRejected(owner);
    expect(stored[0].attachments[0].url).toStartWith("file:///workspace/.opencode/openwork/inbox/");
    expect(JSON.stringify(stored)).not.toContain("fixture private bytes");
  } finally { upload.mockRestore(); useComposerStateStore.setState({ pendingMessages: {} }); }
});
