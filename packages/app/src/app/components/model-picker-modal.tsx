import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { CheckCircle2, Circle, Search, X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import { modelEquals } from "../utils";
import type { ModelOption, ModelRef } from "../types";

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
  let searchInputRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const [activeIndex, setActiveIndex] = createSignal(0);
  const optionRefs: HTMLButtonElement[] = [];

  const activeModelIndex = createMemo(() => {
    const list = props.filteredOptions;
    return list.findIndex((opt) =>
      modelEquals(props.current, {
        providerID: opt.providerID,
        modelID: opt.modelID,
      }),
    );
  });

  const clampIndex = (next: number) => {
    const last = props.filteredOptions.length - 1;
    if (last < 0) return 0;
    return Math.max(0, Math.min(next, last));
  };

  const scrollActiveIntoView = (idx: number) => {
    const el = optionRefs[idx];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  };

  createEffect(() => {
    if (!props.open) return;
    requestAnimationFrame(() => {
      searchInputRef?.focus();
      if (searchInputRef?.value) {
        searchInputRef.select();
      }
    });
  });

  createEffect(() => {
    if (!props.open) return;
    const idx = activeModelIndex();
    const next = idx >= 0 ? idx : 0;
    setActiveIndex(clampIndex(next));
    requestAnimationFrame(() => scrollActiveIntoView(clampIndex(next)));
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!props.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => {
          const next = clampIndex(current + 1);
          requestAnimationFrame(() => scrollActiveIntoView(next));
          return next;
        });
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => {
          const next = clampIndex(current - 1);
          requestAnimationFrame(() => scrollActiveIntoView(next));
          return next;
        });
        return;
      }

      if (event.key === "Enter") {
        const idx = activeIndex();
        const opt = props.filteredOptions[idx];
        if (!opt) return;
        event.preventDefault();
        event.stopPropagation();
        props.onSelect({ providerID: opt.providerID, modelID: opt.modelID });
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="p-6 flex flex-col min-h-0">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">
                  {props.target === "default" ? translate("settings.default_model") : translate("settings.session_model")}
                </h3>
                <p class="text-sm text-gray-11 mt-1">
                  {props.target === "default" ? translate("settings.model_description_default") : translate("settings.model_description_session")}
                </p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-5">
              <div class="relative">
                <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-10" />
                <input
                  ref={(el) => (searchInputRef = el)}
                  type="text"
                  value={props.query}
                  onInput={(e) => props.setQuery(e.currentTarget.value)}
                  placeholder={translate("settings.search_models")}
                  class="w-full bg-gray-1/40 border border-gray-6 rounded-xl py-2.5 pl-9 pr-3 text-sm text-gray-12 placeholder-gray-6 focus:outline-none focus:ring-1 focus:ring-gray-8 focus:border-gray-8"
                />
              </div>
              <Show when={props.query.trim()}>
                <div class="mt-2 text-xs text-gray-10">
                  {translate("settings.showing_models").replace("{count}", String(props.filteredOptions.length)).replace("{total}", String(props.options.length))}
                </div>
              </Show>
            </div>

            <div class="mt-4 space-y-2 overflow-y-auto pr-1 -mr-1 min-h-0">
              <For each={props.filteredOptions}>
                {(opt, idx) => {
                  const active = () =>
                    modelEquals(props.current, {
                      providerID: opt.providerID,
                      modelID: opt.modelID,
                    });

                  const i = () => idx();

                  return (
                    <button
                      ref={(el) => {
                        optionRefs[i()] = el;
                      }}
                      class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
                        i() === activeIndex()
                          ? "border-gray-8 bg-gray-12/10"
                          : active()
                            ? "border-gray-6/20 bg-gray-12/5"
                            : "border-gray-6/70 bg-gray-1/40 hover:bg-gray-1/60"
                      }`}
                      onMouseEnter={() => {
                        setActiveIndex(i());
                      }}
                      onClick={() =>
                        props.onSelect({
                          providerID: opt.providerID,
                          modelID: opt.modelID,
                        })
                      }
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-gray-12 flex items-center gap-2">
                            <span class="truncate">{opt.title}</span>
                          </div>
                          <Show when={opt.description}>
                            <div class="text-xs text-gray-10 mt-1 truncate">{opt.description}</div>
                          </Show>
                          <Show when={opt.footer}>
                            <div class="text-[11px] text-gray-7 mt-2">{opt.footer}</div>
                          </Show>
                          <div class="text-[11px] text-gray-7 font-mono mt-2">
                            {opt.providerID}/{opt.modelID}
                          </div>
                        </div>

                        <div class="pt-0.5 text-gray-10">
                          <Show when={active()} fallback={<Circle size={14} />}>
                            <CheckCircle2 size={14} class="text-green-11" />
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
                {translate("settings.done")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
