import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });

mock.module("../src/react-app/domains/session/surface/composer/use-native-dictation-feature", () => ({
  useNativeDictationFeature: () => false,
}));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/react-app/domains/connections/use-org-mcp-connections", () => ({
  useOrgMcpConnections: () => ({ connections: [], loading: false, refresh: () => {} }),
}));

// The composer's import graph reaches Lexical through a cycle; load it first.
await import("lexical");
await import("@lexical/react/LexicalComposer.js");
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ReactSessionComposer } = await import("../src/react-app/domains/session/surface/composer/composer");
const { SessionReferenceProvider } = await import("../src/components/chat/session-reference-context");
const { SessionReferenceChip } = await import("../src/components/chat/composer-pill");
type Inventory = import("../src/components/chat/session-reference").SessionReferenceInventory;
type ComposerProps = Parameters<typeof ReactSessionComposer>[0];
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const settle = async () => { await act(async () => { await frame(); await frame(); await frame(); }); };

const inventories: Inventory[] = [
  {
    workspaceId: "ws_1",
    workspaceTitle: "Website",
    available: true,
    sessions: [
      { id: "ses_current", title: "Current task", time: { created: 500, updated: 500 } },
      { id: "ses_login", title: "Fix login bug", time: { created: 300, updated: 300 } },
      { id: "ses_pricing", title: "Pricing page", time: { created: 200, updated: 200 } },
    ],
  },
  { workspaceId: "ws_private", workspaceTitle: "Private", available: false, sessions: [{ id: "ses_secret", title: "Login secrets" }] },
];

const noop = () => {};
const asyncEmpty = async () => [];

function composerProps(draft: string, onDraftChange: (value: string) => void, onSend: () => void): ComposerProps {
  return {
    draft,
    mentions: {},
    onDraftChange,
    onSend,
    onSteer: noop,
    onQueue: noop,
    onStop: noop,
    busy: false,
    steering: false,
    submissionPreparing: false,
    queuedCount: 0,
    disabled: false,
    statusLabel: "",
    modelPickerOpen: false,
    selectedModel: { providerID: "openai", modelID: "gpt" },
    sessionId: "ses_current",
    onModelPickerOpenChange: noop,
    onModelChange: noop,
    attachments: [],
    onAttachFiles: noop,
    onRemoveAttachment: noop,
    attachmentsEnabled: true,
    attachmentsDisabledReason: null,
    modelVariantLabel: "",
    modelVariant: null,
    onModelVariantChange: noop,
    agentLabel: "",
    selectedAgent: null,
    listAgents: asyncEmpty,
    onSelectAgent: noop,
    listCommands: asyncEmpty,
    recentFiles: [],
    searchFiles: asyncEmpty,
    onInsertMention: noop,
    onPasteText: noop,
    onUnsupportedFileLinks: noop,
    pastedText: [],
    onExpandPastedText: noop,
    onRemovePastedText: noop,
  };
}

async function mountComposer(initial = "") {
  const host = document.createElement("div");
  document.body.append(host);
  const drafts: string[] = [];
  const opened: string[] = [];
  const sent: string[] = [];
  let current = initial;
  let setExternalDraft: (value: string) => void = () => {};
  function Harness() {
    const [draft, setDraft] = useState(initial);
    setExternalDraft = (value) => { current = value; setDraft(value); };
    return (
      <QueryClientProvider client={new QueryClient()}>
        <SessionReferenceProvider inventories={inventories} onOpenReference={(reference) => opened.push(reference.sessionId)}>
          <ReactSessionComposer {...composerProps(draft, (value) => { current = value; drafts.push(value); setDraft(value); }, () => sent.push(current))} />
        </SessionReferenceProvider>
      </QueryClientProvider>
    );
  }
  const root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
  await settle();
  const editor = host.querySelector<HTMLElement>("[contenteditable='true']");
  if (!editor) throw new Error("composer editor did not mount");
  /**
   * Type at the end of the draft. Happy DOM has no native text input, so the
   * draft is set and the editor rebuilds it with the caret at the end, which
   * runs the same caret-query path as a keystroke.
   */
  const typeText = async (_editor: HTMLElement, text: string) => {
    editor.focus();
    await act(async () => { setExternalDraft(current + text); });
    await settle();
  };
  return { host, editor, drafts, opened, sent, root, draft: () => current, typeText };
}

