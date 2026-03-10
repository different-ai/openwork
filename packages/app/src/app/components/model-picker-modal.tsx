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
  onOpenSettings: () => void;
  onClose: () => void;
};

export default function ModelPickerModal(props: ModelPickerModalProps) {
  let searchInputRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  type RenderedItem =
    | { kind: "model"; opt: ModelOption }
    | { kind: "provider"; providerID: string; title: string; matchCount: number };

  const [activeIndex, setActiveIndex] = createSignal(0);
  const optionRefs: HTMLButtonElement[] = [];

  const otherProviderLinks = createMemo(() => {
    const seen = new Set<string>();
    const items: { providerID: string; title: string; matchCount: number }[] = [];
    const counts = new Map<string, number>();

    for (const opt of props.filteredOptions) {
      if (opt.isConnected) continue;
      counts.set(opt.providerID, (counts.get(opt.providerID) ?? 0) + 1);
      if (seen.has(opt.providerID)) continue;
      seen.add(opt.providerID);
      items.push({
        providerID: opt.providerID,
        title: opt.description ?? opt.providerID,
        matchCount: 1,
      });
    }

    return items.map((item) => ({
      ...item,
      matchCount: counts.get(item.providerID) ?? 1,
    }));
  });

  const renderedItems = createMemo<RenderedItem[]>(() => [
    ...props.filteredOptions
      .filter((opt) => opt.isConnected)
      .map((opt) => ({ kind: "model" as const, opt })),
    ...otherProviderLinks().map((item) => ({ kind: "provider" as const, ...item })),
  ]);

  const activeModelIndex = createMemo(() => {
    const list = renderedItems();
    return list.findIndex(
      (item) =>
        item.kind === "model" &&
        modelEquals(props.current, {
          providerID: item.opt.providerID,
          modelID: item.opt.modelID,
        }),
    );
  });

  const enabledOptions = createMemo(() =>
    renderedItems()
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.kind === "model")
      .map((entry) => ({ opt: entry.item.opt, index: entry.index })),
  );

  const otherOptions = createMemo(() =>
    renderedItems()
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.kind === "provider")
      .map((entry) => ({
        providerID: entry.item.providerID,
        title: entry.item.title,
        matchCount: entry.item.matchCount,
        index: entry.index,
      })),
  );

  const clampIndex = (next: number) => {
    const last = renderedItems().length - 1;
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
        if (event.isComposing || event.keyCode === 229) return;
        const idx = activeIndex();
        const item = renderedItems()[idx];
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.kind === "provider") {
          props.onClose();
          props.onOpenSettings();
          return;
        }
        props.onSelect({ providerID: item.opt.providerID, modelID: item.opt.modelID });
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const renderOption = (opt: ModelOption, index: number) => {
    const active = () =>
      modelEquals(props.current, {
        providerID: opt.providerID,
        modelID: opt.modelID,
      });

    return (
      <button
        ref={(el) => {
          optionRefs[index] = el;
        }}
        class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
          index === activeIndex()
            ? "border-gray-8 bg-gray-12/10"
            : active()
              ? "border-gray-6/20 bg-gray-12/5"
              : "border-gray-6/70 bg-gray-1/40 hover:bg-gray-1/60"
        }`}
        onMouseEnter={() => {
          setActiveIndex(index);
        }}
        onClick={() => {
          props.onSelect({
            providerID: opt.providerID,
            modelID: opt.modelID,
          });
        }}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-gray-12 flex items-center gap-2">
              <span class="truncate">{opt.title}</span>
            </div>
            <div class="mt-1 flex items-center gap-3 text-xs text-gray-10">
              <span class="truncate">{opt.description ?? opt.providerID}</span>
              <span class="ml-auto text-[11px] text-gray-7 font-mono">
                {opt.providerID}/{opt.modelID}
              </span>
            </div>
            <Show when={opt.footer}>
              <div class="text-[11px] text-gray-7 mt-2">{opt.footer}</div>
            </Show>
          </div>

          <div class="pt-0.5 text-gray-10">
            <Show when={active()} fallback={<Circle size={14} />}>
              <CheckCircle2 size={14} class="text-green-11" />
            </Show>
          </div>
        </div>
      </button>
    );
  };

  const renderProviderLink = (provider: { providerID: string; title: string; matchCount: number }, index: number) => (
    <button
      ref={(el) => {
        optionRefs[index] = el;
      }}
      class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
        index === activeIndex()
          ? "border-gray-8 bg-gray-12/10"
          : "border-gray-6/70 bg-gray-1/40 hover:bg-gray-1/60"
      }`}
      onMouseEnter={() => {
        setActiveIndex(index);
      }}
      onClick={() => {
        props.onClose();
        props.onOpenSettings();
      }}
    >
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-medium text-gray-12 truncate">{provider.title}</div>
          <div class="mt-1 text-xs text-gray-10">Click to setup provider</div>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <div class="text-[11px] text-gray-7">
            {provider.matchCount} {provider.matchCount === 1 ? "model" : "models"}
          </div>
        </div>
      </div>
    </button>
  );

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
                <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
                <input
                  ref={(el) => (searchInputRef = el)}
                  type="text"
                  value={props.query}
                  onInput={(e) => props.setQuery(e.currentTarget.value)}
                  placeholder={translate("settings.search_models")}
                  class="w-full bg-dls-surface border border-dls-border rounded-xl py-2.5 pl-9 pr-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:border-dls-accent"
                />
              </div>
              <Show when={props.query.trim()}>
                <div class="mt-2 text-xs text-dls-secondary">
                  {translate("settings.showing_models").replace("{count}", String(props.filteredOptions.length)).replace("{total}", String(props.options.length))}
                </div>
              </Show>
            </div>

            <div class="mt-4 space-y-4 overflow-y-auto pr-1 -mr-1 min-h-0">
              <Show when={enabledOptions().length > 0}>
                <section class="space-y-2">
                  <div class="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                    Enabled Providers
                  </div>
                  <For each={enabledOptions()}>{({ opt, index }) => renderOption(opt, index)}</For>
                </section>
              </Show>

              <Show when={otherOptions().length > 0}>
                <section class="space-y-2">
                  <div class="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                    Other Providers
                  </div>
                  <For each={otherOptions()}>
                    {(provider) => renderProviderLink(provider, provider.index)}
                  </For>
                </section>
              </Show>

              <Show when={renderedItems().length === 0}>
                <div class="rounded-2xl border border-gray-6/70 bg-gray-1/40 px-4 py-6 text-sm text-gray-10">
                  No models match your search.
                </div>
              </Show>
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
