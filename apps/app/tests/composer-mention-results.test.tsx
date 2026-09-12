import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRequire } from "node:module";
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { encodeComposerMentionValue } from "../src/react-app/domains/session/surface/composer/mention-encoding";

GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.defineProperty(document, "compatMode", { configurable: true, value: "CSS1Compat" });
const network = mock(async () => { throw new Error("Network is not available in composer tests"); });
Object.defineProperty(globalThis, "fetch", { configurable: true, value: network });
Object.defineProperty(window, "fetch", { configurable: true, value: network });

const require = createRequire(import.meta.url);
for (const name of [
  "lexical",
  "@lexical/react/LexicalComposer.js",
  "@lexical/react/LexicalPlainTextPlugin.js",
  "@lexical/react/LexicalContentEditable.js",
  "@lexical/react/LexicalErrorBoundary.js",
  "@lexical/react/LexicalOnChangePlugin.js",
  "@lexical/react/LexicalHistoryPlugin.js",
  "@lexical/react/LexicalComposerContext.js",
]) {
  const exports = require(name);
  mock.module(name, () => exports);
}

let runningApps: string[] = [];
const connections = {
  connections: [], loading: false, loaded: true, error: null, connectingId: null,
  refresh: async () => {}, connect: async () => {},
};
mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("@/components/chat/image-lightbox", () => ({ ImageLightbox: () => null }));
mock.module("@/react-app/domains/connections/use-org-mcp-connections", () => ({ useOrgMcpConnections: () => connections }));
mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
mock.module("@/react-app/shell/dev-profiler", () => ({ DevProfiler: ({ children }: { children: ReactNode }) => children }));
mock.module("../src/react-app/domains/session/surface/composer/app-mentions", () => ({ listRunningAppsForMention: async () => runningApps }));

const { ReactSessionComposer } = await import("../src/react-app/domains/session/surface/composer/composer");
const { NewTaskComposer } = await import("../src/react-app/domains/session/chat/new-task-composer");
const { $createRangeSelection, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, $setSelection, getNearestEditorFromDOMNode, SKIP_DOM_SELECTION_TAG } = await import("lexical");
type Props = ComponentProps<typeof ReactSessionComposer>;
const defaultAgents: Awaited<ReturnType<Props["listAgents"]>> = [{ name: "openwork", mode: "primary", options: {}, permission: [] }];

