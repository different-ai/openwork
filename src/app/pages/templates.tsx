import { For, Show } from "solid-js";

import type { WorkspaceTemplate } from "../types";
import { formatRelativeTime } from "../utils";

import Button from "../components/button";
import { FileText, Play, Plus, Trash2 } from "lucide-solid";

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
    </section>
  );
}
