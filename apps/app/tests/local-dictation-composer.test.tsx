import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
let latest: Recognition | undefined;
let prepareModel = false;
class Recognition {
  lang = ""; continuous = false; interimResults = false; aborted = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: { results: Array<Array<{ transcript: string }>> }) => void) | null = null;
  onlevel: ((level: number) => void) | null = null;
  onstatus: ((status: "installing") => void) | null = null;
  constructor() { latest = this; }
  start() { if (prepareModel) this.onstatus?.("installing"); else this.onstart?.(); }
  stop() {}
  abort() { this.aborted = true; }
  words(text: string) { this.onresult?.({ results: [[{ transcript: text }]] }); }
}
mock.module("../src/react-app/domains/session/surface/composer/use-native-dictation-feature", () => ({ useNativeDictationFeature: () => true }));
mock.module("../src/react-app/domains/session/surface/composer/desktop-speech-dictation", () => ({
  useDesktopSpeechDictation: () => ({ recognition: Recognition, local: true }),
}));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/react-app/domains/connections/use-org-mcp-connections", () => ({
  useOrgMcpConnections: () => ({ connections: [], loading: false, refresh: () => {} }),
}));
await import("lexical");
await import("@lexical/react/LexicalComposer.js");
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ReactSessionComposer } = await import("../src/react-app/domains/session/surface/composer/composer");
type ComposerProps = Parameters<typeof ReactSessionComposer>[0];
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const noop = () => {};
const asyncEmpty = async () => [];
function composerProps(draft: string, onDraftChange: (value: string) => void, onSend: () => void): ComposerProps {
  return {
    draft, mentions: {}, onDraftChange, onSend, onSteer: noop, onQueue: noop, onStop: noop,
    busy: false, steering: false, queuedCount: 0, disabled: false, statusLabel: "", modelPickerOpen: false,
    selectedModel: { providerID: "openai", modelID: "gpt" }, sessionId: "ses_current",
    onModelPickerOpenChange: noop, onModelChange: noop, attachments: [], onAttachFiles: noop,
    onRemoveAttachment: noop, attachmentsEnabled: true, attachmentsDisabledReason: null,
    modelVariantLabel: "", modelVariant: null, onModelVariantChange: noop, agentLabel: "", selectedAgent: null,
    listAgents: asyncEmpty, onSelectAgent: noop, listCommands: asyncEmpty, recentFiles: [], searchFiles: asyncEmpty,
    onInsertMention: noop, onPasteText: noop, onUnsupportedFileLinks: noop, pastedText: [],
    onExpandPastedText: noop, onRemovePastedText: noop,
  };
}

test.each(["Send", "Enter", "Send before words"])("%s finalizes and submits once; Escape cancels only dictation", async trigger => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const sent: string[] = []; let draft = ""; let stoppedAgent = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ busy = false }: { busy?: boolean }) {
    const [text, setText] = useState(""); draft = text;
    return <QueryClientProvider client={client}><ReactSessionComposer
      {...composerProps(text, setText, () => { sent.push(text) })} busy={busy} onStop={() => { stoppedAgent++ }}
    /></QueryClientProvider>;
  }
  function button(label: string) {
    const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  }
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }); };
  try {
    await act(async () => { root.render(<Harness />) }); await settle();
    await act(async () => { button("Dictate message").click() });
    await act(async () => { if (trigger !== "Send before words") latest?.words("plan the weak"); latest?.onlevel?.(0.8) });
    expect(draft).toBe(trigger === "Send before words" ? "" : "plan the weak");
    expect(container.querySelector("[data-composer-actions] [data-dictation-recording]")).not.toBeNull();
    expect(button("Run task").disabled).toBe(false);
    expect(container.querySelector('[aria-label="Microphone level"]')).not.toBeNull();
    expect(Number(container.querySelector('[data-dictation-waveform] rect:last-child')?.getAttribute("height"))).toBeCloseTo(24.4);
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) throw new Error("Missing editor");
    await act(async () => {
      if (trigger === "Enter") editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      else button("Run task").click();
    });
    // A second submit while finalization is pending must not send twice.
    await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })) });
    expect(container.textContent).toContain("Finishing dictation");
    expect(sent).toEqual([]);
    await act(async () => { latest?.words("plan the week."); latest?.onend?.() }); await settle();
    expect(draft).toContain("plan the week.");
    expect(container.querySelector('[data-dictation-recording]')).toBeNull();
    expect(sent).toEqual(["plan the week."]);
    await act(async () => { latest?.words("late words"); latest?.onend?.() });
    expect(sent).toHaveLength(1);
    await act(async () => { root.render(<Harness busy />) }); await settle();
    prepareModel = true;
    await act(async () => { button("Dictate message").click() });
    expect(container.textContent).toContain("Downloading speech model");
    const beforeCancel = draft;
    await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })) });
    expect(latest?.aborted).toBe(true);
    await act(async () => { latest?.words("late"); latest?.onend?.() });
    expect(draft).toBe(beforeCancel);
    expect(stoppedAgent).toBe(0);
  } finally { prepareModel = false; await act(async () => { root.unmount() }); client.clear(); container.remove(); }
});

test.each(["cancel", "error", "chat change", "edit"])("pending voice Send is revoked by %s", async reason => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const sent: string[] = [];
  let edit: (text: string) => void = () => {};
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ session = "first" }: { session?: string }) {
    const [text, setText] = useState(""); edit = setText;
    return <QueryClientProvider client={client}><ReactSessionComposer
      {...composerProps(text, setText, () => { sent.push(text) })} sessionId={session}
    /></QueryClientProvider>;
  }
  async function click(label: string) {
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!button) throw new Error(`Missing ${label}`);
      button.click();
    });
  }
  try {
    await act(async () => { root.render(<Harness />) });
    await click("Dictate message");
    await act(async () => { latest?.words("First words") });
    await click("Run task");
    expect(sent).toEqual([]);
    if (reason === "cancel") await click("Cancel dictation");
    else await act(async () => {
      if (reason === "error") latest?.onerror?.({ error: "finalization-timeout" });
      else if (reason === "chat change") root.render(<Harness session="second" />);
      else edit("My correction");
    });
    await act(async () => { latest?.words("late words"); latest?.onend?.() });
    expect(sent).toEqual([]);
    expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe(reason === "edit" ? "My correction" : "First words");
    expect(container.querySelector("[data-dictation-recording]")).toBeNull();
  } finally { await act(async () => { root.unmount() }); client.clear(); container.remove(); }
});

test("Stop finishes the live draft for editing without submitting", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const sent: string[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [text, setText] = useState("");
    return <QueryClientProvider client={client}><ReactSessionComposer
      {...composerProps(text, setText, () => { sent.push(text) })}
    /></QueryClientProvider>;
  }
  try {
    await act(async () => { root.render(<Harness />) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dictate message"]')?.click() });
    await act(async () => { latest?.words("plan the weak") });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')?.click() });
    await act(async () => { latest?.words("plan the week."); latest?.onend?.() });
    expect(container.querySelector('[contenteditable="true"]')?.textContent).toBe("plan the week.");
    expect(sent).toEqual([]);
    expect(container.querySelector("[data-dictation-recording]")).toBeNull();
  } finally { await act(async () => { root.unmount() }); client.clear(); container.remove(); }
});