async function mounted(options: {
  draft?: string;
  files?: string[];
  apps?: string[];
  mentions?: Props["mentions"];
  attachments?: Props["attachments"];
  search?: Props["searchFiles"];
  newTask?: boolean;
} = {}) {
  runningApps = options.apps ?? [];
  const queries: string[] = [];
  const selectedAgent = mock((value: string | null) => {});
  const sent = mock(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let currentDraft = options.draft ?? "";
  const searchFiles = async (query: string) => {
    queries.push(query);
    return options.search ? options.search(query) : options.files ?? ["notes.md", "docs/start.md", "src/openwork.ts", "docs/cloud-notes.md"];
  };
  const listAgents = async () => defaultAgents;
  const listCommands = async () => [];
  const attachments = options.attachments ?? [];
  const recentFiles: string[] = [];
  function Harness() {
    const [draft, setDraft] = useState(currentDraft);
    const [mentions, setMentions] = useState(options.mentions ?? {});
    const updateDraft = (value: string) => { currentDraft = value; setDraft(value); };
    const context = {
      client: null,
      workspaceId: null,
      selectedModel: { providerID: "fixture", modelID: "fixture" },
      modelPickerOpen: false,
      onModelPickerOpenChange: () => {},
      onModelChange: () => {},
      modelVariantLabel: "Default",
      modelVariant: null,
      onModelVariantChange: () => {},
      agentLabel: "OpenWork",
      selectedAgent: null,
      listAgents,
      onSelectAgent: selectedAgent,
      listCommands,
      searchFiles,
      isRemoteWorkspace: false,
      isSandboxWorkspace: false,
    };
    if (options.newTask) {
      return <NewTaskComposer draft={draft} onDraftChange={updateDraft} onRunTask={sent} busy={false} context={context} />;
    }
    return <ReactSessionComposer
      {...context}
      draft={draft}
      mentions={mentions}
      onDraftChange={updateDraft}
      onSend={sent}
      onSteer={() => {}}
      onQueue={() => {}}
      onStop={() => {}}
      busy={false}
      steering={false}
      submissionPreparing={false}
      queuedCount={0}
      disabled={false}
      statusLabel=""
      attachments={attachments}
      onAttachFiles={() => {}}
      onRemoveAttachment={() => {}}
      attachmentsEnabled={false}
      attachmentsDisabledReason={null}
      recentFiles={recentFiles}
      onInsertMention={(kind, value, nextDraft) => {
        updateDraft(nextDraft ?? draft.replace(/@([^\s@]*)$/, kind === "agent" ? "" : `@${encodeComposerMentionValue(value)} `));
        if (kind === "agent") selectedAgent(value);
        else setMentions((previous) => ({ ...previous, [value]: kind }));
      }}
      onPasteText={() => {}}
      onUnsupportedFileLinks={() => {}}
      pastedText={[]}
      onExpandPastedText={() => {}}
      onRemovePastedText={() => {}}
    />;
  }
  await act(async () => root.render(<Harness />));
  const element = container.querySelector<HTMLElement>("[contenteditable='true'][data-lexical-editor='true']");
  if (!element) throw new Error("Composer editor did not mount");
  const editor = getNearestEditorFromDOMNode(element);
  if (!editor) throw new Error("Lexical editor is unavailable");
  await act(async () => editor.update(() => { $getRoot().selectEnd(); }, { discrete: true }));
  const buttons = () => Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.startsWith("@"));
  return {
    queries, selectedAgent, sent,
    draft: () => currentDraft,
    labels: () => buttons().map((button) => button.textContent ?? ""),
    tokenTitles: () => Array.from(element.querySelectorAll("span[contenteditable='false'][title]")).map((node) => node.getAttribute("title")),
    async type(text: string) {
      await act(async () => editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error("Typing requires a range selection");
        selection.insertText(text);
      }, { discrete: true }));
    },
    async removeText(value: string, start: number, end: number) {
      await act(async () => editor.update(() => {
        const node = $getRoot().getAllTextNodes().find((candidate) => candidate.getTextContent() === value);
        if (!node) throw new Error("Text node is unavailable");
        node.select(start, end).removeText();
      }, { discrete: true }));
    },
    async caret(offset: number, paragraphIndex = 0, end = offset) {
      await act(async () => editor.update(() => {
        const paragraph = $getRoot().getChildAtIndex(paragraphIndex);
        if (!$isElementNode(paragraph)) throw new Error("Paragraph is unavailable");
        const selection = $createRangeSelection();
        const setPoint = (point: typeof selection.anchor, position: number) => {
          let remaining = position;
          for (const node of paragraph.getChildren()) {
            const size = node.getTextContentSize();
            if ($isTextNode(node) && remaining <= size) {
              point.set(node.getKey(), remaining, "text");
              return;
            }
            remaining -= size;
          }
          throw new Error(`Caret offset ${position} is outside paragraph ${paragraphIndex}`);
        };
        setPoint(selection.anchor, offset);
        setPoint(selection.focus, end);
        $setSelection(selection);
      }, { discrete: true, ...(end === offset ? {} : { tag: SKIP_DOM_SELECTION_TAG }) }));
    },
    async beforeToken(value: string) {
      await act(async () => editor.update(() => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error("Paragraph is unavailable");
        const token = paragraph.getChildren().find((node) => node.getTextContent() === value);
        if (!token) throw new Error("Token is unavailable");
        const offset = token.getIndexWithinParent();
        paragraph.select(offset, offset);
      }, { discrete: true }));
    },
    async press(key: string) {
      await act(async () => {
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    },
    async choose(prefix: string) {
      const button = buttons().find((candidate) => candidate.textContent?.startsWith(prefix));
      if (!button) throw new Error(`Mention ${prefix} is unavailable`);
      await act(async () => {
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        button.click();
      });
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      expect(network).not.toHaveBeenCalled();
    },
  };
}

