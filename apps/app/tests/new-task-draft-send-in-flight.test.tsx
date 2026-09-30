/** @jsxImportSource react */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NewTaskComposerContext } from "../src/react-app/domains/session/chat/new-task-composer";
import type { NewSessionDestination } from "../src/react-app/domains/session/chat/new-session-destination";
import type { ComposerAttachment } from "../src/app/types";
import type { Session } from "@opencode-ai/sdk/v2/client";

const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";

// The real hero and NewTaskComposer run; only the Lexical editor is replaced by
// a textarea so keystrokes and Run task can be driven under happy-dom. The
// stub calls the same `onDraftChange` / `onSend` props Lexical would.
type EditorStubProps = {
  contextControl?: ReactNode;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  submissionPreparing: boolean;
  submissionPreparingLabel?: string;
  flush?: boolean;
  attachments: ComposerAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
};
let latestSend = () => {};
let latestEditor: EditorStubProps | null = null;
function ReactSessionComposer(props: EditorStubProps) {
  latestSend = props.onSend;
  latestEditor = props;
  return (
    <div>
      <textarea
        data-testid="composer"
        value={props.draft}
        // happy-dom never reaches React's onChange; onInput does.
        onInput={(event) => props.onDraftChange(event.currentTarget.value)}
        readOnly
      />
      <div data-composer-settings>{props.contextControl}</div>
      <button type="button" aria-label="Run task" disabled={props.submissionPreparing} onClick={props.onSend}>
        Run task
      </button>
    </div>
  );
}
mock.module("../src/react-app/domains/session/surface/composer/composer", () => ({ ReactSessionComposer }));

test("first send keeps its message and dock through creation, inline failure, retry and publication", async () => {
  const { PendingConversationView } = await import("../src/react-app/domains/session/chat/pending-conversation");
  const { beginPendingConversation, createPendingConversation, usePendingConversationStore } = await import("../src/react-app/domains/session/chat/pending-conversation-store");
  const entry = beginPendingConversation({ scope: "local", destination: { workspaceId: "pending-ui", groupId: "research" },
    submitted: { draft: "Review the report", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null } });
  function Probe() {
    const conversation = usePendingConversationStore((state) => state.conversations[entry.id]);
    return conversation ? <PendingConversationView conversation={conversation} composer={null} /> : null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const creation = Promise.withResolvers<{ session: Session }>();
  let attempts = 0;
  let published = 0;
  try {
    await act(async () => root.render(<Probe />));
    const message = container.querySelector('[data-message-role="user"]');
    const dock = container.querySelector('[data-testid="composer"]');
    expect(message?.textContent).toBe("Review the report");
    expect(dock).not.toBeNull();
    expect(latestEditor?.flush).toBe(false);
    expect(latestEditor?.submissionPreparingLabel).toBe("Send");
    expect(container.textContent).not.toMatch(/Creating|Preparing|Opening|Retry sending/);
    await act(async () => createPendingConversation(entry.id, () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("Offline")) : creation.promise;
    }, () => { published++; }));
    expect(container.querySelector('[data-message-role="user"]')).toBe(message);
    expect(container.querySelector('[data-testid="composer"]')).toBe(dock);
    expect(container.textContent).toContain("Couldn’t send your message");
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry sending"]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(container.textContent).not.toMatch(/Creating|Preparing|Opening|Retry sending/);
    expect(container.querySelector('[data-message-role="user"]')).toBe(message);
    await act(async () => { creation.resolve({ session: { id: "ses_pending_ui", slug: "pending-ui", title: "Review the report", directory: "/workspace", projectID: "project", version: "1", time: { created: 1, updated: 1 } } }); });
    expect(published).toBe(1);
    expect(attempts).toBe(2);
    expect(container.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
    expect(container.querySelector('[data-message-role="user"]')).toBe(message);
    expect(container.querySelector('[data-testid="composer"]')).toBe(dock);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    usePendingConversationStore.setState({ conversations: {} });
  }
});

