import { For, Show } from "solid-js";
import { useI18n } from "../i18n";

import { CheckCircle2, Circle, Search, X } from "lucide-solid";

import Button from "./Button";
import { modelEquals } from "../app/utils";
import type { ModelOption, ModelRef } from "../app/types";

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  filteredOptions: ModelOption[];
  query: string;
  setQuery: (value: string) => void;
  target: "default" | "session";
  current: ModelRef;
  onSelect: (model: ModelRef) => void;
  onClose: () => void;
};

export default function ModelPickerModal(props: ModelPickerModalProps) {
  const [t] = useI18n();
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="p-6 flex flex-col min-h-0">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-white">
                  {props.target === "default" ? t("settings.model_picker.title_default") : t("settings.model_picker.title_session")}
                </h3>
                <p class="text-sm text-zinc-400 mt-1">
                  {t("settings.model_picker.desc_prefix")} {props.target === "default"
                    ? t("settings.model_picker.desc_default")
                    : t("settings.model_picker.desc_session")}.
                </p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-5">
              <div class="relative">
                <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={props.query}
                  onInput={(e) => props.setQuery(e.currentTarget.value)}
                  placeholder={t("settings.model_picker.search_placeholder")}
                  class="w-full bg-zinc-950/40 border border-zinc-800 rounded-xl py-2.5 pl-9 pr-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600"
                />
              </div>
              <Show when={props.query.trim()}>
                <div class="mt-2 text-xs text-zinc-500">
                  {t("settings.model_picker.showing")} {props.filteredOptions.length} {t("settings.model_picker.of")} {props.options.length}
                </div>
              </Show>
            </div>

            <div class="mt-4 space-y-2 overflow-y-auto pr-1 -mr-1 min-h-0">
              <For each={props.filteredOptions}>
                {(opt) => {
                  const active = () =>
                    modelEquals(props.current, {
                      providerID: opt.providerID,
                      modelID: opt.modelID,
                    });

                  return (
                    <button
                      class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${active()
                        ? "border-white/20 bg-white/5"
                        : "border-zinc-800/70 bg-zinc-950/40 hover:bg-zinc-950/60"
                        }`}
                      onClick={() =>
                        props.onSelect({
                          providerID: opt.providerID,
                          modelID: opt.modelID,
                        })
                      }
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-zinc-100 flex items-center gap-2">
                            <span class="truncate">{opt.title}</span>
                          </div>
                          <Show when={opt.description}>
                            <div class="text-xs text-zinc-500 mt-1 truncate">{opt.description}</div>
                          </Show>
                          <Show when={opt.footer}>
                            <div class="text-[11px] text-zinc-600 mt-2">{opt.footer}</div>
                          </Show>
                          <div class="text-[11px] text-zinc-600 font-mono mt-2">
                            {opt.providerID}/{opt.modelID}
                          </div>
                        </div>

                        <div class="pt-0.5 text-zinc-500">
                          <Show when={active()} fallback={<Circle size={14} />}>
                            <CheckCircle2 size={14} class="text-emerald-400" />
                          </Show>
                        </div>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>

            <div class="mt-5 flex justify-end shrink-0">
              <Button variant="outline" onClick={props.onClose}>
                {t("settings.model_picker.done")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