test("end-of-draft queries retain the available default agent and matching files", async () => {
  const composer = await mounted();
  try {
    for (const character of "@openwork") await composer.type(character);
    expect(composer.queries.at(-1)).toBe("openwork");
    expect(composer.labels()[0]?.startsWith("@openwork")).toBe(true);
    expect(composer.labels().some((label) => label.startsWith("@src/openwork.ts"))).toBe(true);
    expect(composer.labels().some((label) => label.startsWith("@notes.md"))).toBe(false);
    await composer.type(" summarize");
    expect(composer.labels()).toEqual([]);
  } finally { await composer.close(); }
});

for (const newTask of [false, true]) {
  for (const method of ["Enter", "Tab", "mouse"]) {
    test(`${newTask ? "new-task" : "session composer"} ${method} replaces the mention at the caret and preserves later text`, async () => {
      const composer = await mounted({ draft: "@openwork @notes", newTask });
      try {
        await composer.caret("@openwork".length);
        await composer.type(" @cl");
        expect(composer.queries.at(-1)).toBe("cl");
        expect(composer.labels()[0]?.startsWith("@cloud")).toBe(true);
        expect(composer.labels().some((label) => label.startsWith("@notes.md"))).toBe(false);
        if (method === "mouse") await composer.choose("@cloud");
        else await composer.press(method);
        expect(composer.draft()).toBe("@openwork @cloud @notes");
        expect(composer.tokenTitles()).toContain("@cloud");
        expect(composer.labels()).toEqual([]);
        expect(composer.sent).not.toHaveBeenCalled();
        await composer.type("continue ");
        expect(composer.draft()).toBe("@openwork @cloud continue @notes");
        expect(composer.sent).not.toHaveBeenCalled();
      } finally { await composer.close(); }
    });
  }
}

test("accepting within a plain-text mention replaces its remaining characters", async () => {
  const composer = await mounted({ draft: "Use @cloud before @notes" });
  try {
    await composer.caret("Use @cl".length);
    expect(composer.queries.at(-1)).toBe("cl");
    await composer.press("Tab");
    expect(composer.draft()).toBe("Use @cloud before @notes");
    await composer.type("this ");
    expect(composer.draft()).toBe("Use @cloud this before @notes");
    expect(composer.sent).not.toHaveBeenCalled();
  } finally { await composer.close(); }
});

test("selection-only movement refreshes the active query and a range selection closes suggestions", async () => {
  const composer = await mounted({ draft: "@cl @notes" });
  try {
    expect(composer.queries.at(-1)).toBe("notes");
    await composer.caret(3);
    expect(composer.queries.at(-1)).toBe("cl");
    expect(composer.labels()[0]?.startsWith("@cloud")).toBe(true);
    expect(composer.draft()).toBe("@cl @notes");
    await composer.caret(0);
    expect(composer.labels()).toEqual([]);
    await composer.caret("@cl @notes".length);
    expect(composer.queries.at(-1)).toBe("notes");
    expect(composer.labels().some((label) => label.startsWith("@notes.md"))).toBe(true);
    await composer.caret(0, 0, 3);
    expect(composer.labels()).toEqual([]);
    expect(composer.draft()).toBe("@cl @notes");
  } finally { await composer.close(); }
});

