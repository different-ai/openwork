import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { Check, Plus, RefreshCcw, Trash2, X } from "lucide-solid";

import Button from "./button";
import TextInput from "./text-input";
import { serverDisplayName } from "../context/server";

export type ServerManagerModalProps = {
  open: boolean;
  servers: string[];
  activeUrl: string;
  healthy: boolean | undefined;
  version: string | null;
  busy: boolean;
  mode: "host" | "client" | null;
  onClose: () => void;
  onAdd: (url: string) => void;
  onRemove: (url: string) => void;
  onSetActive: (url: string) => void;
  onReconnect: () => void;
  onRestart?: () => void;
  onDiscoverProjects?: () => void;
};

export default function ServerManagerModal(props: ServerManagerModalProps) {
  const [newUrl, setNewUrl] = createSignal("");

  createEffect(() => {
    if (!props.open) {
      setNewUrl("");
    }
  });

  const activeStatusLabel = createMemo(() => {
    if (!props.activeUrl) return "No active server";
    if (props.healthy === undefined) return "Checking health";
    return props.healthy ? "Healthy" : "Unreachable";
  });

  const activeStatusStyle = createMemo(() => {
    if (!props.activeUrl || props.healthy === undefined) {
      return "bg-gray-4/50 text-gray-11 border-gray-7/50";
    }
    return props.healthy
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-red-7/10 text-red-11 border-red-7/20";
  });

  const addServer = () => {
    const value = newUrl().trim();
    if (!value) return;
    props.onAdd(value);
    setNewUrl("");
  };

  const showReconnect = createMemo(() => props.mode === "client" && props.healthy === false);
  const showRestart = createMemo(() => props.mode === "host" && props.healthy === false && props.onRestart);
  const showDiscover = createMemo(() => Boolean(props.mode) && props.onDiscoverProjects);

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">Servers</h3>
                <p class="text-sm text-gray-11 mt-1">Manage OpenCode server connections.</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <div class="flex flex-wrap items-center gap-2">
                <span class={`inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full border ${activeStatusStyle()}`}>
                  {activeStatusLabel()}
                </span>
                <Show when={props.version}>
                  <span class="text-xs text-gray-10 font-mono">v{props.version}</span>
                </Show>
                <Show when={showReconnect()}>
                  <Button
                    variant="outline"
                    class="text-xs h-7 px-2"
                    onClick={props.onReconnect}
                    disabled={props.busy || !props.activeUrl}
                  >
                    <RefreshCcw size={12} />
                    Reconnect
                  </Button>
                </Show>
                <Show when={showRestart()}>
                  <Button
                    variant="outline"
                    class="text-xs h-7 px-2"
                    onClick={() => props.onRestart?.()}
                    disabled={props.busy || !props.activeUrl}
                  >
                    <RefreshCcw size={12} />
                    Restart
                  </Button>
                </Show>
                <Show when={showDiscover()}>
                  <Button
                    variant="outline"
                    class="text-xs h-7 px-2"
                    onClick={() => props.onDiscoverProjects?.()}
                    disabled={props.busy || !props.activeUrl}
                  >
                    Discover projects
                  </Button>
                </Show>
              </div>

              <div class="bg-gray-1/60 border border-gray-6 rounded-xl p-4 space-y-3">
                <TextInput
                  label="Add server"
                  value={newUrl()}
                  onInput={(event) => setNewUrl(event.currentTarget.value)}
                  placeholder="http://localhost:4096"
                  hint="Use full URL or host:port"
                />
                <div class="flex justify-end">
                  <Button variant="outline" onClick={addServer} disabled={!newUrl().trim()}>
                    <Plus size={14} />
                    Add server
                  </Button>
                </div>
              </div>

              <div class="space-y-2">
                <For each={props.servers}>
                  {(serverUrl) => {
                    const isActive = () => serverUrl === props.activeUrl;
                    return (
                      <div
                        class={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
                          isActive()
                            ? "border-gray-6 bg-gray-1/80"
                            : "border-gray-6/40 bg-gray-1/40"
                        }`}
                      >
                        <div class="min-w-0">
                          <div class="text-sm text-gray-12 truncate">
                            {serverDisplayName(serverUrl)}
                          </div>
                          <div class="text-xs text-gray-7 font-mono truncate">{serverUrl}</div>
                        </div>
                        <div class="flex items-center gap-2">
                          <Show when={isActive()}>
                            <span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-5/60 text-gray-12">
                              <Check size={12} />
                              Active
                            </span>
                          </Show>
                          <Show when={!isActive()}>
                            <Button
                              variant="outline"
                              class="text-xs h-8 px-3"
                              onClick={() => props.onSetActive(serverUrl)}
                              disabled={props.mode === "host"}
                            >
                              Use
                            </Button>
                          </Show>
                          <Button
                            variant="ghost"
                            class="text-xs h-8 px-2"
                            onClick={() => props.onRemove(serverUrl)}
                            disabled={props.servers.length <= 1}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            <div class="mt-6 flex justify-end">
              <Button variant="outline" onClick={props.onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
