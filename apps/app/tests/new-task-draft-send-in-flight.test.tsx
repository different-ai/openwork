/** @jsxImportSource react */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NewTaskComposerContext } from "../src/react-app/domains/session/chat/new-task-composer";

const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";

// The real hero and NewTaskComposer run; only the Lexical editor is replaced by
// a textarea so keystrokes and Run task can be driven under happy-dom. The
// stub calls the same `onDraftChange` / `onSend` props Lexical would.
type EditorStubProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  submissionPreparing: boolean;
};
function ReactSessionComposer(props: EditorStubProps) {
  return (
    <div>
      <textarea
        data-testid="composer"
        value={props.draft}
        // happy-dom never reaches React's onChange; onInput does.
        onInput={(event) => props.onDraftChange(event.currentTarget.value)}
        readOnly
      />
      <button type="button" aria-label="Run task" disabled={props.submissionPreparing} onClick={props.onSend}>
        Run task
      </button>
    </div>
  );
}
mock.module("../src/react-app/domains/session/surface/composer/composer", () => ({ ReactSessionComposer }));

beforeAll(() => {
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
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
        onRunTask={() => {
          creations += 1;
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

    // #4796: an unsent prompt is persisted so it survives navigation.
    await type("Summarize the deploy checklist");
    expect(composer().value).toBe("Summarize the deploy checklist");
    expect(slot()).toBe("Summarize the deploy checklist");

    // Send: the composer clears and session creation is pending.
    await runTask();
    expect(creations).toBe(1);
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
