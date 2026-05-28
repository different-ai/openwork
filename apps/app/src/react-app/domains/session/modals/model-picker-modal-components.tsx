/** @jsxImportSource react */
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { CheckCircle2, Circle, Search } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";
import { modelEquals } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";

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

export type ProviderLinkItem = {
  providerID: string;
  title: string;
  matchCount: number;
  index: number;
};

export function ModelPickerDialog(props: {
  target: "default" | "session";
  query: string;
  totalOptions: number;
  filteredCount: number;
  current: ModelRef;
  searchInputRef: RefObject<HTMLInputElement | null>;
  activeIndex: number;
  renderedCount: number;
  recommendedOptions: { opt: ModelOption; index: number }[];
  otherEnabledOptions: { opt: ModelOption; index: number }[];
  otherOptions: ProviderLinkItem[];
  registerOptionRef: (index: number) => (el: HTMLDivElement | null) => void;
  onSetQuery: (value: string) => void;
  onSetActiveIndex: (index: number) => void;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(props.target === "default" ? "model_picker.default_model_title" : "model_picker.chat_model_title")}
          </DialogTitle>
          <DialogDescription>
            {t(props.target === "default" ? "model_picker.default_model_desc" : "model_picker.chat_model_desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <ModelPickerSearch
            query={props.query}
            totalOptions={props.totalOptions}
            filteredCount={props.filteredCount}
            searchInputRef={props.searchInputRef}
            onSetQuery={props.onSetQuery}
          />
          <ModelPickerSections
            current={props.current}
            activeIndex={props.activeIndex}
            renderedCount={props.renderedCount}
            recommendedOptions={props.recommendedOptions}
            otherEnabledOptions={props.otherEnabledOptions}
            otherOptions={props.otherOptions}
            registerOptionRef={props.registerOptionRef}
            onSetActiveIndex={props.onSetActiveIndex}
            onSelect={props.onSelect}
            onBehaviorChange={props.onBehaviorChange}
            onOpenSettings={props.onOpenSettings}
            onClose={props.onClose}
          />
        </div>
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>
            {t("settings.done")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelPickerSearch(props: {
  query: string;
  totalOptions: number;
  filteredCount: number;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSetQuery: (value: string) => void;
}) {
  return (
    <div className="mt-5 shrink-0">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
        <input
          ref={props.searchInputRef}
          type="text"
          value={props.query}
          onChange={(event) => props.onSetQuery(event.currentTarget.value)}
          placeholder={t("settings.search_models")}
          className="w-full bg-dls-surface border border-dls-border rounded-xl py-2.5 pl-9 pr-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:border-dls-accent"
        />
      </div>
      {props.query.trim() ? (
        <div className="mt-2 text-xs text-dls-secondary">
          {t("settings.showing_models", { count: props.filteredCount, total: props.totalOptions })}
        </div>
      ) : null}
    </div>
  );
}

function ModelPickerSections(props: {
  current: ModelRef;
  activeIndex: number;
  renderedCount: number;
  recommendedOptions: { opt: ModelOption; index: number }[];
  otherEnabledOptions: { opt: ModelOption; index: number }[];
  otherOptions: ProviderLinkItem[];
  registerOptionRef: (index: number) => (el: HTMLDivElement | null) => void;
  onSetActiveIndex: (index: number) => void;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
}) {
  return (
    <div className="-mr-1 mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <ModelOptionsSection
        title={t("model_picker.recommended")}
        options={props.recommendedOptions}
        current={props.current}
        activeIndex={props.activeIndex}
        registerOptionRef={props.registerOptionRef}
        onSetActiveIndex={props.onSetActiveIndex}
        onSelect={props.onSelect}
        onBehaviorChange={props.onBehaviorChange}
      />
      <ModelOptionsSection
        title={t("model_picker.other_connected_models")}
        options={props.otherEnabledOptions}
        current={props.current}
        activeIndex={props.activeIndex}
        registerOptionRef={props.registerOptionRef}
        onSetActiveIndex={props.onSetActiveIndex}
        onSelect={props.onSelect}
        onBehaviorChange={props.onBehaviorChange}
      />
      {props.otherOptions.length > 0 ? (
        <section className="space-y-2">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
            {t("model_picker.more_providers")}
          </div>
          {props.otherOptions.map((provider) => (
            <ProviderLinkRow
              key={provider.providerID}
              provider={provider}
              activeIndex={props.activeIndex}
              registerOptionRef={props.registerOptionRef}
              onSetActiveIndex={props.onSetActiveIndex}
              onOpenSettings={props.onOpenSettings}
              onClose={props.onClose}
            />
          ))}
        </section>
      ) : null}
      {props.renderedCount === 0 ? (
        <div className="rounded-2xl border border-gray-6/70 bg-gray-1/40 px-4 py-6 text-sm text-gray-10">
          {t("model_picker.no_results")}
        </div>
      ) : null}
    </div>
  );
}

function ModelOptionsSection(props: {
  title: string;
  options: { opt: ModelOption; index: number }[];
  current: ModelRef;
  activeIndex: number;
  registerOptionRef: (index: number) => (el: HTMLDivElement | null) => void;
  onSetActiveIndex: (index: number) => void;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
}) {
  if (props.options.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
        {props.title}
      </div>
      {props.options.map(({ opt, index }) => (
        <ModelOptionRow
          key={`${opt.providerID}/${opt.modelID}`}
          opt={opt}
          index={index}
          activeIndex={props.activeIndex}
          current={props.current}
          registerOptionRef={props.registerOptionRef}
          onSetActiveIndex={props.onSetActiveIndex}
          onSelect={props.onSelect}
          onBehaviorChange={props.onBehaviorChange}
        />
      ))}
    </section>
  );
}

function ModelOptionRow(props: {
  opt: ModelOption;
  index: number;
  activeIndex: number;
  current: ModelRef;
  registerOptionRef: (index: number) => (el: HTMLDivElement | null) => void;
  onSetActiveIndex: (index: number) => void;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
}) {
  const { opt } = props;
  const active = modelEquals(props.current, {
    providerID: opt.providerID,
    modelID: opt.modelID,
  });
  const isKeyboardActive = props.index === props.activeIndex;
  const selectOption = () => props.onSelect({ providerID: opt.providerID, modelID: opt.modelID });

  return (
    <div
      role="button"
      tabIndex={0}
      ref={props.registerOptionRef(props.index)}
      className={[
        "group w-full text-left rounded-xl px-3 py-2.5 transition-colors cursor-pointer",
        active
          ? "bg-gray-3 text-gray-12"
          : isKeyboardActive
            ? "bg-gray-2 text-gray-12"
            : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11",
      ].join(" ")}
      onMouseEnter={() => props.onSetActiveIndex(props.index)}
      onClick={selectOption}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        selectOption();
      }}
    >
      <div className="flex items-start gap-3">
        <ProviderIcon
          providerId={opt.providerID}
          size={16}
          className={[
            "mt-[1px] shrink-0 transition-colors",
            active ? "text-gray-12" : "text-gray-10 group-hover:text-gray-11",
          ].join(" ")}
        />
        <div className="flex-1 min-w-0">
          <div className={["text-[13px] flex items-center justify-between gap-2", active ? "font-medium text-gray-12" : "text-current"].join(" ")}>
            <span className="truncate">{opt.title}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {opt.source === "cloud" ? (
                <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
                  Cloud
                </span>
              ) : null}
              {active ? (
                <span className="rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
                  Current
                </span>
              ) : null}
            </span>
          </div>
          <div className={["mt-0.5 flex items-center gap-3 text-[11px]", active ? "text-gray-10" : "text-gray-9 group-hover:text-gray-10"].join(" ")}>
            <span className="truncate">{opt.description ?? opt.providerID}</span>
            <span className="ml-auto opacity-70 font-mono">
              {opt.providerID}/{opt.modelID}
            </span>
          </div>
          {opt.footer ? (
            <div className={["text-[11px] mt-1", active ? "text-gray-10" : "text-gray-8 group-hover:text-gray-9"].join(" ")}>
              {opt.footer}
            </div>
          ) : null}
          {active && (opt.behaviorOptions?.length ?? 0) > 0 ? <ModelBehaviorOptions opt={opt} onBehaviorChange={props.onBehaviorChange} /> : null}
        </div>
      </div>
    </div>
  );
}

function ModelBehaviorOptions(props: {
  opt: ModelOption;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
}) {
  return (
    <div role="presentation" className="mt-3 flex items-center gap-2" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <span className="text-[11px] font-medium text-gray-10 mr-1">{props.opt.behaviorTitle}:</span>
      <div className="flex flex-wrap items-center gap-3">
        {(props.opt.behaviorOptions ?? []).map((option) => (
          <button
            key={option.value ?? "default"}
            type="button"
            className={[
              "text-[11px] transition-colors",
              props.opt.behaviorValue === option.value ? "text-gray-12 font-semibold" : "text-gray-10 hover:text-gray-12",
            ].join(" ")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onBehaviorChange({ providerID: props.opt.providerID, modelID: props.opt.modelID }, option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProviderLinkRow(props: {
  provider: ProviderLinkItem;
  activeIndex: number;
  registerOptionRef: (index: number) => (el: HTMLDivElement | null) => void;
  onSetActiveIndex: (index: number) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
}) {
  const isKeyboardActive = props.provider.index === props.activeIndex;
  const openProviderSettings = () => {
    props.onClose({ restorePromptFocus: false });
    props.onOpenSettings();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      ref={props.registerOptionRef(props.provider.index)}
      className={[
        "group w-full text-left rounded-xl px-3 py-2.5 transition-colors cursor-pointer",
        isKeyboardActive ? "bg-gray-2 text-gray-12" : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11",
      ].join(" ")}
      onMouseEnter={() => props.onSetActiveIndex(props.provider.index)}
      onClick={openProviderSettings}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        openProviderSettings();
      }}
    >
      <div className="flex items-start gap-3">
        <ProviderIcon
          providerId={props.provider.providerID}
          size={16}
          className={[
            "mt-[1px] shrink-0 transition-colors",
            isKeyboardActive ? "text-gray-12" : "text-gray-10 group-hover:text-gray-11",
          ].join(" ")}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] flex items-center justify-between gap-2 text-current">
            <span className="truncate">{props.provider.title}</span>
          </div>
          <div className={["mt-0.5 flex items-center gap-3 text-[11px]", isKeyboardActive ? "text-gray-10" : "text-gray-9 group-hover:text-gray-10"].join(" ")}>
            <span className="truncate">{t("model_picker.connect_provider_hint")}</span>
            <span className="ml-auto opacity-70">{t("model_picker.model_count", { count: props.provider.matchCount })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModelPickerSelectedIcon({ active }: { active: boolean }) {
  return active ? <CheckCircle2 size={14} /> : <Circle size={14} />;
}
