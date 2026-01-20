import { Match, Show, Switch } from "solid-js";

import { X } from "lucide-solid";

import Button from "./button";
import TextInput from "./text-input";

export type ResetModalProps = {
  open: boolean;
  mode: "onboarding" | "all";
  text: string;
  busy: boolean;
  canReset: boolean;
  hasActiveRuns: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onTextChange: (value: string) => void;
};

export default function ResetModal(props: ResetModalProps) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">
                  <Switch>
                    <Match when={props.mode === "onboarding"}>Reset onboarding</Match>
                    <Match when={true}>Reset app data</Match>
                  </Switch>
                </h3>
                <p class="text-sm text-gray-11 mt-1">
                  Type <span class="font-mono">RESET</span> to confirm. OpenWork will restart.
                </p>
              </div>
              <Button
                variant="ghost"
                class="!p-2 rounded-full"
                onClick={props.onClose}
                disabled={props.busy}
              >
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11">
                <Switch>
                  <Match when={props.mode === "onboarding"}>
                    Clears OpenWork local preferences and workspace onboarding markers.
                  </Match>
                  <Match when={true}>Clears OpenWork cache and app data on this device.</Match>
                </Switch>
              </div>

              <Show when={props.hasActiveRuns}>
                <div class="text-xs text-red-11">Stop active runs before resetting.</div>
              </Show>

              <TextInput
                label="Confirmation"
                placeholder="Type RESET"
                value={props.text}
                onInput={(e) => props.onTextChange(e.currentTarget.value)}
                disabled={props.busy}
              />
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onClose} disabled={props.busy}>
                Cancel
              </Button>
              <Button variant="danger" onClick={props.onConfirm} disabled={!props.canReset}>
                Reset & Restart
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
