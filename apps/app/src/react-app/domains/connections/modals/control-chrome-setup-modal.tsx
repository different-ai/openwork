/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  Check,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
  Settings2,
  X,
} from "lucide-react";

import { t, type Language } from "../../../../i18n";
import { Button } from "../../../design-system/button";

export type ControlChromeSetupModalProps = {
  open: boolean;
  busy: boolean;
  language: Language;
  mode: "connect" | "edit";
  initialUseExistingProfile: boolean;
  onClose: () => void;
  onSave: (useExistingProfile: boolean) => void;
};

export function ControlChromeSetupModal(props: ControlChromeSetupModalProps) {
  const tr = (key: string) => t(key, props.language);
  const [useExistingProfile, setUseExistingProfile] = useState(
    props.initialUseExistingProfile,
  );

  useEffect(() => {
    if (!props.open) return;
    setUseExistingProfile(props.initialUseExistingProfile);
  }, [props.initialUseExistingProfile, props.open]);

  if (!props.open) return null;

  const ctaLabel =
    props.mode === "edit"
      ? tr("mcp.control_chrome_save")
      : tr("mcp.control_chrome_connect");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-gray-1/70 backdrop-blur-sm"
        onClick={props.onClose}
      />

      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-gray-6/70 bg-gray-2 shadow-2xl">
        <div className="border-b border-gray-6 px-6 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-11">
                <MonitorSmartphone size={12} />
                Chrome DevTools MCP
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-12 sm:text-2xl">
                  {tr("mcp.control_chrome_setup_title")}
                </h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-gray-11">
                  {tr("mcp.control_chrome_setup_subtitle")}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-xl p-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
              onClick={props.onClose}
              aria-label={tr("common.cancel")}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="space-y-5 px-6 py-6 sm:px-7">
          <div className="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
                <Check size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-12">
                  {tr("mcp.control_chrome_browser_title")}
                </h3>
                <p className="mt-1 text-sm text-gray-11">
                  {tr("mcp.control_chrome_browser_hint")}
                </p>
                <ol className="mt-3 space-y-2 text-sm leading-6 text-gray-12">
                  <li>1. {tr("mcp.control_chrome_browser_step_one")}</li>
                  <li>2. {tr("mcp.control_chrome_browser_step_two")}</li>
                  <li>3. {tr("mcp.control_chrome_browser_step_three")}</li>
                </ol>
                <a
                  href="https://github.com/ChromeDevTools/chrome-devtools-mcp"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-11 transition-colors hover:text-blue-12"
                >
                  {tr("mcp.control_chrome_docs")}
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-3 text-gray-11">
                <Settings2 size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-12">
                  {tr("mcp.control_chrome_profile_title")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-gray-11">
                  {tr("mcp.control_chrome_profile_hint")}
                </p>

                <button
                  type="button"
                  role="switch"
                  aria-checked={useExistingProfile}
                  onClick={() => setUseExistingProfile((current) => !current)}
                  className="mt-4 flex w-full items-center justify-between gap-4 rounded-2xl border border-gray-6 bg-gray-2 px-4 py-4 text-left transition-colors hover:bg-gray-3"
                >
                  <div className="space-y-1">
                    <div className="text-sm font-semibold text-gray-12">
                      {tr("mcp.control_chrome_toggle_label")}
                    </div>
                    <div className="text-xs leading-5 text-gray-11">
                      {tr("mcp.control_chrome_toggle_hint")}
                    </div>
                  </div>

                  <div
                    className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                      useExistingProfile ? "bg-blue-9" : "bg-gray-6"
                    }`}
                  >
                    <div
                      className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                        useExistingProfile ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </div>
                </button>

                <div className="mt-3 rounded-2xl border border-dashed border-gray-6 bg-gray-2/70 px-4 py-3 text-xs leading-5 text-gray-11">
                  {useExistingProfile
                    ? tr("mcp.control_chrome_toggle_on")
                    : tr("mcp.control_chrome_toggle_off")}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-gray-6 bg-gray-2/80 px-6 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-7">
          <Button variant="ghost" onClick={props.onClose}>
            {tr("mcp.auth.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => props.onSave(useExistingProfile)}
            disabled={props.busy}
          >
            {props.busy ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {ctaLabel}
              </>
            ) : (
              ctaLabel
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
