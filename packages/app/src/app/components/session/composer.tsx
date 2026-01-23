import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { ArrowRight, Zap } from "lucide-solid";

export type CommandItem = {
  id: string;
  description: string;
};

export type ComposerProps = {
  prompt: string;
  setPrompt: (value: string) => void;
  busy: boolean;
  onSend: () => void;
  commandMatches: CommandItem[];
  onRunCommand: (commandId: string) => void;
  selectedModelLabel: string;
  onModelClick: () => void;
  showNotionBanner: boolean;
  onNotionBannerClick: () => void;
  toast: string | null;
};

export default function Composer(props: ComposerProps) {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [commandIndex, setCommandIndex] = createSignal(0);

  // Track IME composition state via events (more reliable than event.isComposing)
  const [isComposingIME, setIsComposingIME] = createSignal(false);
  // Flag to skip the Enter key that confirms IME composition
  let skipNextEnter = false;

  const commandMenuOpen = createMemo(() => {
    return props.prompt.startsWith("/") && !props.busy;
  });

  const syncHeight = () => {
    if (!textareaRef) return;
    textareaRef.style.height = "auto";
    const nextHeight = Math.min(textareaRef.scrollHeight, 160);
    textareaRef.style.height = `${nextHeight}px`;
    textareaRef.style.overflowY = textareaRef.scrollHeight > 160 ? "auto" : "hidden";
  };

  createEffect(() => {
    props.prompt;
    syncHeight();
  });

  createEffect(() => {
    if (commandMenuOpen()) {
      setCommandIndex(0);
    }
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    // During IME composition, let the browser handle all keys
    if (isComposingIME() || event.isComposing) return;

    // Skip the Enter key that was used to confirm IME composition
    // (flag is cleared by onCompositionEnd's setTimeout)
    if (event.key === "Enter" && skipNextEnter) {
      return;
    }

    // Shift+Enter allows newline
    if (event.key === "Enter" && event.shiftKey) return;

    if (commandMenuOpen()) {
      const matches = props.commandMatches;
      if (event.key === "Enter") {
        event.preventDefault();
        const active = matches[commandIndex()] ?? matches[0];
        if (active) {
          props.onRunCommand(active.id);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandIndex((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        props.setPrompt("");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        // maybe autocomplete?
        const active = matches[commandIndex()] ?? matches[0];
         if (active) {
          props.onRunCommand(active.id);
        }
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      props.onSend();
    }
  };

  createEffect(() => {
     const handler = () => {
       textareaRef?.focus();
     };
     window.addEventListener("openwork:focusPrompt", handler);
     onCleanup(() => window.removeEventListener("openwork:focusPrompt", handler));
  });

  return (
    <div class="p-4 border-t border-gray-6 bg-gray-1 sticky bottom-0 z-20">
      <div class="max-w-2xl mx-auto">
        <div
          class={`bg-gray-2 border border-gray-6 rounded-3xl overflow-visible transition-all shadow-2xl relative group/input ${
            commandMenuOpen()
              ? "rounded-t-none border-t-transparent"
              : "focus-within:ring-1 focus-within:ring-gray-7"
          }`}
        >
          <Show when={commandMenuOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-3xl border border-gray-6 border-b-0 bg-gray-2 shadow-2xl overflow-hidden">
                <div class="px-4 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-8 border-b border-gray-6/30 bg-gray-2">
                  Commands
                </div>
                <div class="space-y-1 p-2 bg-gray-2">
                  <Show
                    when={props.commandMatches.length}
                    fallback={
                      <div class="px-3 py-2 text-xs text-gray-9">No commands found.</div>
                    }
                  >
                    <For each={props.commandMatches}>
                      {(command, idx) => (
                        <button
                          type="button"
                          class={`w-full flex items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                            idx() === commandIndex()
                              ? "bg-gray-12/10 text-gray-12"
                              : "text-gray-11 hover:bg-gray-12/5"
                          }`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            props.onRunCommand(command.id);
                          }}
                          onMouseEnter={() => setCommandIndex(idx())}
                        >
                          <div class="text-xs font-semibold text-gray-12">/{command.id}</div>
                          <div class="text-[11px] text-gray-9">{command.description}</div>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <button
            type="button"
            class="absolute top-3 left-4 flex items-center gap-1.5 text-[10px] font-bold text-gray-7 hover:text-gray-11 transition-colors uppercase tracking-widest z-10"
            onClick={props.onModelClick}
            disabled={props.busy}
          >
            <Zap size={10} class="text-gray-7 group-hover:text-amber-11 transition-colors" />
            <span>{props.selectedModelLabel}</span>
          </button>

          <div class="p-3 pt-8 pb-3 px-4">
            <Show when={props.showNotionBanner}>
              <button
                type="button"
                class="w-full mb-2 flex items-center justify-between gap-3 rounded-xl border border-green-7/20 bg-green-7/10 px-3 py-2 text-left text-sm text-green-12 transition-colors hover:bg-green-7/15"
                onClick={props.onNotionBannerClick}
              >
                <span>Try it now: set up my CRM in Notion</span>
                <span class="text-xs text-green-12 font-medium">Insert prompt</span>
              </button>
            </Show>

            <div class="relative">
              <Show when={props.toast}>
                <div class="absolute bottom-full right-0 mb-2 z-30 rounded-xl border border-gray-6 bg-gray-1/90 px-3 py-2 text-xs text-gray-11 shadow-lg backdrop-blur-md">
                  {props.toast}
                </div>
              </Show>

              <div class="relative flex items-end gap-3">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  disabled={props.busy}
                  value={props.prompt}
                  onInput={(e) => props.setPrompt(e.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={() => {
                    setIsComposingIME(true);
                    // The Enter that confirms IME composition should be skipped
                    skipNextEnter = true;
                  }}
                  onCompositionEnd={() => {
                    setIsComposingIME(false);
                    // Clear the flag after current task completes and a small delay to allow the keydown event to fire
                    // If Enter confirmed IME, its keydown fires before this runs → skipped
                    // If mouse/touch/spacebar confirmed IME, this clears the flag → next Enter works
                    setTimeout(() => {
                      skipNextEnter = false;
                    }, 100);
                  }}
                  placeholder="Ask OpenWork..."
                  class="flex-1 bg-transparent border-none p-0 text-gray-12 placeholder-gray-6 focus:ring-0 text-[15px] leading-relaxed resize-none min-h-[24px]"
                />

                <button
                  disabled={!props.prompt.trim() || props.busy}
                  onClick={props.onSend}
                  class="p-2 bg-gray-12 text-gray-1 rounded-xl hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75 shadow-lg shrink-0 flex items-center justify-center"
                  title="Run"
                >
                  <ArrowRight size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
