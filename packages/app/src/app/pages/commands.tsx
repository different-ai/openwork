import { createEffect, For, on, Show } from "solid-js";

import type { WorkspaceCommand } from "../types";
import { t, currentLocale } from "../../i18n";

import Button from "../components/button";
import { Play, Plus, Terminal, Trash2 } from "lucide-solid";

export type CommandsViewProps = {
  busy: boolean;
  workspaceCommands: WorkspaceCommand[];
  globalCommands: WorkspaceCommand[];
  otherCommands: WorkspaceCommand[];
  setCommandDraftName: (value: string) => void;
  setCommandDraftDescription: (value: string) => void;
  setCommandDraftTemplate: (value: string) => void;
  setCommandDraftScope: (value: "workspace" | "global") => void;
  openCommandModal: () => void;
  resetCommandDraft?: (scope?: "workspace" | "global") => void;
  runCommand: (command: WorkspaceCommand) => void;
  deleteCommand: (command: WorkspaceCommand) => void;
  justSavedCommand?: { name: string; scope: string } | null;
  clearJustSavedCommand?: () => void;
};

const commandNeedsDetails = (command: WorkspaceCommand) => /\$(ARGUMENTS|\d+)/i.test(command.template);

export default function CommandsView(props: CommandsViewProps) {
  const translate = (key: string) => t(key, currentLocale());

  // Map to store refs for command cards: "scope:name" -> HTMLElement
  const commandRefs = new Map<string, HTMLElement>();

  // Effect to scroll to and highlight the just-saved command
  createEffect(
    on(
      () => props.justSavedCommand,
      (saved) => {
        if (!saved) return;

        // Use requestAnimationFrame to ensure DOM is updated
        requestAnimationFrame(() => {
          const key = `${saved.scope}:${saved.name}`;
          const element = commandRefs.get(key);

          if (element) {
            // Smooth scroll to center the element
            element.scrollIntoView({ behavior: "smooth", block: "center" });

            // Add highlight animation class
            element.classList.add("command-just-saved");

            // Remove the class and clear state after animation completes
            setTimeout(() => {
              element.classList.remove("command-just-saved");
              props.clearJustSavedCommand?.();
            }, 2000);
          } else {
            // Element not found, just clear the state
            props.clearJustSavedCommand?.();
          }
        });
      },
    ),
  );

  const openNewCommand = () => {
    const reset = props.resetCommandDraft;
    if (reset) {
      reset("workspace");
    } else {
      props.setCommandDraftName("");
      props.setCommandDraftDescription("");
      props.setCommandDraftTemplate("");
      props.setCommandDraftScope("workspace");
    }
    props.openCommandModal();
  };

  const hasCommands = () =>
    props.workspaceCommands.length || props.globalCommands.length || props.otherCommands.length;

  const renderCommand = (command: WorkspaceCommand, tone: string) => (
    <div
      ref={(el) => commandRefs.set(`${command.scope}:${command.name}`, el)}
      class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 flex items-start justify-between gap-4 transition-all duration-300"
    >
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <Terminal size={16} class={tone} />
          <div class="font-medium text-gray-12 truncate">/{command.name}</div>
          <Show when={commandNeedsDetails(command)}>
            <span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-7/20 text-amber-12 uppercase tracking-wide">
              {translate("commands.details_required")}
            </span>
          </Show>
        </div>
        <div class="mt-1 text-sm text-gray-10">
          {command.description || translate("commands.default_description")}
        </div>
      </div>
      <div class="shrink-0 flex gap-2">
        <Button variant="secondary" onClick={() => props.runCommand(command)} disabled={props.busy}>
          <Play size={16} />
          {translate("commands.run")}
        </Button>
        <Show when={command.scope !== "unknown"}>
          <Button variant="danger" onClick={() => props.deleteCommand(command)} disabled={props.busy}>
            <Trash2 size={16} />
          </Button>
        </Show>
      </div>
    </div>
  );

  return (
    <section class="space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider">
          {translate("dashboard.commands")}
        </h3>
        <Button variant="secondary" onClick={openNewCommand} disabled={props.busy}>
          <Plus size={16} />
          {translate("commands.new")}
        </Button>
      </div>

      <Show
        when={hasCommands()}
        fallback={
          <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-6 text-sm text-gray-10">
            {translate("commands.empty_state")}
          </div>
        }
      >
        <div class="space-y-6">
          <Show when={props.workspaceCommands.length}>
            <div class="space-y-3">
              <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">
                {translate("commands.workspace")}
              </div>
              <For each={props.workspaceCommands}>
                {(command) => renderCommand(command, "text-indigo-11")}
              </For>
            </div>
          </Show>

          <Show when={props.globalCommands.length}>
            <div class="space-y-3">
              <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">
                {translate("commands.global")}
              </div>
              <For each={props.globalCommands}>
                {(command) => renderCommand(command, "text-green-11")}
              </For>
            </div>
          </Show>

          <Show when={props.otherCommands.length}>
            <div class="space-y-3">
              <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">
                {translate("commands.other")}
              </div>
              <For each={props.otherCommands}>
                {(command) => renderCommand(command, "text-gray-10")}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
