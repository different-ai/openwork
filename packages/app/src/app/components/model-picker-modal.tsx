import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { CheckCircle2, Circle, Repeat, Search, X } from "lucide-solid";
import type { Provider } from "@opencode-ai/sdk/v2/client";
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
  providers: Provider[];
  connectedProviderIds: string[];
  modelVariant: string | null;
  setModelVariant: (value: string | null) => void;
  onConnectProvider?: (providerId: string) => Promise<string>;
  onSelect: (model: ModelRef) => void;
  onClose: () => void;
};

export default function ModelPickerModal(props: ModelPickerModalProps) {
  let searchInputRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const [activeIndex, setActiveIndex] = createSignal(0);
  const [providerFilter, setProviderFilter] = createSignal("all");
  const [connectingProvider, setConnectingProvider] = createSignal<string | null>(null);
  const [connectMessage, setConnectMessage] = createSignal<string | null>(null);
  const optionRefs: HTMLButtonElement[] = [];

  const providerEntries = createMemo(() => {
    const providers = props.providers ?? [];
    const connected = new Set(props.connectedProviderIds ?? []);
    const optionProviderIds = new Set(props.options.map((opt) => opt.providerID));
    const entries = providers
      .filter((provider) => optionProviderIds.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name ?? provider.id,
        connected: connected.has(provider.id),
        modelCount: props.options.filter((opt) => opt.providerID === provider.id).length,
      }));

    const unknown = Array.from(optionProviderIds)
      .filter((id) => !entries.find((entry) => entry.id === id))
      .map((id) => ({
        id,
        name: id,
        connected: connected.has(id),
        modelCount: props.options.filter((opt) => opt.providerID === id).length,
      }));

    return [...entries, ...unknown].sort((a, b) => {
      const aIsOpencode = a.id === "opencode";
      const bIsOpencode = b.id === "opencode";
      if (aIsOpencode !== bIsOpencode) return aIsOpencode ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  });

  const scopedOptions = createMemo(() => {
    const filter = providerFilter();
    if (filter === "all") return props.options;
    return props.options.filter((opt) => opt.providerID === filter);
  });

  const visibleOptions = createMemo(() => {
    const filter = providerFilter();
    if (filter === "all") return props.filteredOptions;
    return props.filteredOptions.filter((opt) => opt.providerID === filter);
  });

  const groupedOptions = createMemo(() => {
    const groups: Array<{
      id: string;
      name: string;
      connected: boolean;
      modelCount: number;
      startIndex: number;
      models: ModelOption[];
    }> = [];
    let cursor = 0;

    for (const provider of providerEntries()) {
      const models = visibleOptions().filter((opt) => opt.providerID === provider.id);
      if (!models.length) continue;
      groups.push({
        ...provider,
        startIndex: cursor,
        models,
      });
      cursor += models.length;
    }

    return groups;
  });

  const activeModelIndex = createMemo(() => {
    const list = visibleOptions();
    return list.findIndex((opt) =>
      modelEquals(props.current, {
        providerID: opt.providerID,
        modelID: opt.modelID,
      }),
    );
  });

  const clampIndex = (next: number) => {
    const last = visibleOptions().length - 1;
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
    setProviderFilter(props.current?.providerID || "all");
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
        const opt = visibleOptions()[idx];
        if (!opt) return;
        event.preventDefault();
        event.stopPropagation();
        if (opt.disabled) {
          setConnectMessage(`Connect ${opt.providerName} to use ${opt.title}.`);
          return;
        }
        props.onSelect({ providerID: opt.providerID, modelID: opt.modelID });
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const variantOptions = ["", "fast", "balanced", "high", "max", "minimal"];
  const normalizedVariant = createMemo(() => (props.modelVariant ?? "").trim());
  const variantSelectValue = createMemo(() =>
    variantOptions.includes(normalizedVariant()) ? normalizedVariant() : "custom"
  );

  const setVariant = (value: string) => {
    const trimmed = value.trim();
    props.setModelVariant(trimmed ? trimmed : null);
  };

  const cycleVariant = () => {
    const current = normalizedVariant();
    const index = variantOptions.indexOf(current);
    const next = variantOptions[index >= 0 ? (index + 1) % variantOptions.length : 0];
    setVariant(next);
  };

  const handleConnectProvider = async (providerId: string, providerName: string) => {
    if (!props.onConnectProvider || connectingProvider() === providerId) return;
    setConnectingProvider(providerId);
    setConnectMessage(null);
    try {
      const message = await props.onConnectProvider(providerId);
      if (message) {
        setConnectMessage(message);
      } else {
        setConnectMessage(`Started ${providerName} authentication.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect provider";
      setConnectMessage(message);
    } finally {
      setConnectingProvider(null);
    }
  };

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

            <div class="mt-5 space-y-4">
              <div>
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
                    {translate("settings.showing_models")
                      .replace("{count}", String(visibleOptions().length))
                      .replace("{total}", String(scopedOptions().length))}
                  </div>
                </Show>
              </div>

              <Show when={providerEntries().length}>
                <div>
                  <div class="text-[10px] uppercase tracking-[0.2em] text-gray-8">Providers</div>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      class={`px-3 py-1.5 rounded-full text-[11px] border transition-colors ${
                        providerFilter() === "all"
                          ? "bg-gray-12 text-gray-1 border-gray-12"
                          : "bg-gray-1/50 text-gray-10 border-gray-6 hover:bg-gray-1/70"
                      }`}
                      onClick={() => setProviderFilter("all")}
                    >
                      All providers
                    </button>
                    <For each={providerEntries()}>
                      {(entry) => (
                        <button
                          type="button"
                          class={`px-3 py-1.5 rounded-full text-[11px] border transition-colors flex items-center gap-2 ${
                            providerFilter() === entry.id
                              ? "bg-gray-12 text-gray-1 border-gray-12"
                              : "bg-gray-1/50 text-gray-10 border-gray-6 hover:bg-gray-1/70"
                          }`}
                          onClick={() => setProviderFilter(entry.id)}
                        >
                          <span class="truncate max-w-[120px]">{entry.name}</span>
                          <span class="text-[10px] text-gray-7">{entry.modelCount}</span>
                          <Show when={entry.connected}>
                            <span class="text-[9px] uppercase tracking-[0.18em] text-green-11">Connected</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <div class="rounded-xl border border-gray-6/70 bg-gray-1/40 p-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-[10px] uppercase tracking-[0.2em] text-gray-8">
                      {translate("settings.model_variant")}
                    </div>
                    <div class="text-xs text-gray-10 mt-1 font-mono">
                      {normalizedVariant() || translate("common.default_parens")}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    class="text-xs h-8 px-3 flex items-center gap-2"
                    onClick={cycleVariant}
                  >
                    <Repeat size={14} />
                    Cycle
                  </Button>
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    class="bg-gray-1/60 border border-gray-6 rounded-lg px-3 py-2 text-xs text-gray-12 focus:outline-none"
                    value={variantSelectValue()}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      if (next === "custom") return;
                      setVariant(next);
                    }}
                  >
                    <option value="">Default</option>
                    <For each={variantOptions.slice(1)}>
                      {(value) => (
                        <option value={value}>{value}</option>
                      )}
                    </For>
                    <option value="custom">Custom…</option>
                  </select>
                  <Show when={variantSelectValue() === "custom"}>
                    <input
                      type="text"
                      value={props.modelVariant ?? ""}
                      onInput={(e) => setVariant(e.currentTarget.value)}
                      placeholder="Variant"
                      class="flex-1 min-w-[140px] bg-gray-1/60 border border-gray-6 rounded-lg px-3 py-2 text-xs text-gray-12 focus:outline-none"
                    />
                  </Show>
                </div>
              </div>

              <Show when={connectMessage()}>
                <div class="rounded-xl border border-amber-7/30 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
                  {connectMessage()}
                </div>
              </Show>
            </div>

            <div class="mt-4 space-y-4 overflow-y-auto pr-1 -mr-1 min-h-0">
              <Show
                when={groupedOptions().length}
                fallback={<div class="text-sm text-gray-10">No models found.</div>}
              >
                <For each={groupedOptions()}>
                  {(group) => (
                    <div class="space-y-2">
                      <div class="flex items-center justify-between gap-3 px-1">
                        <div class="min-w-0">
                          <div class="text-sm font-semibold text-gray-12 truncate">{group.name}</div>
                          <div class="text-[11px] text-gray-8">{group.modelCount} models</div>
                        </div>
                        <div class="flex items-center gap-2">
                          <Show
                            when={group.connected}
                            fallback={
                              <span class="text-[10px] uppercase tracking-[0.18em] text-gray-8">Needs auth</span>
                            }
                          >
                            <span class="text-[10px] uppercase tracking-[0.18em] text-green-11">Connected</span>
                          </Show>
                          <Show when={!group.connected && props.onConnectProvider}>
                            <Button
                              variant="outline"
                              class="text-[11px] h-7 px-2"
                              disabled={connectingProvider() === group.id}
                              onClick={() => handleConnectProvider(group.id, group.name)}
                            >
                              {connectingProvider() === group.id ? "Connecting..." : "Connect"}
                            </Button>
                          </Show>
                        </div>
                      </div>

                      <div class="space-y-2">
                        <For each={group.models}>
                          {(opt, idx) => {
                            const active = () =>
                              modelEquals(props.current, {
                                providerID: opt.providerID,
                                modelID: opt.modelID,
                              });

                            const i = () => group.startIndex + idx();

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
                                      : opt.disabled
                                        ? "border-gray-6/40 bg-gray-1/30"
                                        : "border-gray-6/70 bg-gray-1/40 hover:bg-gray-1/60"
                                } ${opt.disabled ? "opacity-70 cursor-not-allowed" : ""}`}
                                onMouseEnter={() => {
                                  setActiveIndex(i());
                                }}
                                onClick={() => {
                                  if (opt.disabled) {
                                    setConnectMessage(`Connect ${opt.providerName} to use ${opt.title}.`);
                                    return;
                                  }
                                  props.onSelect({
                                    providerID: opt.providerID,
                                    modelID: opt.modelID,
                                  });
                                }}
                                disabled={opt.disabled}
                              >
                                <div class="flex items-start justify-between gap-3">
                                  <div class="min-w-0">
                                    <div class="text-sm font-medium text-gray-12 flex items-center gap-2">
                                      <span class="truncate">{opt.title}</span>
                                    </div>
                                    <Show when={opt.description}>
                                      <div class="text-xs text-gray-10 mt-1 truncate">{opt.description}</div>
                                    </Show>
                                    <Show when={opt.tags?.length}>
                                      <div class="mt-2 flex flex-wrap gap-2">
                                        <For each={opt.tags}>
                                          {(tag) => (
                                            <span class="text-[10px] uppercase tracking-[0.18em] px-2 py-1 rounded-full border border-gray-6 text-gray-10 bg-gray-1/60">
                                              {tag}
                                            </span>
                                          )}
                                        </For>
                                      </div>
                                    </Show>
                                    <Show when={opt.metadata?.length}>
                                      <div class="text-[11px] text-gray-8 mt-2">
                                        {opt.metadata?.join(" · ")}
                                      </div>
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
                    </div>
                  )}
                </For>
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
