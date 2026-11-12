import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
let latest: Recognition | undefined;
class Recognition {
  lang = ""; continuous = false; interimResults = false; aborted = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: { results: Array<Array<{ transcript: string }>> }) => void) | null = null;
  onlevel: ((level: number) => void) | null = null;
  constructor() { latest = this; }
  start() { this.onstart?.(); }
  stop() {}
  abort() { this.aborted = true; }
  words(text: string) { this.onresult?.({ results: [[{ transcript: text }]] }); }
}
mock.module("../src/react-app/domains/session/surface/composer/use-native-dictation-feature", () => ({ useNativeDictationFeature: () => true }));
mock.module("../src/react-app/domains/session/surface/composer/desktop-speech-dictation", () => ({
  useDesktopSpeechDictation: () => ({ recognition: Recognition, deferTranscript: true }),
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

test("the composer meters speech, finishes before Send, and Escape cancels only dictation", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const sent: string[] = []; let draft = "Please"; let stoppedAgent = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ busy = false }: { busy?: boolean }) {
    const [text, setText] = useState("Please"); draft = text;
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
    await act(async () => { latest?.words("plan the weak"); latest?.onlevel?.(0.8) });
    expect(draft).toBe("Please");
    expect(container.querySelector('[aria-label="Microphone level"]')).not.toBeNull();
    expect(Number(container.querySelector('[data-dictation-waveform] rect:last-child')?.getAttribute("height"))).toBeCloseTo(24.4);
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) throw new Error("Missing editor");
    await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })) });
    expect(container.textContent).toContain("Finishing dictation");
    expect(sent).toEqual([]);
    await act(async () => { latest?.words("plan the week."); latest?.onend?.() }); await settle();
    expect(draft).toContain("plan the week.");
    expect(container.querySelector('[data-dictation-recording]')).toBeNull();
    expect(sent).toEqual([]);
    await act(async () => { button("Run task").click() });
    expect(sent).toEqual([draft]);
    await act(async () => { root.render(<Harness busy />) }); await settle();
    await act(async () => { button("Dictate message").click(); latest?.words("discard me") });
    const beforeCancel = draft;
    await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })) });
    expect(latest?.aborted).toBe(true);
    await act(async () => { latest?.words("late"); latest?.onend?.() });
    expect(draft).toBe(beforeCancel);
    expect(stoppedAgent).toBe(0);
  } finally { await act(async () => { root.unmount() }); client.clear(); container.remove(); }
});
