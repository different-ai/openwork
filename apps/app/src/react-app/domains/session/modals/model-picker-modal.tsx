/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CheckCircle2, Circle, Search, X } from "lucide-react";

import { t } from "../../../../i18n";
import { modelEquals } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";

// Minimal inline provider icon placeholder. The full ProviderIcon gets ported
// from src/app/components/provider-icon.tsx in a later step of the plan.
function ProviderIcon({
  providerId,
  size = 16,
  className,
}: {
  providerId: string;
  size?: number;
  className?: string;
}) {
  const initial = providerId.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize: Math.round(size * 0.65),
        fontWeight: 600,
      }}
    >
      {initial}
    </span>
  );
}

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

type RenderedItem =
  | { kind: "model"; opt: ModelOption }
  | {
      kind: "provider";
      providerID: string;
      title: string;
      matchCount: number;
    };

export function ModelPickerModal(props: ModelPickerModalProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<HTMLDivElement[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      t(key, undefined, params),
    [],
  );

  const otherProviderLinks = useMemo(() => {
    const seen = new Set<string>();
    const items: { providerID: string; title: string; matchCount: number }[] =
      [];
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
  }, [props.filteredOptions]);

  const renderedItems = useMemo<RenderedItem[]>(() => {
    const models = props.filteredOptions.filter((opt) => opt.isConnected);
    const recommended = models.filter((opt) => opt.isRecommended);
    const others = models.filter((opt) => !opt.isRecommended);
    return [
      ...recommended.map((opt) => ({ kind: "model" as const, opt })),
      ...others.map((opt) => ({ kind: "model" as const, opt })),
      ...otherProviderLinks.map((item) => ({
        kind: "provider" as const,
        ...item,
      })),
    ];
  }, [otherProviderLinks, props.filteredOptions]);

  const activeModelIndex = useMemo(
    () =>
      renderedItems.findIndex(
        (item) =>
          item.kind === "model" &&
          modelEquals(props.current, {
            providerID: item.opt.providerID,
            modelID: item.opt.modelID,
          }),
      ),
    [props.current, renderedItems],
  );

  const recommendedOptions = useMemo(
    () =>
      renderedItems.flatMap((item, index) =>
        item.kind === "model" && item.opt.isRecommended
          ? [{ opt: item.opt, index }]
          : [],
      ),
    [renderedItems],
  );

  const otherEnabledOptions = useMemo(
    () =>
      renderedItems.flatMap((item, index) =>
        item.kind === "model" && !item.opt.isRecommended
          ? [{ opt: item.opt, index }]
          : [],
      ),
    [renderedItems],
  );

  const otherOptions = useMemo(
    () =>
      renderedItems.flatMap((item, index) =>
        item.kind === "provider"
          ? [
              {
                providerID: item.providerID,
                title: item.title,
                matchCount: item.matchCount,
                index,
              },
            ]
          : [],
      ),
    [renderedItems],
  );

  const clampIndex = useCallback(
    (next: number) => {
      const last = renderedItems.length - 1;
      if (last < 0) return 0;
      return Math.max(0, Math.min(next, last));
    },
    [renderedItems.length],
  );

  const scrollActiveIntoView = useCallback((idx: number) => {
    const el = optionRefs.current[idx];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  }, []);

  // Focus the search input whenever the modal opens.
  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      if (searchInputRef.current?.value) {
        searchInputRef.current.select();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  // Keep the active option in sync with the current model on open / list change.
  useEffect(() => {
    if (!props.open) return;
    const next = activeModelIndex >= 0 ? activeModelIndex : 0;
    const clamped = clampIndex(next);
    setActiveIndex(clamped);
    const frame = requestAnimationFrame(() => scrollActiveIntoView(clamped));
    return () => cancelAnimationFrame(frame);
  }, [activeModelIndex, clampIndex, props.open, scrollActiveIntoView]);

  // Window-level key handling.
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
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
        setActiveIndex((current) => {
          const item = renderedItems[current];
          if (!item) return current;
          event.preventDefault();
          event.stopPropagation();
          if (item.kind === "provider") {
            props.onClose({ restorePromptFocus: false });
            props.onOpenSettings();
            return current;
          }
          props.onSelect({
            providerID: item.opt.providerID,
            modelID: item.opt.modelID,
          });
          return current;
        });
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clampIndex, props, renderedItems, scrollActiveIntoView]);

  if (!props.open) return null;

  const registerOptionRef = (index: number) => (el: HTMLDivElement | null) => {
    if (!el) return;
    optionRefs.current[index] = el;
  };

  const renderOption = (opt: ModelOption, index: number) => {
    const active = modelEquals(props.current, {
      providerID: opt.providerID,
      modelID: opt.modelID,
    });
    const isKeyboardActive = index === activeIndex;

    return (
      <div
        key={`${opt.providerID}/${opt.modelID}`}
        role="button"
        tabIndex={0}
        ref={registerOptionRef(index)}
        className={[
          "group w-full text-left rounded-xl px-3 py-2.5 transition-colors cursor-pointer",
          active
            ? "bg-gray-3 text-gray-12"
            : isKeyboardActive
              ? "bg-gray-2 text-gray-12"
              : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11",
        ].join(" ")}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() =>
          props.onSelect({
            providerID: opt.providerID,
            modelID: opt.modelID,
          })
        }
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          props.onSelect({
            providerID: opt.providerID,
            modelID: opt.modelID,
          });
        }}
      >
        <div className="flex items-start gap-3">
          <ProviderIcon
            providerId={opt.providerID}
            size={16}
            className={[
              "mt-[1px] shrink-0 transition-colors",
              active
                ? "text-gray-12"
                : "text-gray-10 group-hover:text-gray-11",
            ].join(" ")}
          />
          <div className="flex-1 min-w-0">
            <div
              className={[
                "text-[13px] flex items-center justify-between gap-2",
                active ? "font-medium text-gray-12" : "text-current",
              ].join(" ")}
            >
              <span className="truncate">{opt.title}</span>
            </div>
            <div
              className={[
                "mt-0.5 flex items-center gap-3 text-[11px]",
                active
                  ? "text-gray-10"
                  : "text-gray-9 group-hover:text-gray-10",
              ].join(" ")}
            >
              <span className="truncate">
                {opt.description ?? opt.providerID}
              </span>
              <span className="ml-auto opacity-70 font-mono">
                {opt.providerID}/{opt.modelID}
              </span>
            </div>
            {opt.footer ? (
              <div
                className={[
                  "text-[11px] mt-1",
                  active
                    ? "text-gray-10"
                    : "text-gray-8 group-hover:text-gray-9",
                ].join(" ")}
              >
                {opt.footer}
              </div>
            ) : null}
            {active && (opt.behaviorOptions?.length ?? 0) > 0 ? (
              <div
                className="mt-3 flex items-center gap-2"
                onKeyDown={(event) => event.stopPropagation()}
              >
                <span className="text-[11px] font-medium text-gray-10 mr-1">
                  {opt.behaviorTitle}:
                </span>
                <div
                  className="flex flex-wrap items-center gap-3"
                  onClick={(event) => event.stopPropagation()}
                >
                  {(opt.behaviorOptions ?? []).map((option) => (
                    <button
                      key={option.value ?? "default"}
                      type="button"
                      className={[
                        "text-[11px] transition-colors",
                        opt.behaviorValue === option.value
                          ? "text-gray-12 font-semibold"
                          : "text-gray-10 hover:text-gray-12",
                      ].join(" ")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onBehaviorChange(
                          {
                            providerID: opt.providerID,
                            modelID: opt.modelID,
                          },
                          option.value,
                        );
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderProviderLink = (provider: {
    providerID: string;
    title: string;
    matchCount: number;
    index: number;
  }) => {
    const isKeyboardActive = provider.index === activeIndex;
    return (
      <div
        key={provider.providerID}
        role="button"
        tabIndex={0}
        ref={registerOptionRef(provider.index)}
        className={[
          "group w-full text-left rounded-xl px-3 py-2.5 transition-colors cursor-pointer",
          isKeyboardActive
            ? "bg-gray-2 text-gray-12"
            : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11",
        ].join(" ")}
        onMouseEnter={() => setActiveIndex(provider.index)}
        onClick={() => {
          props.onClose({ restorePromptFocus: false });
          props.onOpenSettings();
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          props.onClose({ restorePromptFocus: false });
          props.onOpenSettings();
        }}
      >
        <div className="flex items-start gap-3">
          <ProviderIcon
            providerId={provider.providerID}
            size={16}
            className={[
              "mt-[1px] shrink-0 transition-colors",
              isKeyboardActive
                ? "text-gray-12"
                : "text-gray-10 group-hover:text-gray-11",
            ].join(" ")}
          />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] flex items-center justify-between gap-2 text-current">
              <span className="truncate">{provider.title}</span>
            </div>
            <div
              className={[
                "mt-0.5 flex items-center gap-3 text-[11px]",
                isKeyboardActive
                  ? "text-gray-10"
                  : "text-gray-9 group-hover:text-gray-10",
              ].join(" ")}
            >
              <span className="truncate">
                {translate("model_picker.connect_provider_hint")}
              </span>
              <span className="ml-auto opacity-70">
                {translate(
                  provider.matchCount === 1
                    ? "model_picker.model_count_one"
                    : "model_picker.model_count",
                  { count: provider.matchCount },
                )}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-dls-surface border border-dls-border w-full max-w-lg rounded-[24px] shadow-[var(--dls-shell-shadow)] overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
        <div className="p-6 flex flex-col min-h-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-12">
                {translate(
                  props.target === "default"
                    ? "model_picker.default_model_title"
                    : "model_picker.chat_model_title",
                )}
              </h3>
              <p className="text-sm text-gray-11 mt-1">
                {translate(
                  props.target === "default"
                    ? "model_picker.default_model_desc"
                    : "model_picker.chat_model_desc",
                )}
              </p>
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-[var(--dls-hover)]"
              onClick={() => props.onClose()}
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-5">
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={props.query}
                onChange={(event) => props.setQuery(event.currentTarget.value)}
                placeholder={translate("settings.search_models")}
                className="w-full bg-dls-surface border border-dls-border rounded-xl py-2.5 pl-9 pr-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:border-dls-accent"
              />
            </div>
            {props.query.trim() ? (
              <div className="mt-2 text-xs text-dls-secondary">
                {translate("settings.showing_models", {
                  count: props.filteredOptions.length,
                  total: props.options.length,
                })}
              </div>
            ) : null}
          </div>

          <div className="mt-4 space-y-4 overflow-y-auto pr-1 -mr-1 min-h-0">
            {recommendedOptions.length > 0 ? (
              <section className="space-y-2">
                <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                  {translate("model_picker.recommended")}
                </div>
                {recommendedOptions.map(({ opt, index }) =>
                  renderOption(opt, index),
                )}
              </section>
            ) : null}

            {otherEnabledOptions.length > 0 ? (
              <section className="space-y-2">
                <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                  {translate("model_picker.other_connected_models")}
                </div>
                {otherEnabledOptions.map(({ opt, index }) =>
                  renderOption(opt, index),
                )}
              </section>
            ) : null}

            {otherOptions.length > 0 ? (
              <section className="space-y-2">
                <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
                  {translate("model_picker.more_providers")}
                </div>
                {otherOptions.map(renderProviderLink)}
              </section>
            ) : null}

            {renderedItems.length === 0 ? (
              <div className="rounded-2xl border border-gray-6/70 bg-gray-1/40 px-4 py-6 text-sm text-gray-10">
                {translate("model_picker.no_results")}
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex justify-end shrink-0">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-dls-border px-4 py-2 text-[13px] font-medium text-dls-text transition-colors hover:bg-[var(--dls-hover)]"
              onClick={() => props.onClose()}
            >
              {translate("settings.done")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Small helper so downstream callers can keep the check/circle icons
// colocated with the picker (future use for selected-state ornaments).
export function ModelPickerSelectedIcon({ active }: { active: boolean }) {
  return active ? <CheckCircle2 size={14} /> : <Circle size={14} />;
}