test("encoded mention and attachment nodes do not shift replacement across paragraph breaks", async () => {
  const file = "docs/100% plan.md";
  const prefix = `@${encodeComposerMentionValue(file)} [attachment document] @openwork`;
  const composer = await mounted({
    draft: `First\n\n${prefix} @notes\nLast`,
    mentions: { [file]: "file" },
    attachments: [{ id: "document", name: "report.pdf", mimeType: "application/pdf", size: 1, kind: "file" }],
  });
  try {
    await composer.caret(prefix.length, 2);
    await composer.type(" @cl");
    expect(composer.queries.at(-1)).toBe("cl");
    await composer.press("Tab");
    expect(composer.draft()).toBe(`First\n\n${prefix} @cloud @notes\nLast`);
    expect(composer.tokenTitles()).toContain(`@${file}`);
    expect(composer.tokenTitles()).toContain("@cloud");
    await composer.type("continue ");
    expect(composer.draft()).toBe(`First\n\n${prefix} @cloud continue @notes\nLast`);
    expect(composer.sent).not.toHaveBeenCalled();
  } finally { await composer.close(); }
});

test("an element caret before an attachment targets the preceding plain-text mention", async () => {
  const composer = await mounted({
    draft: "@cl [attachment document] @notes",
    attachments: [{ id: "document", name: "report.pdf", mimeType: "application/pdf", size: 1, kind: "file" }],
  });
  try {
    await composer.removeText("@cl ", 3, 4);
    expect(composer.draft()).toBe("@cl[attachment document] @notes");
    await composer.beforeToken("[attachment document]");
    expect(composer.labels()[0]?.startsWith("@cloud")).toBe(true);
    await composer.press("Tab");
    expect(composer.draft()).toBe("@cloud [attachment document] @notes");
    await composer.type("continue ");
    expect(composer.draft()).toBe("@cloud continue [attachment document] @notes");
    expect(composer.sent).not.toHaveBeenCalled();
  } finally { await composer.close(); }
});

for (const newTask of [false, true]) {
  test(`${newTask ? "new-task" : "session composer"} agent selection removes only the active mention`, async () => {
    const composer = await mounted({ draft: "Use @openw before @notes", newTask });
    try {
      await composer.caret("Use @openw".length);
      expect(composer.labels()[0]?.startsWith("@openwork")).toBe(true);
      await composer.press("Enter");
      expect(composer.draft()).toBe("Use  before @notes");
      expect(composer.selectedAgent).toHaveBeenCalledWith("openwork");
      expect(composer.sent).not.toHaveBeenCalled();
      await composer.type("this");
      expect(composer.draft()).toBe("Use this before @notes");
    } finally { await composer.close(); }
  });
}

test("file values keep their encoding and later mention tokens intact", async () => {
  const file = "docs/100% plan.md";
  const composer = await mounted({ draft: "Use @100 before @notes", files: [file, "notes.md"] });
  try {
    await composer.caret("Use @100".length);
    await composer.press("Enter");
    expect(composer.draft()).toBe(`Use @${encodeComposerMentionValue(file)} before @notes`);
    expect(composer.tokenTitles()).toContain(`@${file}`);
    expect(composer.sent).not.toHaveBeenCalled();
  } finally { await composer.close(); }
});

test("ordinary text after an existing semantic app mention does not reopen suggestions", async () => {
  const composer = await mounted({ draft: "@OpenWork ", mentions: { OpenWork: "app" }, apps: ["OpenWork"] });
  try {
    await composer.type("summarize");
    expect(composer.labels()).toEqual([]);
    expect(composer.queries).toEqual([]);
  } finally { await composer.close(); }
});

test("a delayed previous query cannot replace newer mention results", async () => {
  const oldFiles = Promise.withResolvers<string[]>();
  const composer = await mounted({ search: (query) => query === "openwork" ? oldFiles.promise : Promise.resolve(["docs/cloud-notes.md"]) });
  try {
    await composer.type("@openwork");
    await composer.type(" @cl");
    await act(async () => { oldFiles.resolve(["src/openwork.ts"]); });
    expect(composer.queries.at(-1)).toBe("cl");
    expect(composer.labels()[0]?.startsWith("@cloud")).toBe(true);
    expect(composer.labels().some((label) => label.includes("src/openwork.ts"))).toBe(false);
  } finally { oldFiles.resolve([]); await composer.close(); }
});

afterAll(() => GlobalRegistrator.unregister());
