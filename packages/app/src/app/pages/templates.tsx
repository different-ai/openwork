import { For, Show, createSignal } from "solid-js";

import type { WorkspaceTemplate } from "../types";
import { formatRelativeTime } from "../utils";

import Button from "../components/button";
import { FileText, Play, Plus, Trash2, Bug, X } from "lucide-solid";

export type TemplatesViewProps = {
  busy: boolean;
  workspaceTemplates: WorkspaceTemplate[];
  globalTemplates: WorkspaceTemplate[];
  setTemplateDraftTitle: (value: string) => void;
  setTemplateDraftDescription: (value: string) => void;
  setTemplateDraftPrompt: (value: string) => void;
  setTemplateDraftScope: (value: "workspace" | "global") => void;
  openTemplateModal: () => void;
  resetTemplateDraft?: (scope?: "workspace" | "global") => void;
  runTemplate: (template: WorkspaceTemplate) => void;
  deleteTemplate: (templateId: string) => void;
};

export default function TemplatesView(props: TemplatesViewProps) {
  const [debugOpen, setDebugOpen] = createSignal(false);

  const openNewTemplate = () => {
    const reset = props.resetTemplateDraft;
    if (reset) {
      reset("workspace");
    } else {
      props.setTemplateDraftTitle("");
      props.setTemplateDraftDescription("");
      props.setTemplateDraftPrompt("");
      props.setTemplateDraftScope("workspace");
    }
    props.openTemplateModal();
  };

  // Debug: Log template data when component mounts or templates change
  const logTemplates = () => {
    console.log("[DEBUG Templates] Workspace Templates:", props.workspaceTemplates);
    console.log("[DEBUG Templates] Global Templates:", props.globalTemplates);
    props.workspaceTemplates.forEach((t, i) => {
      console.log(`[DEBUG] Workspace Template ${i}:`, {
        id: t.id,
        title: t.title,
        autoRun: t.autoRun,
        autoRunType: typeof t.autoRun,
        autoRunStrictEqual: t.autoRun === false,
        autoRunLooseEqual: t.autoRun == false,
      });
    });
  };

  // Log on mount
  logTemplates();

  return (
    <section class="space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider">Templates</h3>
        <Button variant="secondary" onClick={openNewTemplate} disabled={props.busy}>
          <Plus size={16} />
          New
        </Button>
      </div>

      <Show
        when={props.workspaceTemplates.length || props.globalTemplates.length}
        fallback={
          <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-6 text-sm text-gray-10">
            Starter templates will appear here. Create one or save from a session.
          </div>
        }
      >
        <div class="space-y-6">
          <Show when={props.workspaceTemplates.length}>
            <div class="space-y-3">
              <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">Workspace</div>
              <For each={props.workspaceTemplates}>
                {(t) => (
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 flex items-start justify-between gap-4">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <FileText size={16} class="text-indigo-11" />
                        <div class="font-medium text-gray-12 truncate">{t.title}</div>
                      </div>
                      <div class="mt-1 text-sm text-gray-10">{t.description || ""}</div>
                      <div class="mt-2 text-xs text-gray-7 font-mono">{formatRelativeTime(t.createdAt)}</div>
                    </div>
                    <div class="shrink-0 flex gap-2">
                      <Button variant="secondary" onClick={() => props.runTemplate(t)} disabled={props.busy}>
                        <Play size={16} />
                        Run
                      </Button>
                      <Button variant="danger" onClick={() => props.deleteTemplate(t.id)} disabled={props.busy}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={props.globalTemplates.length}>
            <div class="space-y-3">
              <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">Global</div>
              <For each={props.globalTemplates}>
                {(t) => (
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 flex items-start justify-between gap-4">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <FileText size={16} class="text-green-11" />
                        <div class="font-medium text-gray-12 truncate">{t.title}</div>
                      </div>
                      <div class="mt-1 text-sm text-gray-10">{t.description || ""}</div>
                      <div class="mt-2 text-xs text-gray-7 font-mono">{formatRelativeTime(t.createdAt)}</div>
                    </div>
                    <div class="shrink-0 flex gap-2">
                      <Button variant="secondary" onClick={() => props.runTemplate(t)} disabled={props.busy}>
                        <Play size={16} />
                        Run
                      </Button>
                      <Button variant="danger" onClick={() => props.deleteTemplate(t.id)} disabled={props.busy}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Debug Panel Toggle Button */}
      <button
        onClick={() => {
          setDebugOpen(!debugOpen());
          logTemplates();
        }}
        class="fixed bottom-4 right-4 z-50 bg-amber-600 hover:bg-amber-500 text-white p-2 rounded-full shadow-lg"
        title="Toggle Template Debug Panel"
      >
        <Bug size={20} />
      </button>

      {/* Floating Debug Panel */}
      <Show when={debugOpen()}>
        <div class="fixed bottom-16 right-4 z-50 w-96 max-h-[70vh] bg-gray-1 border border-amber-600 rounded-xl shadow-2xl overflow-hidden">
          <div class="bg-amber-600 text-white px-4 py-2 flex items-center justify-between">
            <span class="font-semibold text-sm">🐛 Templates Debug Panel</span>
            <button onClick={() => setDebugOpen(false)} class="hover:bg-amber-500 p-1 rounded">
              <X size={16} />
            </button>
          </div>
          <div class="p-4 overflow-y-auto max-h-[calc(70vh-3rem)] text-xs font-mono">
            <div class="mb-4">
              <div class="text-amber-400 font-bold mb-2">Workspace Templates ({props.workspaceTemplates.length})</div>
              <For each={props.workspaceTemplates} fallback={<div class="text-gray-10">No workspace templates</div>}>
                {(t) => (
                  <div class="mb-3 p-2 bg-gray-2 rounded border border-gray-6">
                    <div class="text-gray-12 font-semibold">{t.title}</div>
                    <div class="text-gray-10 mt-1">ID: {t.id}</div>
                    <div class="mt-1">
                      <span class="text-gray-10">autoRun: </span>
                      <span class={t.autoRun === false ? "text-red-400 font-bold" : "text-green-400 font-bold"}>
                        {String(t.autoRun)}
                      </span>
                      <span class="text-gray-7"> (type: {typeof t.autoRun})</span>
                    </div>
                    <div class="text-gray-10 mt-1">
                      autoRun !== false: {String(t.autoRun !== false)}
                    </div>
                    <div class="text-gray-7 mt-1 truncate" title={t.prompt}>
                      Prompt: {t.prompt.slice(0, 50)}...
                    </div>
                  </div>
                )}
              </For>
            </div>

            <div>
              <div class="text-green-400 font-bold mb-2">Global Templates ({props.globalTemplates.length})</div>
              <For each={props.globalTemplates} fallback={<div class="text-gray-10">No global templates</div>}>
                {(t) => (
                  <div class="mb-3 p-2 bg-gray-2 rounded border border-gray-6">
                    <div class="text-gray-12 font-semibold">{t.title}</div>
                    <div class="text-gray-10 mt-1">ID: {t.id}</div>
                    <div class="mt-1">
                      <span class="text-gray-10">autoRun: </span>
                      <span class={t.autoRun === false ? "text-red-400 font-bold" : "text-green-400 font-bold"}>
                        {String(t.autoRun)}
                      </span>
                      <span class="text-gray-7"> (type: {typeof t.autoRun})</span>
                    </div>
                    <div class="text-gray-10 mt-1">
                      autoRun !== false: {String(t.autoRun !== false)}
                    </div>
                    <div class="text-gray-7 mt-1 truncate" title={t.prompt}>
                      Prompt: {t.prompt.slice(0, 50)}...
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