beforeAll(() => {
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

test("destination control names the group, blocks cross-workspace files, and offers discard", async () => {
  const { NewTaskComposer } = await import("../src/react-app/domains/session/chat/new-task-composer");
  const { useSessionManagementStore } = await import("../src/react-app/domains/session/sidebar/session-management-store");
  useSessionManagementStore.setState({ groupsByWorkspace: { [workspaceId]: { groups: [{ id: "group-one", label: "One" }], assignments: {} } } });
  const changed: NewSessionDestination[] = [];
  const context: NewTaskComposerContext = {
    ...composerContext(),
    draftOwnerKey: "destination-control-test",
    workspaceOptions: [{ id: workspaceId, label: "Alpha" }, { id: "ws_beta", label: "Beta" }],
    onChangeDestination: (_source, destination) => { changed.push(destination); },
  };
  function Probe() {
    const [draft, setDraft] = useState("Review the draft");
    return <NewTaskComposer draft={draft} onDraftChange={setDraft} context={context} busy={false} onRunTask={() => { throw new Error("Selection must not submit"); }} />;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const chooseBeta = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Session destination"]')?.click(); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === "Beta");
    if (!item) throw new Error("Expected destination choices");
    await act(async () => item.click());
  };
  try {
    await act(async () => root.render(<Probe />));
    expect(container.querySelector('[data-composer-settings] [aria-label="Session destination"]')?.textContent).toBe("One");
    expect(container.querySelector('[aria-label="Discard draft"]')).toBeNull();
    await act(async () => latestEditor?.onAttachFiles([new File(["report"], "report.txt", { type: "text/plain" })]));
    await chooseBeta();
    expect(changed).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Remove workspace files before changing workspace.");
    const attachmentId = latestEditor?.attachments[0]?.id;
    if (!attachmentId) throw new Error("Expected the original attachment to remain removable");
    await act(async () => latestEditor?.onRemoveAttachment(attachmentId));
    await chooseBeta();
    expect(changed).toEqual([{ workspaceId: "ws_beta", parent: undefined }]);
    await act(async () => latestEditor?.onDraftChange("Discard this draft"));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Session destination"]')?.click());
    const discard = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Discard draft"));
    if (!discard) throw new Error("Expected discard in the destination menu");
    await act(async () => discard.click());
    expect(latestEditor?.draft).toBe("");
    expect(latestEditor?.attachments).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

afterAll(async () => {
  mock.restore();
  if (registeredDom) await GlobalRegistrator.unregister();
});

const workspaceId = "ws_alpha";
const draftScope = "local";

function composerContext(): NewTaskComposerContext {
  return {
    client: null,
    workspaceId,
    destination: { workspaceId, groupId: "group-one" },
    draftOwnerKey: `owner:${workspaceId}`,
    draftScope,
    selectedModel: { providerID: "test", modelID: "test-model" },
    modelPickerOpen: false,
    onModelPickerOpenChange: () => {},
    onModelChange: () => {},
    modelVariantLabel: "Default",
    modelVariant: null,
    onModelVariantChange: () => {},
    agentLabel: "OpenWork",
    selectedAgent: null,
    listAgents: async () => [],
    onSelectAgent: () => {},
    listCommands: async () => [],
    searchFiles: async () => [],
    isRemoteWorkspace: false,
    isSandboxWorkspace: false,
  };
}

test("keystrokes typed while a new-task send is in flight do not pre-fill the next New task composer", async () => {
  window.localStorage.clear();
  const [
    { SessionEmptyHero },
    { NEW_TASK_DRAFT_SESSION_ID, getSessionDraft },
    { DenAuthProvider },
    { DesktopConfigProvider },
    { LocalProvider },
    { ShellConfigProvider },
    { PlatformProvider, createDefaultPlatform },
  ] = await Promise.all([
    import("../src/react-app/domains/session/chat/session-empty-hero"),
    import("../src/react-app/domains/session/sync/draft-store"),
    import("../src/react-app/domains/cloud/den-auth-provider"),
    import("../src/react-app/domains/cloud/desktop-config-provider"),
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/shell/shell-config"),
    import("../src/react-app/kernel/platform"),
  ]);
  const slot = () => getSessionDraft(draftScope, workspaceId, NEW_TASK_DRAFT_SESSION_ID)?.text ?? null;

  // The route owns this: it shows the hero while there is no session and
  // swaps to the created session's surface once its route lands.
  let creation = Promise.withResolvers<void>();
  let creations = 0;
  const destinations: (NewSessionDestination | undefined)[] = [];
  let setRouteState = (_state: "hero" | "session") => {};
  function Route() {
    const [state, setState] = useState<"hero" | "session">("hero");
    setRouteState = setState;
    if (state === "session") return <div data-testid="session-surface" />;
    return (
      <SessionEmptyHero
        key={composerContext().draftOwnerKey}
        providerCount={1}
        composer={composerContext()}
        onRunTask={(_prompt, _attachments, handoff) => {
          creations += 1;
          destinations.push(handoff?.destination);
          return creation.promise;
        }}
      />
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const tree = (
    <PlatformProvider value={createDefaultPlatform()}>
      <DenAuthProvider>
        <DesktopConfigProvider>
          <LocalProvider>
            <ShellConfigProvider>
              <Route />
            </ShellConfigProvider>
          </LocalProvider>
        </DesktopConfigProvider>
      </DenAuthProvider>
    </PlatformProvider>
  );
  const composer = () => {
    const node = container.querySelector<HTMLTextAreaElement>('[data-testid="composer"]');
    if (!node) throw new Error("Expected the new-task composer");
    return node;
  };
  const type = async (text: string) => {
    await act(async () => {
      const node = composer();
      // React reads the DOM value on change; mirror what a keystroke leaves behind.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(node, text);
      node.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
  };
  const runTask = async () => {
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');
      if (!button || button.disabled) throw new Error("Expected an enabled Run task button");
      button.click();
    });
  };

  try {
    await act(async () => root.render(tree));
    expect(container.querySelector("h2")?.textContent).toBe("What do you need done?");
    expect(container.textContent).not.toContain("Describe it in plain language");

    // #4796: an unsent prompt is persisted so it survives navigation.
    await type("Summarize the deploy checklist");
    expect(composer().value).toBe("Summarize the deploy checklist");
    expect(slot()).toBe("Summarize the deploy checklist");

    // Send: the composer clears and session creation is pending.
    await runTask();
    await act(async () => { latestSend(); latestSend(); });
    expect(creations).toBe(1);
    expect(destinations).toEqual([{ workspaceId, groupId: "group-one" }]);
    expect(composer().value).toBe("");
    expect(slot()).toBeNull();

    // Typing while creation is pending belongs to the created session (it is
    // carried over as the continuation), not to the workspace's new-task slot.
    await type("and also check the rollback plan");
    expect(composer().value).toBe("and also check the rollback plan");

    // The created session's route lands and the hero unmounts.
    await act(async () => creation.resolve());
    await act(async () => setRouteState("session"));
    expect(container.querySelector('[data-testid="session-surface"]')).not.toBeNull();

    // Opening New task again must show an empty composer; the slot that feeds
    // the sidebar Draft row must be empty too.
    await act(async () => setRouteState("hero"));
    expect(composer().value).toBe("");
    expect(slot()).toBeNull();

    // A failed send keeps #4796's promise: whatever is in the composer is
    // once again the unsent new-task prompt and stays reachable.
    creation = Promise.withResolvers<void>();
    await type("Retry this one");
    expect(slot()).toBe("Retry this one");
    await runTask();
    expect(creations).toBe(2);
    expect(slot()).toBeNull();
    await type("typed during the failing send");
    expect(slot()).toBeNull();
    await act(async () => creation.reject(new Error("Session creation failed")));
    expect(composer().value).toBe("typed during the failing send");
    expect(slot()).toBe("typed during the failing send");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("consumed first send leaves the editor for pending recovery and cannot resurrect or erase a newer draft", async () => {
  const { NewTaskComposer } = await import("../src/react-app/domains/session/chat/new-task-composer");
  const { PendingConversationView } = await import("../src/react-app/domains/session/chat/pending-conversation");
  const { beginPendingConversation, createPendingConversation, usePendingConversationStore } = await import("../src/react-app/domains/session/chat/pending-conversation-store");
  const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { getSessionDraft, saveSessionDraft, NEW_TASK_DRAFT_SESSION_ID } = await import("../src/react-app/domains/session/sync/draft-store");
  const { markComposerAutoSend, consumeComposerAutoSendPayload } = await import("../src/react-app/domains/session/surface/composer-auto-send");
  const ownerKey = "pending-source-regression";
  const workspaceId = "pending-workspace";
  const context: NewTaskComposerContext = { ...composerContext(), workspaceId, draftOwnerKey: ownerKey, draftSessionId: NEW_TASK_DRAFT_SESSION_ID, destination: { workspaceId } };
  let creation = Promise.withResolvers<{ session: Session }>();
  let creationTask = Promise.resolve();
  let creates = 0;
  let openNewDraft = () => {};
  const session: Session = { id: "ses_pending_created", slug: "created", title: "Created", directory: "/workspace", projectID: "project", version: "1", time: { created: 1, updated: 1 } };
  function Editor({ onSubmitted }: { onSubmitted: (id: string) => void }) {
    const [draft, setDraft] = useState("");
    return <NewTaskComposer draft={draft} context={context} busy={false} onDraftChange={(value) => {
      setDraft(value);
      saveSessionDraft("local", workspaceId, NEW_TASK_DRAFT_SESSION_ID, { text: value, mode: "prompt" });
    }} onRunTask={(_prompt, _attachments, handoff) => {
      if (!handoff?.consume) throw new Error("Expected an ownership-transfer callback");
      const entry = beginPendingConversation({ scope: "local", destination: { workspaceId }, submitted: handoff.submitted });
      handoff.consume();
      onSubmitted(entry.id);
      creationTask = createPendingConversation(entry.id, () => { creates++; return creation.promise; }, ({ session }) => {
        markComposerAutoSend(session.id, { scopeKey: ownerKey, composer: entry.submitted });
      });
    }} />;
  }
  function Route() {
    const [id, setId] = useState<string | null>(null);
    openNewDraft = () => setId(null);
    const entries = usePendingConversationStore((state) => state.conversations);
    const entry = id ? entries[id] : undefined;
    return entry ? entry.sessionId ? <div data-real-session={entry.sessionId} /> : <PendingConversationView conversation={entry} composer={context} /> : <Editor onSubmitted={setId} />;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Route />));
    await act(async () => latestEditor?.onDraftChange("Original message"));
    const file = new File(["file content"], "report.txt", { type: "text/plain" });
    await act(async () => latestEditor?.onAttachFiles([file]));
    const staleFlush = latestEditor?.onDraftChange;
    await act(async () => { latestSend(); latestSend(); });
    expect(creates).toBe(1);
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("[data-pending-conversation]")).not.toBeNull();
    expect(container.textContent).toContain("Original message");
    expect(container.textContent).toContain("report.txt");
    expect(container.textContent).not.toMatch(/Creating|Preparing|Message not sent/);
    expect(useComposerStateStore.getState().sessions[ownerKey]).toBeUndefined();
    expect(getSessionDraft("local", workspaceId, NEW_TASK_DRAFT_SESSION_ID)).toBeNull();
    await act(async () => staleFlush?.("stale unmount flush"));
    expect(useComposerStateStore.getState().sessions[ownerKey]).toBeUndefined();
    expect(getSessionDraft("local", workspaceId, NEW_TASK_DRAFT_SESSION_ID)).toBeNull();
    await act(async () => { creation.reject(new Error("Engine unavailable")); await creationTask; });
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t send your message");
    creation = Promise.withResolvers<{ session: Session }>();
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry sending"]');
    if (!retry) throw new Error("Expected pending-conversation retry");
    await act(async () => { retry.click(); retry.click(); });
    expect(creates).toBe(2);
    await act(async () => openNewDraft());
    await act(async () => latestEditor?.onDraftChange("Newer draft in the same destination"));
    await act(async () => staleFlush?.("obsolete source"));
    await act(async () => { creation.resolve({ session }); await creation.promise; });
    expect(container.querySelector("[data-real-session]")).toBeNull();
    expect(latestEditor?.draft).toBe("Newer draft in the same destination");
    expect(useComposerStateStore.getState().sessions[ownerKey]?.draft).toBe("Newer draft in the same destination");
    expect(getSessionDraft("local", workspaceId, NEW_TASK_DRAFT_SESSION_ID)?.text).toBe("Newer draft in the same destination");
    expect(consumeComposerAutoSendPayload(session.id, ownerKey)?.composer.attachments[0]?.file).toBe(file);
    expect(consumeComposerAutoSendPayload(session.id, ownerKey)).toBeNull();
    expect(creates).toBe(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
