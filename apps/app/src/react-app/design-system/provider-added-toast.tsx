/** @jsxImportSource react */
import { X } from "lucide-react";
import { ProviderIcon } from "./provider-icon";

export type ProviderAddedToastProps = {
  open: boolean;
  providerName: string;
  providerId: string;
  modelName?: string;
  onSwitchDefault: () => void;
  onDismiss: () => void;
};

/**
 * Toast shown when a new provider is added (e.g. from cloud sync).
 * Appears at the bottom of the screen, offers to switch default model.
 */
export function ProviderAddedToast(props: ProviderAddedToastProps) {
  if (!props.open) return null;

  return (
    <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-center gap-3 rounded-2xl border border-dls-border bg-dls-surface px-4 py-3 shadow-lg">
        <ProviderIcon providerId={props.providerId} size={20} className="shrink-0 text-dls-text" />

        <div className="min-w-0">
          <div className="text-[13px] font-medium text-dls-text">
            {props.providerName} added
          </div>
          <div className="text-[11px] text-dls-secondary">
            {props.modelName
              ? `Use ${props.modelName} as your default?`
              : `Use ${props.providerName} as your default?`}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded-full bg-dls-accent px-3 py-1.5 text-[11px] font-semibold text-[var(--dls-accent-fg)] transition-colors hover:bg-[var(--dls-accent-hover)]"
            onClick={props.onSwitchDefault}
          >
            Switch default
          </button>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onDismiss}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
