import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { MessageCircleQuestion, Minimize2, Settings2, Sparkles } from "lucide-solid";
import Button from "../../components/button";
import TextInput from "../../components/text-input";
import type { OpenworkServerStatus } from "../../lib/openwork-server";
import type { SettingsTab, View, WorkspaceDisplay } from "../../types";
import {
  buildClickyPrompt,
  buildClickySuggestions,
  clickySurfaceLabel,
  type ClickyContext,
} from "./prompt";

type ClickyCompanionProps = {
  appVersion: string | null;
  currentView: View;
  developerMode: boolean;
  enabled: boolean;
  forcedByEnv: boolean;
  openworkServerStatus: OpenworkServerStatus;
  providerConnectedCount: number;
  selectedWorkspace: WorkspaceDisplay;
  settingsTab: SettingsTab;
  onAsk: (question: string, prompt: string) => Promise<void>;
  onOpenSettings: (tab: SettingsTab) => void;
};

function workspaceLabel(workspace: WorkspaceDisplay) {
  return (
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.directory?.trim() ||
    workspace.path?.trim() ||
    "current workspace"
  );
}

export default function ClickyCompanion(props: ClickyCompanionProps) {
  const [open, setOpen] = createSignal(false);
  const [question, setQuestion] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);

  const context = createMemo<ClickyContext>(() => ({
    appVersion: props.appVersion,
    currentView: props.currentView,
    developerMode: props.developerMode,
    hasConnectedProvider: props.providerConnectedCount > 0,
    openworkServerStatus: props.openworkServerStatus,
    settingsTab: props.settingsTab,
    workspace: props.selectedWorkspace,
  }));

  const suggestions = createMemo(() => buildClickySuggestions(context()));
  const helperState = createMemo(() => {
    if (props.providerConnectedCount > 0) {
      return "Ready to open a separate guided session.";
    }
    return "Needs a connected model first. I can route you to Settings > General.";
  });
  const contextLine = createMemo(
    () =>
      `${clickySurfaceLabel(context())} · ${workspaceLabel(props.selectedWorkspace)} · ${
        props.openworkServerStatus
      } server`,
  );

  createEffect(() => {
    if (!props.enabled) {
      setOpen(false);
      return;
    }
    setOpen(true);
  });

  const submit = async (value?: string) => {
    if (busy()) return;
    const nextQuestion = (value ?? question()).trim();
    if (!nextQuestion) return;

    setStatus(null);

    if (props.providerConnectedCount === 0) {
      props.onOpenSettings("general");
      setStatus("Clicky needs a connected model first. Opened Settings > General.");
      return;
    }

    setBusy(true);
    try {
      const prompt = buildClickyPrompt(nextQuestion, context());
      await props.onAsk(nextQuestion, prompt);
      setQuestion("");
      setOpen(false);
      setStatus("Started a dedicated Clicky session.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to start Clicky.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={props.enabled}>
      <div class="pointer-events-none fixed bottom-5 right-5 z-[65] flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-3">
        <Show when={open()}>
          <div class="pointer-events-auto w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-[28px] border border-blue-6/30 bg-[linear-gradient(180deg,rgba(236,246,255,0.96),rgba(255,255,255,0.98))] shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur">
            <div class="border-b border-blue-6/20 bg-[linear-gradient(135deg,rgba(68,141,255,0.16),rgba(146,203,255,0.08))] px-4 py-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <div class="flex h-9 w-9 items-center justify-center rounded-2xl bg-blue-9 text-white shadow-[0_8px_24px_rgba(59,130,246,0.28)]">
                      <Sparkles size={18} />
                    </div>
                    <div class="min-w-0">
                      <div class="text-sm font-semibold text-slate-12">Clicky</div>
                      <div class="text-[11px] uppercase tracking-[0.18em] text-blue-11/80">Experiment</div>
                    </div>
                  </div>
                  <div class="mt-3 text-xs text-slate-11">{contextLine()}</div>
                </div>
                <button
                  type="button"
                  class="rounded-full p-2 text-slate-10 transition hover:bg-white/70 hover:text-slate-12"
                  onClick={() => setOpen(false)}
                  aria-label="Minimize Clicky"
                  title="Minimize Clicky"
                >
                  <Minimize2 size={16} />
                </button>
              </div>
            </div>

            <div class="space-y-4 px-4 py-4">
              <div class="rounded-2xl border border-slate-6/60 bg-white/80 px-3 py-3">
                <div class="text-sm text-slate-12">
                  Ask how to do something in OpenWork. Clicky opens a separate guidance session so it does not disturb your current task.
                </div>
                <div class="mt-2 text-xs text-slate-10">{helperState()}</div>
                <Show when={props.forcedByEnv}>
                  <div class="mt-2 text-[11px] text-blue-11">
                    Forced on by <code>VITE_OPENWORK_EXPERIMENT_CLICKY=1</code>.
                  </div>
                </Show>
              </div>

              <div class="space-y-2">
                <div class="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-9">Suggested prompts</div>
                <div class="flex flex-wrap gap-2">
                  <For each={suggestions()}>
                    {(suggestion) => (
                      <button
                        type="button"
                        class="rounded-full border border-slate-6 bg-white px-3 py-1.5 text-xs text-slate-11 transition hover:border-blue-7/40 hover:bg-blue-2/40 hover:text-blue-11"
                        onClick={() => void submit(suggestion.question)}
                        disabled={busy()}
                      >
                        {suggestion.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div class="space-y-3">
                <TextInput
                  value={question()}
                  onInput={(event) => setQuestion(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void submit();
                  }}
                  placeholder="How do I do this in OpenWork?"
                  hint="Clicky sends your question with current app context."
                />

                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    class="h-9 rounded-full px-4"
                    onClick={() => void submit()}
                    disabled={busy() || !question().trim()}
                  >
                    <MessageCircleQuestion size={16} />
                    {busy() ? "Starting..." : "Ask Clicky"}
                  </Button>
                  <Show when={props.providerConnectedCount === 0}>
                    <Button
                      variant="outline"
                      class="h-9 rounded-full px-4"
                      onClick={() => props.onOpenSettings("general")}
                    >
                      <Settings2 size={16} />
                      Open settings
                    </Button>
                  </Show>
                </div>

                <Show when={status()}>
                  <div class="text-xs text-slate-10">{status()}</div>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        <button
          type="button"
          class="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-blue-7/30 bg-blue-9 px-4 py-3 text-sm font-medium text-white shadow-[0_18px_44px_rgba(37,99,235,0.32)] transition hover:bg-blue-10"
          onClick={() => setOpen((value) => !value)}
          aria-label={open() ? "Hide Clicky" : "Show Clicky"}
        >
          <Sparkles size={16} />
          Clicky
        </button>
      </div>
    </Show>
  );
}
