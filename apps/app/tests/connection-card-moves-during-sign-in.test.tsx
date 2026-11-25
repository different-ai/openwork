/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DynamicToolUIPart } from "ai";
import type { ChatConnectionDecisionBinding, ChatConnectionDecisionResponse } from "../src/react-app/domains/session/surface/mcp-chat-reconnect";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { ConnectionCard } = await import("../src/components/chat/connection-card");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const { useChatMcpReconnectStore } = await import("../src/components/tools/mcp-reconnect-state");

const needsSignIn = {
  schemaVersion: "1", connectionId: "emc_ledger", connectionName: "Ledger", state: "needs_connection", actor: "member",
  message: "Sign in to Ledger to continue.",
  action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  authType: "oauth", credentialMode: "per_member",
};

function report(toolCallId: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool", toolCallId, toolName: "openwork-cloud_connection_status", input: { connection: "ledger" },
    state: "output-available", output: JSON.stringify(needsSignIn),
  };
}

let root: Root;
let host: HTMLDivElement;
let finishSignIn: (() => void) | null = null;
let failSignIn: ((error: Error) => void) | null = null;
let signIns = 0;
let continued: string[] = [];
let answers: ChatConnectionDecisionResponse[] = [];
let question: { toolCallId: string; pending: boolean } | null = null;

beforeEach(() => {
  useChatMcpReconnectStore.getState().reset();
  finishSignIn = null;
  failSignIn = null;
  signIns = 0;
  continued = [];
  answers = [];
  question = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function decisionFor(toolCallId: string): ChatConnectionDecisionBinding | null {
  const asked = question;
  if (!asked || asked.toolCallId !== toolCallId) return null;
  return {
    request: { requestId: "question", owner: "chat", sessionId: "session", turnId: "turn", toolCallId, connectionId: "emc_ledger" },
    isPending: () => asked.pending,
    respond: async (response) => { asked.pending = false; answers.push(response); },
  };
}

/** The transcript shows one card per connection, on the newest tool call that reported it. */
async function showCardOn(toolCallId: string) {
  await act(async () => root.render(
    <MessageListProvider workspaceId="workspace" sessionId="session" uiStateOwner="chat"
      showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
      onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
      dispatchAction={() => {}} setPrompt={() => {}}
      getConnectionDecision={decisionFor}
      continueAfterConnection={(id: string) => { continued.push(id); }}
      onMcpReconnect={async (_action, onProgress) => {
        signIns += 1;
        onProgress({ phase: "authorization_opened", authorizeUrl: "https://ledger.example/authorize" });
        await new Promise<void>((resolve, reject) => { finishSignIn = resolve; failSignIn = reject; });
        return "connected";
      }}
      onMcpReopenAuthorization={async () => {}}>
      <ConnectionCard key={toolCallId} part={report(toolCallId)} />
    </MessageListProvider>,
  ));
}

function button(label: string) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label) ?? null;
}
async function click(label: string) {
  const target = button(label);
  expect(target).not.toBeNull();
  await act(async () => target?.click());
}
const title = () => host.querySelector("[data-testid='desktop-connection-card'] p")?.textContent ?? "";

test("a sign-in started on one tool call finishes on the newer tool call the card moved to, and the chat carries on", async () => {
  await showCardOn("call_search");
  expect(title()).toBe("Connect Ledger");
  await click("Connect");
  expect(title()).toBe("Finish signing in to Ledger in your browser");

  // The agent retries while the browser is still open: the card moves to the newer report.
  await showCardOn("call_execute");
  expect(title()).toBe("Finish signing in to Ledger in your browser");
  expect(button("Connect")).toBeNull();
  await click("Open sign-in again");
  expect(signIns).toBe(1);

  await act(async () => finishSignIn?.());
  expect(title()).toBe("Ledger connected");
  expect(continued).toEqual(["call_execute"]);
});

test("a question asked after the click is answered once the sign-in lands", async () => {
  await showCardOn("call_search");
  await click("Connect");
  question = { toolCallId: "call_search", pending: true };
  await showCardOn("call_search");
  expect(title()).toBe("Finish signing in to Ledger in your browser");

  await act(async () => finishSignIn?.());
  expect(answers).toEqual([{ outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false }]);
  expect(continued).toEqual([]);
  expect(title()).toBe("Ledger connected");
});

test("a report that arrives after the sign-in settled starts from its own state", async () => {
  await showCardOn("call_search");
  await click("Connect");
  await act(async () => finishSignIn?.());
  expect(title()).toBe("Ledger connected");

  await showCardOn("call_later");
  expect(title()).toBe("Connect Ledger");
});

test("a failed sign-in shows on the card that is on screen and can be tried again", async () => {
  await showCardOn("call_search");
  await click("Connect");
  await showCardOn("call_execute");
  await act(async () => failSignIn?.(new Error("Authorization for Ledger did not finish.")));
  expect(title()).toBe("Ledger sign-in didn't finish");
  expect(continued).toEqual([]);

  await click("Try again");
  expect(signIns).toBe(2);
  await act(async () => finishSignIn?.());
  expect(title()).toBe("Ledger connected");
  expect(continued).toEqual(["call_execute"]);
});

test("skipping the question drops the sign-in in flight", async () => {
  await showCardOn("call_search");
  await click("Connect");
  question = { toolCallId: "call_search", pending: true };
  await showCardOn("call_search");
  await click("Skip");
  expect(title()).toBe("Skipped Ledger");

  await act(async () => finishSignIn?.());
  expect(title()).toBe("Skipped Ledger");
  expect(answers).toEqual([{ outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false }]);
  expect(continued).toEqual([]);
});