async function press(editor: HTMLElement, key: string) {
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

const status = () => document.querySelector<HTMLElement>("[data-composer-suggestions] [role='status']");
const options = () => [...document.querySelectorAll<HTMLElement>("[data-session-reference-menu] [role='option']")];

test("# opens the task picker, filters fuzzily, and Enter inserts a stable reference", async () => {
  const view = await mountComposer();
  await view.typeText(view.editor, "compare #");
  // Recent tasks, never the current one or tasks from an unavailable workspace.
  expect(options().map((option) => option.textContent)).toEqual([
    expect.stringContaining("Fix login bug"),
    expect.stringContaining("Pricing page"),
  ]);
  expect(options()[0]?.textContent).toContain("Website");

  await view.typeText(view.editor, "prcng");
  expect(options().map((option) => option.title)).toEqual(["Pricing page"]);

  await press(view.editor, "Enter");
  expect(view.draft()).toBe("compare [session ws_1 ses_pricing Pricing page] ");
  expect(options()).toHaveLength(0);
  expect(view.sent).toHaveLength(0);
  const chip = view.editor.querySelector<HTMLElement>("[data-session-reference-session]");
  expect(chip?.textContent).toContain("Pricing page");

  // Clicking the chip opens the referenced task.
  await act(async () => {
    chip?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    chip?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(view.opened).toEqual(["ses_pricing"]);
  await act(async () => { view.root.unmount(); });
});

test("arrow keys move through results and Escape dismisses without inserting", async () => {
  const view = await mountComposer();
  await view.typeText(view.editor, "#");
  expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  await press(view.editor, "ArrowDown");
  expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
  await press(view.editor, "ArrowDown");
  expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  await press(view.editor, "ArrowUp");
  expect(options()[1]?.getAttribute("aria-selected")).toBe("true");

  await press(view.editor, "Escape");
  expect(options()).toHaveLength(0);
  expect(view.draft()).toBe("#");
  await act(async () => { view.root.unmount(); });
});

test("Markdown headings stay plain text; a # query without a match shows a hint and Enter still sends", async () => {
  const view = await mountComposer();
  await view.typeText(view.editor, "# ");
  expect(options()).toHaveLength(0);
  expect(status()).toBeNull();
  await view.typeText(view.editor, "Notes ##");
  expect(status()).toBeNull();
  await view.typeText(view.editor, " #zzqx");
  expect(options()).toHaveLength(0);
  expect(status()?.textContent).toContain("No tasks match");
  await press(view.editor, "Enter");
  expect(view.draft()).toBe("# Notes ## #zzqx");
  expect(view.sent).toEqual(["# Notes ## #zzqx"]);
  await act(async () => { view.root.unmount(); });
});

test("task names with spaces: the list stays open through spaces and picks the matching task", async () => {
  const view = await mountComposer();
  await view.typeText(view.editor, "see #fix");
  expect(options().map((option) => option.title)).toEqual(["Fix login bug"]);
  await view.typeText(view.editor, " login");
  expect(options().map((option) => option.title)).toEqual(["Fix login bug"]);
  await view.typeText(view.editor, " bug");
  expect(options().map((option) => option.title)).toEqual(["Fix login bug"]);
  await press(view.editor, "Enter");
  expect(view.draft()).toBe("see [session ws_1 ses_login Fix login bug] ");
  expect(status()).toBeNull();
  await act(async () => { view.root.unmount(); });
});

test("after Escape the list stays closed while typing, and the next # opens it again", async () => {
  const view = await mountComposer();
  await view.typeText(view.editor, "#");
  expect(options().length).toBeGreaterThan(0);
  await press(view.editor, "Escape");
  await view.typeText(view.editor, "pri");
  expect(options()).toHaveLength(0);
  expect(status()).toBeNull();
  await view.typeText(view.editor, "cing then ");
  await view.typeText(view.editor, "#pri");
  expect(options().map((option) => option.title)).toEqual(["Pricing page"]);
  await act(async () => { view.root.unmount(); });
});

test("outside a page that can resolve tasks, # never opens the picker", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  let draft = "";
  const root = createRoot(host);
  const render = () => root.render(
    <QueryClientProvider client={new QueryClient()}>
      <ReactSessionComposer {...composerProps(draft, (value) => { draft = value; }, noop)} />
    </QueryClientProvider>,
  );
  await act(async () => { render(); });
  await settle();
  draft = "#";
  await act(async () => { render(); });
  await settle();
  expect(options()).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("a sent reference shows the current title and opens the task; a missing task is marked unavailable", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const opened: string[] = [];
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SessionReferenceProvider inventories={inventories} onOpenReference={(reference) => opened.push(reference.sessionId)}>
        {/* Saved before a rename: the chip follows the task, not the old title. */}
        <SessionReferenceChip reference={{ workspaceId: "ws_1", sessionId: "ses_login", title: "Old title" }} />
        <SessionReferenceChip reference={{ workspaceId: "ws_1", sessionId: "ses_deleted", title: "Deleted task" }} />
        <SessionReferenceChip reference={{ workspaceId: "ws_private", sessionId: "ses_secret", title: "Login secrets" }} />
      </SessionReferenceProvider>,
    );
  });
  const link = host.querySelector<HTMLAnchorElement>("a[data-session-reference]");
  expect(link?.textContent).toContain("Fix login bug");
  expect(link?.getAttribute("href")).toBe("/workspace/ws_1/session/ses_login");
  await act(async () => { link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  expect(opened).toEqual(["ses_login"]);

  expect(host.querySelectorAll("a[data-session-reference]")).toHaveLength(1);
  const unavailable = [...host.querySelectorAll<HTMLElement>("[data-composer-badge='session']")].filter((chip) => !chip.closest("a"));
  expect(unavailable.map((chip) => chip.textContent)).toEqual(["Deleted taskUnavailable", "Login secretsUnavailable"]);
  await act(async () => { root.unmount(); });
});
