import { createSignal, For, Show, createMemo } from "solid-js";
import { CheckCircle2, Loader2, X, AlertCircle } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import { templateCatalog, loadTemplate } from "../data/templates/index";
import type { TemplateSummary } from "../data/templates/index";
import { installTemplate } from "../data/templates/installer";
import type { InstallResult } from "../data/templates/installer";

export default function TemplatePickerModal(props: {
  open: boolean;
  onClose: () => void;
  projectDir: string;
  onInstalled?: (templateId: string) => void;
}) {
  const translate = (key: string) => t(key, currentLocale());

  const [selected, setSelected] = createSignal<string | null>(null);
  const [installing, setInstalling] = createSignal(false);
  const [result, setResult] = createSignal<InstallResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal<"all" | "industry" | "function">("all");

  const filtered = createMemo(() => {
    const f = filter();
    if (f === "all") return templateCatalog;
    return templateCatalog.filter((t) => t.category === f);
  });

  const selectedInfo = createMemo(() => {
    const id = selected();
    if (!id) return null;
    return templateCatalog.find((t) => t.id === id) ?? null;
  });

  const handleInstall = async () => {
    const id = selected();
    if (!id || installing()) return;

    setInstalling(true);
    setError(null);
    setResult(null);

    try {
      const template = await loadTemplate(id);
      const res = await installTemplate(props.projectDir, template);
      setResult(res);
      if (res.ok) {
        props.onInstalled?.(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleClose = () => {
    if (installing()) return;
    setSelected(null);
    setResult(null);
    setError(null);
    setFilter("all");
    props.onClose();
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div class="bg-gray-2 border border-gray-6 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
          {/* Header */}
          <div class="p-6 border-b border-gray-6 flex justify-between items-center bg-gray-1">
            <div>
              <h3 class="font-semibold text-gray-12 text-lg">
                {translate("templates.title")}
              </h3>
              <p class="text-gray-10 text-sm">
                {translate("templates.subtitle")}
              </p>
            </div>
            <button
              onClick={handleClose}
              disabled={installing()}
              class={`hover:bg-gray-4 p-1 rounded-full ${installing() ? "opacity-50 cursor-not-allowed" : ""}`.trim()}
            >
              <X size={20} class="text-gray-10" />
            </button>
          </div>

          {/* Filter tabs */}
          <div class="px-6 pt-4 flex gap-2">
            {(["all", "industry", "function"] as const).map((f) => (
              <button
                class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  filter() === f
                    ? "bg-indigo-7/10 text-indigo-11 border border-indigo-7/50"
                    : "text-gray-10 hover:text-gray-12 border border-transparent hover:bg-gray-4"
                }`}
                onClick={() => setFilter(f)}
              >
                {f === "all"
                  ? translate("templates.filter_all")
                  : f === "industry"
                    ? translate("templates.filter_industry")
                    : translate("templates.filter_function")}
              </button>
            ))}
          </div>

          {/* Template grid */}
          <div class="p-6 flex-1 overflow-y-auto">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <For each={filtered()}>
                {(tmpl: TemplateSummary) => (
                  <div
                    onClick={() => {
                      if (installing()) return;
                      setSelected(tmpl.id);
                      setResult(null);
                      setError(null);
                    }}
                    class={`p-4 rounded-xl border cursor-pointer transition-all ${
                      selected() === tmpl.id
                        ? "bg-indigo-7/10 border-indigo-7/50"
                        : "bg-gray-2 border-gray-6 hover:border-gray-7"
                    } ${installing() ? "pointer-events-none opacity-60" : ""}`.trim()}
                  >
                    <div class="flex justify-between items-start">
                      <div class="min-w-0 flex-1">
                        <div
                          class={`font-medium text-sm ${
                            selected() === tmpl.id ? "text-indigo-11" : "text-gray-12"
                          }`}
                        >
                          {tmpl.name}
                        </div>
                        <div class="text-xs text-gray-10 mt-1 line-clamp-2">
                          {tmpl.description}
                        </div>
                        <div class="text-[10px] text-gray-9 mt-2 uppercase tracking-wider">
                          {tmpl.audience}
                        </div>
                      </div>
                      <Show when={selected() === tmpl.id}>
                        <CheckCircle2 size={16} class="text-indigo-6 shrink-0 ml-2" />
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* Footer */}
          <div class="p-6 border-t border-gray-6 bg-gray-1 flex flex-col gap-3">
            {/* Success message */}
            <Show when={result()?.ok}>
              <div class="rounded-xl border border-emerald-7/30 bg-emerald-2/40 px-4 py-3 text-xs text-emerald-11">
                <div class="flex items-center gap-2 font-semibold text-emerald-12">
                  <CheckCircle2 size={14} />
                  {translate("templates.installed_success")}
                </div>
                <div class="mt-1">
                  {result()!.skillsInstalled} skills, {result()!.commandsInstalled}{" "}
                  {translate("templates.commands_installed")}
                </div>
                <Show when={selectedInfo()?.locale === "es" || selectedInfo()?.locale === "en"}>
                  <div class="mt-2 text-emerald-10">
                    {translate("templates.suggested_mcps_hint")}
                  </div>
                </Show>
              </div>
            </Show>

            {/* Error message */}
            <Show when={error() || (result() && !result()!.ok)}>
              <div class="rounded-xl border border-red-7/30 bg-red-2/40 px-4 py-3 text-xs text-red-11">
                <div class="flex items-center gap-2 font-semibold text-red-12">
                  <AlertCircle size={14} />
                  {translate("templates.install_error")}
                </div>
                <div class="mt-1">
                  {error() ?? result()?.errors.join(", ")}
                </div>
              </div>
            </Show>

            <div class="flex justify-end gap-3">
              <Button variant="ghost" onClick={handleClose} disabled={installing()}>
                {result()?.ok ? translate("common.close") : translate("common.cancel")}
              </Button>
              <Show when={!result()?.ok}>
                <Button
                  onClick={handleInstall}
                  disabled={!selected() || installing()}
                >
                  <Show when={installing()} fallback={translate("templates.install_button")}>
                    <span class="inline-flex items-center gap-2">
                      <Loader2 size={16} class="animate-spin" />
                      {translate("templates.installing")}
                    </span>
                  </Show>
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
