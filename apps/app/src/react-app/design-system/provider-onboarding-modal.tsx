/** @jsxImportSource react */
import { CheckCircle2, Sparkles, X } from "lucide-react";
import { ProviderIcon } from "./provider-icon";
import {
  modalOverlayClass,
  modalShellClass,
  modalHeaderClass,
  modalHeaderButtonClass,
  modalTitleClass,
  modalSubtitleClass,
  modalBodyClass,
  modalFooterClass,
  pillPrimaryClass,
  pillGhostClass,
  surfaceCardClass,
} from "../domains/workspace/modal-styles";

export type ProviderOnboardingItem = {
  id: string;
  name: string;
  recommended?: boolean;
  recommendedModel?: string;
};

export type ProviderOnboardingModalProps = {
  open: boolean;
  onClose: () => void;
  orgName: string;
  providers: ProviderOnboardingItem[];
  onAcceptDefaults: () => void;
  onConfigureManually: () => void;
};

/**
 * Shown after first sign-in when the user's org has pre-configured providers.
 * Presents what's available and offers to set team defaults.
 */
export function ProviderOnboardingModal(props: ProviderOnboardingModalProps) {
  if (!props.open || props.providers.length === 0) return null;

  const recommended = props.providers.find((p) => p.recommended);

  return (
    <div className={modalOverlayClass} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div
        className={`${modalShellClass} max-w-[480px]`}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className={modalHeaderClass}>
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
              <Sparkles size={24} className="text-dls-text" />
            </div>
            <div className="min-w-0">
              <h3 className={modalTitleClass}>
                {props.orgName ? `${props.orgName} is ready` : "AI providers ready"}
              </h3>
              <p className={modalSubtitleClass}>
                {props.providers.length === 1
                  ? "1 provider is configured for this workspace."
                  : `${props.providers.length} providers are configured for this workspace.`}
              </p>
            </div>
          </div>
          <button type="button" onClick={props.onClose} className={modalHeaderButtonClass} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className={modalBodyClass}>
          <div className="space-y-4">
            {/* Provider list */}
            <div className="space-y-2">
              {props.providers.map((provider) => (
                <div
                  key={provider.id}
                  className={`${surfaceCardClass} flex items-center justify-between gap-3 px-4 py-3 ${
                    provider.recommended ? "ring-1 ring-dls-accent/20" : ""
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-dls-text">{provider.name}</div>
                      {provider.recommendedModel ? (
                        <div className="truncate font-mono text-[11px] text-dls-secondary">
                          {provider.recommendedModel}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <CheckCircle2 size={16} className="shrink-0 text-green-11" />
                </div>
              ))}
            </div>

            {recommended?.recommendedModel ? (
              <div className="rounded-xl border border-dls-border bg-dls-hover/50 px-4 py-3 text-[13px] text-dls-secondary">
                Use <span className="font-medium text-dls-text">{recommended.recommendedModel}</span> as your default model.
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className={modalFooterClass}>
          <div className="flex justify-end gap-3">
            <button type="button" className={pillGhostClass} onClick={props.onConfigureManually}>
              Skip
            </button>
            <button type="button" className={pillPrimaryClass} onClick={props.onAcceptDefaults}>
              {recommended?.recommendedModel ? `Use ${recommended.recommendedModel}` : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
