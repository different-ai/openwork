import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { Boxes, Check, Copy, Download, Eye, EyeOff, FolderCode, Key, Link as LinkIcon, X } from "lucide-solid";

type ShareField = {
  label: string;
  value: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

export default function ShareWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  workspaceName: string;
  workspaceDetail?: string | null;
  fields: ShareField[];
  note?: string | null;
  publisherBaseUrl?: string;
  onShareWorkspaceProfile?: () => void;
  shareWorkspaceProfileBusy?: boolean;
  shareWorkspaceProfileUrl?: string | null;
  shareWorkspaceProfileError?: string | null;
  shareWorkspaceProfileDisabledReason?: string | null;
  onShareSkillsSet?: () => void;
  shareSkillsSetBusy?: boolean;
  shareSkillsSetUrl?: string | null;
  shareSkillsSetError?: string | null;
  shareSkillsSetDisabledReason?: string | null;
  onExportConfig?: () => void;
  exportDisabledReason?: string | null;
  onOpenBots?: () => void;
}) {
  const [activeTab, setActiveTab] = createSignal<"access" | "links">("access");
  const [revealedByIndex, setRevealedByIndex] = createSignal<Record<number, boolean>>({});
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);

  const title = createMemo(() => props.title ?? "Share worker");
  const detail = createMemo(() => props.workspaceDetail?.trim() ?? "");
  const note = createMemo(() => props.note?.trim() ?? "");

  // Derived initial character for avatar
  const avatarLetter = createMemo(() => (props.workspaceName ? props.workspaceName.charAt(0).toUpperCase() : "M"));

  createEffect(() => {
    if (!props.open) return;
    setRevealedByIndex({});
    setCopiedKey(null);
    setActiveTab("access");
  });

  createEffect(() => {
    if (!props.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const handleCopy = async (value: string, key: string) => {
    const text = value?.trim() ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/70 backdrop-blur-sm p-4 font-sans animate-in fade-in duration-200">
        <div
          class="bg-gray-1 w-full max-w-lg rounded-2xl shadow-[0_20px_50px_-12px_rgba(0,0,0,0.45)] border border-gray-6 overflow-hidden animate-in fade-in zoom-in-95 duration-300 relative flex flex-col max-h-[90vh]"
          role="dialog"
          aria-modal="true"
        >
          {/* Header Section */}
          <div class="px-6 pt-6 pb-4 relative border-b border-transparent shrink-0">
            <button
              onClick={props.onClose}
              class="absolute top-6 right-6 p-1.5 text-gray-9 hover:text-gray-12 hover:bg-gray-4 rounded-lg transition-all"
              aria-label="Close"
              title="Close"
            >
              <X size={20} stroke-width={2.5} />
            </button>

            <div class="flex items-center gap-3">
              <div class="w-10 h-10 bg-gray-12 rounded-xl flex items-center justify-center text-gray-1 font-bold text-lg">
                {avatarLetter()}
              </div>
              <div>
                <h2 class="text-[17px] font-bold text-gray-12 tracking-tight">{title()}</h2>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[13px] font-semibold text-gray-11">{props.workspaceName}</span>
                  <Show when={detail()}>
                    <span class="w-1 h-1 rounded-full bg-gray-6"></span>
                    <span class="text-[12px] text-gray-9 truncate max-w-[180px] font-mono">{detail()}</span>
                  </Show>
                </div>
              </div>
            </div>

            {/* Tab Switcher */}
            <div class="flex p-1 bg-gray-2 rounded-xl mt-6 border border-gray-6">
              <button
                onClick={() => setActiveTab("access")}
                class={`flex-1 flex items-center justify-center gap-2 text-[13px] font-bold py-2 px-3 rounded-lg transition-all ${
                  activeTab() === "access"
                    ? "bg-gray-1 shadow-sm text-gray-12 border border-gray-6"
                    : "text-gray-9 hover:text-gray-11 hover:bg-gray-4/50"
                }`}
              >
                <Key size={14} stroke-width={activeTab() === "access" ? 2.5 : 2} />
                Live Access
              </button>
              <button
                onClick={() => setActiveTab("links")}
                class={`flex-1 flex items-center justify-center gap-2 text-[13px] font-bold py-2 px-3 rounded-lg transition-all ${
                  activeTab() === "links"
                    ? "bg-gray-1 shadow-sm text-gray-12 border border-gray-6"
                    : "text-gray-9 hover:text-gray-11 hover:bg-gray-4/50"
                }`}
              >
                <LinkIcon size={14} stroke-width={activeTab() === "links" ? 2.5 : 2} />
                Public Links
              </button>
            </div>
          </div>

          {/* Main Content Area */}
          <div class="px-6 pb-8 flex-1 overflow-y-auto scrollbar-hide">
            {/* TAB: LIVE ACCESS */}
            <Show when={activeTab() === "access"}>
              <div class="space-y-6 pt-2 animate-in fade-in slide-in-from-bottom-3 duration-300">
                <div class="bg-amber-2 border border-amber-6 p-3 rounded-xl">
                  <p class="text-[13px] text-amber-11 leading-relaxed flex items-start gap-2">
                    <span class="mt-0.5">⚠️</span>
                    <span>Share with trusted people only. These credentials grant direct access to your local environment.</span>
                  </p>
                </div>

                <div class="space-y-5">
                  <For each={props.fields}>
                    {(field, index) => {
                      const key = () => `${field.label}:${index()}`;
                      const isSecret = () => Boolean(field.secret);
                      const revealed = () => Boolean(revealedByIndex()[index()]);

                      return (
                        <div class="group">
                          <label class="text-[12px] font-bold text-gray-9 uppercase tracking-wider mb-2 block ml-1">
                            {field.label}
                          </label>
                          <div class="relative flex items-center">
                            <input
                              type={isSecret() && !revealed() ? "password" : "text"}
                              readonly
                              value={field.value || field.placeholder || ""}
                              class="w-full bg-gray-2 border border-gray-6 group-hover:border-gray-8 rounded-xl py-3 pl-4 pr-24 text-[13px] font-mono text-gray-12 transition-all outline-none focus:ring-2 focus:ring-gray-8/40 focus:bg-gray-1"
                            />
                            <div class="absolute right-2 flex items-center gap-1">
                              <Show when={isSecret()}>
                                <button
                                  onClick={() =>
                                    setRevealedByIndex((prev) => ({
                                      ...prev,
                                      [index()]: !prev[index()],
                                    }))
                                  }
                                  disabled={!field.value}
                                  class="p-2 text-gray-9 hover:text-gray-12 hover:bg-gray-4/50 rounded-lg transition-all disabled:opacity-50"
                                >
                                  <Show when={revealed()} fallback={<Eye size={16} />}>
                                    <EyeOff size={16} />
                                  </Show>
                                </button>
                              </Show>
                              <button
                                onClick={() => handleCopy(field.value, key())}
                                disabled={!field.value}
                                class="p-2 text-gray-9 hover:text-gray-12 hover:bg-gray-4/50 rounded-lg transition-all disabled:opacity-50"
                              >
                                <Show when={copiedKey() === key()} fallback={<Copy size={16} />}>
                                  <Check size={16} class="text-emerald-10" />
                                </Show>
                              </button>
                            </div>
                          </div>
                          <Show when={field.hint && field.hint.trim()}>
                            <p class="text-[12px] text-gray-9 mt-2 ml-1 italic">{field.hint}</p>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
                
                <Show when={note()}>
                  <div class="rounded-xl border border-gray-6 bg-gray-2/40 px-4 py-3 text-[13px] text-gray-10 mt-6">
                    {note()}
                  </div>
                </Show>
              </div>
            </Show>

            {/* TAB: PUBLIC LINKS */}
            <Show when={activeTab() === "links"}>
              <div class="space-y-4 pt-2 animate-in fade-in slide-in-from-bottom-3 duration-300">
                <div class="mb-4">
                  <p class="text-[14px] text-gray-11 font-medium">Publish snapshot configurations</p>
                  <p class="text-[12px] text-gray-9 mt-0.5">Static links for sharing your setup with the community.</p>
                  <Show when={props.publisherBaseUrl?.trim()}>
                    <p class="text-[11px] text-gray-9 mt-1 font-mono">Publisher: {props.publisherBaseUrl}</p>
                  </Show>
                </div>

                {/* Card: Workspace Profile */}
                <div class="bg-gray-1 border border-gray-6 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all group">
                  <div class="flex items-center gap-3 mb-3">
                    <div class="p-2 bg-gray-2 rounded-lg text-gray-9 group-hover:text-gray-12 group-hover:bg-gray-3 transition-colors">
                      <FolderCode size={18} />
                    </div>
                    <div class="flex-1">
                      <h3 class="text-[14px] font-bold text-gray-12">Workspace profile</h3>
                      <p class="text-[12px] text-gray-9 leading-tight">Config, MCP, and skill bundles.</p>
                    </div>
                  </div>
                  
                  <Show when={props.shareWorkspaceProfileError?.trim()}>
                    <div class="rounded-lg border border-red-6 bg-red-2 p-2 mb-3 text-[12px] text-red-11">
                      {props.shareWorkspaceProfileError}
                    </div>
                  </Show>
                  <Show when={props.shareWorkspaceProfileDisabledReason?.trim()}>
                    <div class="text-[12px] text-gray-9 mb-3">{props.shareWorkspaceProfileDisabledReason}</div>
                  </Show>

                  <Show 
                    when={props.shareWorkspaceProfileUrl?.trim()} 
                    fallback={
                      <button
                        onClick={() => props.onShareWorkspaceProfile?.()}
                        disabled={Boolean(props.shareWorkspaceProfileDisabledReason) || !props.onShareWorkspaceProfile || props.shareWorkspaceProfileBusy}
                        class="w-full py-2.5 bg-gray-12 hover:bg-gray-11 text-gray-1 text-[13px] font-bold rounded-xl transition-all active:scale-[0.98] disabled:opacity-50"
                      >
                        {props.shareWorkspaceProfileBusy ? "Publishing..." : "Create Public Link"}
                      </button>
                    }
                  >
                    <div class="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
                      <input
                        type="text"
                        readonly
                        value={props.shareWorkspaceProfileUrl!}
                        class="flex-1 bg-gray-2 border border-gray-6 rounded-lg py-2 px-3 text-[12px] font-mono text-gray-11 outline-none"
                      />
                      <button
                        onClick={() => handleCopy(props.shareWorkspaceProfileUrl ?? "", "share-workspace-profile")}
                        class="p-2 bg-gray-12 text-gray-1 rounded-lg hover:bg-gray-11 transition-colors"
                      >
                        <Show when={copiedKey() === "share-workspace-profile"} fallback={<Copy size={16} />}>
                          <Check size={16} />
                        </Show>
                      </button>
                    </div>
                    <button
                      onClick={() => props.onShareWorkspaceProfile?.()}
                      disabled={props.shareWorkspaceProfileBusy}
                      class="mt-3 w-full py-2 bg-gray-2 hover:bg-gray-3 text-gray-11 hover:text-gray-12 text-[12px] font-bold rounded-lg transition-all"
                    >
                      {props.shareWorkspaceProfileBusy ? "Publishing..." : "Regenerate Link"}
                    </button>
                  </Show>
                </div>

                {/* Card: Skills Set */}
                <div class="bg-gray-1 border border-gray-6 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all group">
                  <div class="flex items-center gap-3 mb-3">
                    <div class="p-2 bg-gray-2 rounded-lg text-gray-9 group-hover:text-gray-12 group-hover:bg-gray-3 transition-colors">
                      <Boxes size={18} />
                    </div>
                    <div class="flex-1">
                      <h3 class="text-[14px] font-bold text-gray-12">Skills set</h3>
                      <p class="text-[12px] text-gray-9 leading-tight">Publish all installed skills as one bundle.</p>
                    </div>
                  </div>
                  
                  <Show when={props.shareSkillsSetError?.trim()}>
                    <div class="rounded-lg border border-red-6 bg-red-2 p-2 mb-3 text-[12px] text-red-11">
                      {props.shareSkillsSetError}
                    </div>
                  </Show>
                  <Show when={props.shareSkillsSetDisabledReason?.trim()}>
                    <div class="text-[12px] text-gray-9 mb-3">{props.shareSkillsSetDisabledReason}</div>
                  </Show>

                  <Show 
                    when={props.shareSkillsSetUrl?.trim()} 
                    fallback={
                      <button
                        onClick={() => props.onShareSkillsSet?.()}
                        disabled={Boolean(props.shareSkillsSetDisabledReason) || !props.onShareSkillsSet || props.shareSkillsSetBusy}
                        class="w-full py-2.5 bg-gray-2 hover:bg-gray-3 text-gray-12 text-[13px] font-bold rounded-xl transition-all disabled:opacity-50"
                      >
                        {props.shareSkillsSetBusy ? "Publishing..." : "Create Skill Link"}
                      </button>
                    }
                  >
                    <div class="flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
                      <input
                        type="text"
                        readonly
                        value={props.shareSkillsSetUrl!}
                        class="flex-1 bg-gray-2 border border-gray-6 rounded-lg py-2 px-3 text-[12px] font-mono text-gray-11 outline-none"
                      />
                      <button
                        onClick={() => handleCopy(props.shareSkillsSetUrl ?? "", "share-skills-set")}
                        class="p-2 bg-gray-2 hover:bg-gray-3 text-gray-12 rounded-lg transition-colors border border-gray-6"
                      >
                        <Show when={copiedKey() === "share-skills-set"} fallback={<Copy size={16} />}>
                          <Check size={16} class="text-emerald-10" />
                        </Show>
                      </button>
                    </div>
                    <button
                      onClick={() => props.onShareSkillsSet?.()}
                      disabled={props.shareSkillsSetBusy}
                      class="mt-3 w-full py-2 bg-gray-2 hover:bg-gray-3 text-gray-11 hover:text-gray-12 text-[12px] font-bold rounded-lg transition-all"
                    >
                      {props.shareSkillsSetBusy ? "Publishing..." : "Regenerate Link"}
                    </button>
                  </Show>
                </div>

                {/* Section: Local Export */}
                <div class="pt-4 mt-2 border-t border-gray-4">
                  <div class="flex items-center justify-between p-3 bg-gray-2 rounded-2xl group hover:bg-gray-3 transition-all border border-gray-6">
                    <div class="flex items-center gap-3">
                      <div class="p-2 bg-gray-1 rounded-lg text-gray-9 shadow-sm border border-gray-6">
                        <Download size={18} />
                      </div>
                      <div>
                        <h4 class="text-[13px] font-bold text-gray-12">Config bundle</h4>
                        <p class="text-[12px] text-gray-10">{props.exportDisabledReason?.trim() || "Export .opencode local files"}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => props.onExportConfig?.()}
                      disabled={!props.onExportConfig || Boolean(props.exportDisabledReason)}
                      class="px-4 py-2 bg-gray-1 border border-gray-7 hover:border-gray-8 hover:text-gray-12 rounded-xl text-[12px] font-bold text-gray-11 transition-all shadow-sm disabled:opacity-50 disabled:hover:border-gray-7 disabled:hover:text-gray-11"
                    >
                      Export
                    </button>
                  </div>
                </div>

                {/* Section: Bots */}
                <div class="pt-2">
                  <div class="flex items-center justify-between p-3 bg-gray-2 rounded-2xl group hover:bg-gray-3 transition-all border border-gray-6">
                    <div class="flex items-center gap-3">
                      <div class="p-2 bg-gray-1 rounded-lg text-gray-9 shadow-sm border border-gray-6 relative overflow-hidden flex items-center justify-center font-bold font-mono">
                        B
                        <div class="absolute inset-0 bg-amber-400 opacity-20"></div>
                      </div>
                      <div>
                        <div class="flex items-center gap-2">
                          <h4 class="text-[13px] font-bold text-gray-12">Bots</h4>
                          <span class="text-[9px] px-1.5 py-0.5 uppercase tracking-wider font-bold rounded-full border border-gray-6 text-gray-10 bg-gray-1">alpha</span>
                        </div>
                        <p class="text-[12px] text-gray-10">Configure messaging surfaces</p>
                      </div>
                    </div>
                    <button
                      onClick={() => props.onOpenBots?.()}
                      disabled={!props.onOpenBots}
                      class="px-4 py-2 bg-gray-1 border border-gray-7 hover:border-gray-8 hover:text-gray-12 rounded-xl text-[12px] font-bold text-gray-11 transition-all shadow-sm disabled:opacity-50 disabled:hover:border-gray-7 disabled:hover:text-gray-11"
                    >
                      Open setup
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          {/* Persistent Footer Shadow Fade */}
          <div class="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-gray-1 to-transparent pointer-events-none rounded-b-2xl" />
        </div>
      </div>
    </Show>
  );
}
