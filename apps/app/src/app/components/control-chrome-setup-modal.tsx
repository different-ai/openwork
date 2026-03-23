import { Show, createEffect, createSignal } from "solid-js";
import { Check, ExternalLink, Loader2, MonitorSmartphone, Settings2, X } from "lucide-solid";
import Button from "./button";
import { t, type Language } from "../../i18n";

export type ControlChromeSetupModalProps = {
  open: boolean;
  busy: boolean;
  language: Language;
  mode: "connect" | "edit";
  initialUseExistingProfile: boolean;
  onClose: () => void;
  onSave: (useExistingProfile: boolean) => void;
};

export default function ControlChromeSetupModal(props: ControlChromeSetupModalProps) {
  const tr = (key: string) => t(key, props.language);
  const [useExistingProfile, setUseExistingProfile] = createSignal(props.initialUseExistingProfile);

  createEffect(() => {
    if (!props.open) return;
    setUseExistingProfile(props.initialUseExistingProfile);
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-gray-1/70 backdrop-blur-sm" onClick={props.onClose} />

        <div class="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-gray-6/70 bg-gray-2 shadow-2xl">
          <div class="border-b border-gray-6 px-6 py-5 sm:px-7">
            <div class="flex items-start justify-between gap-4">
              <div class="space-y-2">
                <div class="inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-11">
                  <MonitorSmartphone size={12} />
                  Chrome DevTools MCP
                </div>
                <div>
                  <h2 class="text-xl font-semibold text-gray-12 sm:text-2xl">
                    {tr("mcp.control_chrome_setup_title")}
                  </h2>
                  <p class="mt-1 max-w-xl text-sm leading-6 text-gray-11">
                    {tr("mcp.control_chrome_setup_subtitle")}
                  </p>
                </div>
              </div>
              <button
                type="button"
                class="rounded-xl p-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
                onClick={props.onClose}
                aria-label={tr("common.cancel")}
              >
                <X size={20} />
              </button>
            </div>
          </div>

          <div class="space-y-5 px-6 py-6 sm:px-7">
            <div class="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
                  <Check size={18} />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-gray-12">
                    {tr("mcp.control_chrome_browser_title")}
                  </h3>
                  <p class="mt-1 text-sm text-gray-11">
                    {tr("mcp.control_chrome_browser_hint")}
                  </p>
                  <ol class="mt-3 space-y-2 text-sm leading-6 text-gray-12">
                    <li>1. {tr("mcp.control_chrome_browser_step_one")}</li>
                    <li>2. {tr("mcp.control_chrome_browser_step_two")}</li>
                    <li>3. {tr("mcp.control_chrome_browser_step_three")}</li>
                  </ol>
                  <a
                    href="https://github.com/ChromeDevTools/chrome-devtools-mcp"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-11 transition-colors hover:text-blue-12"
                  >
                    {tr("mcp.control_chrome_docs")}
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-3 text-gray-11">
                  <Settings2 size={18} />
                </div>
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-gray-12">
                    {tr("mcp.control_chrome_profile_title")}
                  </h3>
                  <p class="mt-1 text-sm leading-6 text-gray-11">
                    {tr("mcp.control_chrome_profile_hint")}
                  </p>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={useExistingProfile()}
                    onClick={() => setUseExistingProfile((current) => !current)}
                    class="mt-4 flex w-full items-center justify-between gap-4 rounded-2xl border border-gray-6 bg-gray-2 px-4 py-4 text-left transition-colors hover:bg-gray-3"
                  >
                    <div class="space-y-1">
                      <div class="text-sm font-semibold text-gray-12">
                        {tr("mcp.control_chrome_toggle_label")}
                      </div>
                      <div class="text-xs leading-5 text-gray-11">
                        {tr("mcp.control_chrome_toggle_hint")}
                      </div>
                    </div>

                    <div class={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${useExistingProfile() ? "bg-blue-9" : "bg-gray-6"}`}>
                      <div class={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${useExistingProfile() ? "translate-x-6" : "translate-x-1"}`} />
                    </div>
                  </button>

                  <div class="mt-3 rounded-2xl border border-dashed border-gray-6 bg-gray-2/70 px-4 py-3 text-xs leading-5 text-gray-11">
                    {useExistingProfile()
                      ? tr("mcp.control_chrome_toggle_on")
                      : tr("mcp.control_chrome_toggle_off")}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="flex flex-col-reverse gap-3 border-t border-gray-6 bg-gray-2/80 px-6 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-7">
            <Button variant="ghost" onClick={props.onClose}>
              {tr("mcp.auth.cancel")}
            </Button>
            <Button variant="secondary" onClick={() => props.onSave(useExistingProfile())} disabled={props.busy}>
              <Show when={props.busy} fallback={props.mode === "edit" ? tr("mcp.control_chrome_save") : tr("mcp.control_chrome_connect")}>
                <>
                  <Loader2 size={16} class="animate-spin" />
                  {props.mode === "edit" ? tr("mcp.control_chrome_save") : tr("mcp.control_chrome_connect")}
                </>
              </Show>
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
