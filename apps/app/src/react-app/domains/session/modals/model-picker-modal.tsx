/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { modelEquals } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";
import { ModelPickerDialog, type ProviderLinkItem } from "./model-picker-modal-components";

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
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

  const filteredOptions = useMemo(() => {
    const q = props.query.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(
      (opt) =>
        opt.title.toLowerCase().includes(q) ||
        opt.providerID.toLowerCase().includes(q) ||
        opt.modelID.toLowerCase().includes(q),
    );
  }, [props.options, props.query]);

  const otherProviderLinks = useMemo(() => {
    const seen = new Set<string>();
    const items: { providerID: string; title: string; matchCount: number }[] =
      [];
    const counts = new Map<string, number>();

    for (const opt of filteredOptions) {
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
  }, [filteredOptions]);

  const renderedItems = useMemo<RenderedItem[]>(() => {
    const models = filteredOptions.filter((opt) => opt.isConnected);
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
  }, [otherProviderLinks, filteredOptions]);

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

  const scrollActiveIntoView = useEffectEvent((idx: number) => {
    const el = optionRefs.current[idx];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  });

  const selectRenderedItem = useEffectEvent((item: RenderedItem | undefined) => {
    if (!item) return;
    if (item.kind === "provider") {
      props.onClose({ restorePromptFocus: false });
      props.onOpenSettings();
      return;
    }
    props.onSelect({
      providerID: item.opt.providerID,
      modelID: item.opt.modelID,
    });
  });

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
  }, [activeModelIndex, clampIndex, props.open]);

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
        const item = renderedItems[activeIndex];
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        selectRenderedItem(item);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeIndex, clampIndex, renderedItems]);

  if (!props.open) return null;

  const registerOptionRef = (index: number) => (el: HTMLDivElement | null) => {
    if (!el) return;
    optionRefs.current[index] = el;
  };

  return (
    <ModelPickerDialog
      target={props.target}
      query={props.query}
      totalOptions={props.options.length}
      filteredCount={filteredOptions.length}
      current={props.current}
      searchInputRef={searchInputRef}
      activeIndex={activeIndex}
      renderedCount={renderedItems.length}
      recommendedOptions={recommendedOptions}
      otherEnabledOptions={otherEnabledOptions}
      otherOptions={otherOptions}
      registerOptionRef={registerOptionRef}
      onSetQuery={props.setQuery}
      onSetActiveIndex={setActiveIndex}
      onSelect={props.onSelect}
      onBehaviorChange={props.onBehaviorChange}
      onOpenSettings={props.onOpenSettings}
      onClose={props.onClose}
    />
  );
}
