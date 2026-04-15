import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { CheckCircle2, Circle, Search, X } from "lucide-solid";
import { t } from "../../i18n";

import Button from "./button";
import ProviderIcon from "./provider-icon";
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
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
};

export default function ModelPickerModal(props: ModelPickerModalProps) {
  let searchInputRef: HTMLInputElement | undefined;
  const translate = (key: string, params?: Record<string, string | number>) => t(key, undefined, params);

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

  const renderedItems = createMemo<RenderedItem[]>(() => {
    const models = props.filteredOptions.filter((opt) => opt.isConnected);
    const recommended = models.filter((opt) => opt.isRecommended);
    const others = models.filter((opt) => !opt.isRecommended);

    return [
      ...recommended.map((opt) => ({ kind: "model" as const, opt })),
      ...others.map((opt) => ({ kind: "model" as const, opt })),
      ...otherProviderLinks().map((item) => ({ kind: "provider" as const, ...item })),
    ];
  });

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

  const recommendedOptions = createMemo(() =>
    renderedItems().flatMap((item, index) =>
      item.kind === "model" && item.opt.isRecommended ? [{ opt: item.opt, index }] : [],
    ),
  );

  const otherEnabledOptions = createMemo(() =>
    renderedItems().flatMap((item, index) =>
      item.kind === "model" && !item.opt.isRecommended ? [{ opt: item.opt, index }] : [],
    ),
  );

  const otherOptions = createMemo(() =>
    renderedItems().flatMap((item, index) =>
      item.kind === "provider"
        ? [{ providerID: item.providerID, title: item.title, matchCount: item.matchCount, index }]
        : [],
    ),
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
          props.onClose({ restorePromptFocus: false });
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
      <div
        role="button"
        tabIndex={0}
        ref={(el) => {
          optionRefs[index] = el as unknown as HTMLButtonElement;
        }}
        class={`group w-full text-left rounded-xl px-3 py-2.5 transition-colors cursor-pointer ${
          active()
            ? "bg-gray-3 text-gray-12"
            : index === activeIndex()
              ? "bg-gray-2 text-gray-12"
              : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11"
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
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          props.onSelect({
            providerID: opt.providerID,
            modelID: opt.modelID,
          });
        }}
      >
        <div class="flex items-start gap-3">
          <ProviderIcon providerId={opt.providerID} size={16} class={`mt-[1px] shrink-0 transition-colors ${active() ? 'text-gray-12' : 'text-gray-10 group-hover:text-gray-11'}`} />
          <div class="flex-1 min-w-0">
            <div class={`text-[13px] flex items-center justify-between gap-2 ${active() ? 'font-medium text-gray-12' : 'text-current'}`}>
              <span class="truncate">{opt.title}</span>
            </div>
            <div class={`mt-0.5 flex items-center gap-3 text-[11px] ${active() ? 'text-gray-10' : 'text-gray-9 group-hover:text-gray-10'}`}>
              <span class="truncate">{opt.description ?? opt.providerID}</span>
              <span class="ml-auto opacity-70 font-mono">
                {opt.providerID}/{opt.modelID}
              </span>
            </div>
            <Show when={opt.footer}>
              <div class={`text-[11px] mt-1 ${active() ? 'text-gray-10' : 'text-gray-8 group-hover:text-gray-9'}`}>{opt.footer}</div>
            </Show>
            <Show when={active() && (opt.behaviorOptions?.length ?? 0) > 0}>
              <div class="mt-3 flex items-center gap-2" onKeyDown={(e) => e.stopPropagation()}>
                <span class="text-[11px] font-medium text-gray-10 mr-1">{opt.behaviorTitle}:</span>
                <div class="flex flex-wrap items-center gap-3" onClick={(e) => e.stopPropagation()}>
                  <For each={opt.behaviorOptions}>
                    {(option) => (
                      <button
                        type="button"
                        class={`text-[11px] transition-colors ${
                          opt.behaviorValue === option.value
                            ? "text-gray-12 font-semibold"
                            : "text-gray-10 hover:text-gray-12"
                        }`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          props.onBehaviorChange(
                            { providerID: opt.providerID, modelID: opt.modelID },
                            option.value,
                          );
                        }}
                      >
                        {option.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    );
  };

  const renderProviderLink = (provider: { providerID: string; title: string; matchCount: number }, index: number) => (
    <div
      role="button"
      tabIndex={0}
      ref={(el) => {
        optionRefs[index] = el as unknown as HTMLButtonElement;
      }}
      class={`group w-full text-left rounded-xl px-3 py-2.5 transition-colors cursor-pointer ${
        index === activeIndex()
          ? "bg-gray-2 text-gray-12"
          : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11"
      }`}
      onMouseEnter={() => {
        setActiveIndex(index);
      }}
      onClick={() => {
        props.onClose({ restorePromptFocus: false });
        props.onOpenSettings();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        props.onClose({ restorePromptFocus: false });
        props.onOpenSettings();
      }}
    >
      <div class="flex items-start gap-3">
        <ProviderIcon providerId={provider.providerID} size={16} class={`mt-[1px] shrink-0 transition-colors ${index === activeIndex() ? 'text-gray-12' : 'text-gray-10 group-hover:text-gray-11'}`} />
        <div class="flex-1 min-w-0">
          <div class={`text-[13px] flex items-center justify-between gap-2 text-current`}>
            <span class="truncate">{provider.title}</span>
          </div>
          <div class={`mt-0.5 flex items-center gap-3 text-[11px] ${index === activeIndex() ? 'text-gray-10' : 'text-gray-9 group-hover:text-gray-10'}`}>
            <span class="truncate">{translate("model_picker.connect_provider_hint")}</span>
            <span class="ml-auto opacity-70">
              {translate(provider.matchCount === 1 ? "model_picker.model_count_one" : "model_picker.model_count", { count: provider.matchCount })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-dls-surface border border-dls-border w-full max-w-lg rounded-[24px] shadow-[var(--dls-shell-shadow)] overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          <div class="p-6 flex flex-col min-h-0">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">
                  {translate(props.target === "default" ? "model_picker.default_model_title" : "model_picker.chat_model_title")}
                </h3>
                <p class="text-sm text-gray-11 mt-1">
                  {translate(props.target === "default"
                    ? "model_picker.default_model_desc"
                    : "model_picker.chat_model_desc")}
                </p>
              </div>
              <Button
                variant="ghost"
                class="!p-2 rounded-full"
                onClick={() => props.onClose()}
              >
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
                  {translate("settings.showing_models", { count: props.filteredOptions.length, total: props.options.length })}
                </div>
              </Show>
            </div>

            <div class="mt-4 space-y-4 overflow-y-auto pr-1 -mr-1 min-h-0">
              <Show when={recommendedOptions().length > 0}>
                <section class="space-y-2">
                  <div class="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                    {translate("model_picker.recommended")}
                  </div>
                  <For each={recommendedOptions()}>{({ opt, index }) => renderOption(opt, index)}</For>
                </section>
              </Show>

              <Show when={otherEnabledOptions().length > 0}>
                <section class="space-y-2">
                  <div class="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                    {translate("model_picker.other_connected_models")}
                  </div>
                  <For each={otherEnabledOptions()}>{({ opt, index }) => renderOption(opt, index)}</For>
                </section>
              </Show>

              <Show when={otherOptions().length > 0}>
                <section class="space-y-2">
                  <div class="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                    {translate("model_picker.more_providers")}
                  </div>
                  <For each={otherOptions()}>
                    {(provider) => renderProviderLink(provider, provider.index)}
                  </For>
                </section>
              </Show>

              <Show when={renderedItems().length === 0}>
                <div class="rounded-2xl border border-gray-6/70 bg-gray-1/40 px-4 py-6 text-sm text-gray-10">
                  {translate("model_picker.no_results")}
                </div>
              </Show>
            </div>

            <div class="mt-5 flex justify-end shrink-0">
              <Button variant="outline" onClick={() => props.onClose()}>
                {translate("settings.done")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
