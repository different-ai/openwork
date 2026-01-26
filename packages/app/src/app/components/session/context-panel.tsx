import { For, Show } from "solid-js";
import { ChevronDown, Circle, File, Folder, Package } from "lucide-solid";

import { SUGGESTED_PLUGINS } from "../../constants";
import type { McpServerEntry, McpStatus, McpStatusMap, SkillCard } from "../../types";
import { stripPluginVersion } from "../../utils/plugins";

export type ContextPanelProps = {
  activePlugins: string[];
  activePluginStatus: string | null;
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
  mcpStatus: string | null;
  skills: SkillCard[];
  skillsStatus: string | null;
  authorizedDirs: string[];
  workingFiles: string[];
  expandedSections: {
    context: boolean;
    plugins: boolean;
    mcp: boolean;
    skills: boolean;
    authorizedFolders: boolean;
  };
  onToggleSection: (section: "context" | "plugins" | "mcp" | "skills" | "authorizedFolders") => void;
};

const humanizePlugin = (name: string) => {
  const cleaned = name
    .replace(/^@[^/]+\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b(opencode|plugin)\b/gi, "")
    .trim();
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .trim();
};

const matchSuggestedPlugin = (name: string) => {
  const normalized = stripPluginVersion(name).toLowerCase();
  if (!normalized) return null;
  return (
    SUGGESTED_PLUGINS.find((plugin) => {
      const candidates = [plugin.packageName, plugin.name, ...(plugin.aliases ?? [])]
        .map((candidate) => stripPluginVersion(candidate).toLowerCase())
        .filter(Boolean);
      return candidates.includes(normalized);
    }) ?? null
  );
};

const humanizeSkill = (name: string) => {
  const cleaned = name.replace(/^@[^/]+\//, "").replace(/[-_]+/g, " ").trim();
  if (!cleaned) return name;
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .trim();
};

const mcpStatusLabel = (status?: McpStatus, disabled?: boolean) => {
  if (disabled) return "Disabled";
  if (!status) return "Disconnected";
  switch (status.status) {
    case "connected":
      return "Connected";
    case "needs_auth":
      return "Needs auth";
    case "needs_client_registration":
      return "Register client";
    case "failed":
      return "Failed";
    default:
      return "Disconnected";
  }
};

const mcpStatusDot = (status?: McpStatus, disabled?: boolean) => {
  if (disabled) return "bg-gray-7";
  if (!status) return "bg-gray-7";
  switch (status.status) {
    case "connected":
      return "bg-green-9";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-9";
    case "failed":
      return "bg-red-9";
    default:
      return "bg-gray-7";
  }
};

export default function ContextPanel(props: ContextPanelProps) {
  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div class="rounded-2xl border border-gray-6 bg-gray-2/30" id="sidebar-context">
          <button
            class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
            onClick={() => props.onToggleSection("context")}
          >
            <span>Context</span>
            <ChevronDown
              size={16}
              class={`transition-transform text-gray-10 ${props.expandedSections.context ? "rotate-180" : ""}`.trim()}
            />
          </button>
          <Show when={props.expandedSections.context}>
            <div class="px-4 pb-4 pt-1 space-y-5">
              <div>
                <div class="flex items-center justify-between text-[11px] uppercase tracking-wider text-gray-9 font-semibold mb-2">
                  <span>Working files</span>
                </div>
                <div class="space-y-2">
                  <Show
                    when={props.workingFiles.length}
                    fallback={<div class="text-xs text-gray-9">None yet.</div>}
                  >
                    <For each={props.workingFiles}>
                      {(file) => (
                        <div class="flex items-center gap-2 text-xs text-gray-11">
                          <File size={12} class="text-gray-9" />
                          <span class="truncate">{file}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </div>

        <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
          <button
            class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
            onClick={() => props.onToggleSection("plugins")}
          >
            <span>Plugins</span>
            <ChevronDown
              size={16}
              class={`transition-transform text-gray-10 ${props.expandedSections.plugins ? "rotate-180" : ""}`.trim()}
            />
          </button>
          <Show when={props.expandedSections.plugins}>
            <div class="px-4 pb-4 pt-1">
              <div class="space-y-2">
                <Show
                  when={props.activePlugins.length}
                  fallback={
                    <div class="text-xs text-gray-9">
                      {props.activePluginStatus ?? "No plugins loaded."}
                    </div>
                  }
                >
                  <For each={props.activePlugins}>
                    {(plugin) => {
                      const suggested = matchSuggestedPlugin(plugin);
                      const normalized = stripPluginVersion(plugin) || plugin;
                      const label = humanizePlugin(suggested?.name ?? normalized) || normalized;
                      const description = suggested?.description?.trim();
                      const detail = description || (normalized !== label ? normalized : "");
                      return (
                        <div class="flex items-start gap-2 text-xs text-gray-11">
                          <Circle size={6} class="text-green-9 fill-green-9 mt-1" />
                          <div class="min-w-0">
                            <div class="truncate">{label}</div>
                            <Show when={detail}>
                              <div class="text-[11px] text-gray-9 truncate" title={detail}>
                                {detail}
                              </div>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
          <button
            class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
            onClick={() => props.onToggleSection("mcp")}
          >
            <span>MCP</span>
            <ChevronDown
              size={16}
              class={`transition-transform text-gray-10 ${props.expandedSections.mcp ? "rotate-180" : ""}`.trim()}
            />
          </button>
          <Show when={props.expandedSections.mcp}>
            <div class="px-4 pb-4 pt-1">
              <div class="space-y-2">
                <Show
                  when={props.mcpServers.length}
                  fallback={
                    <div class="text-xs text-gray-9">
                      {props.mcpStatus ?? "No MCP servers loaded."}
                    </div>
                  }
                >
                  <For each={props.mcpServers}>
                    {(entry) => {
                      const status = () => props.mcpStatuses[entry.name];
                      const disabled = () => entry.config.enabled === false;
                      const detail =
                        entry.config.type === "remote"
                          ? entry.config.url
                          : entry.config.command?.join(" ");
                      return (
                        <div class="flex items-start gap-2 text-xs text-gray-11">
                          <span class={`mt-1 h-2 w-2 rounded-full ${mcpStatusDot(status(), disabled())}`} />
                          <div class="min-w-0">
                            <div class="truncate">{entry.name}</div>
                            <div class="text-[11px] text-gray-9 truncate">
                              {mcpStatusLabel(status(), disabled())}
                              {detail ? ` - ${detail}` : ""}
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
          <button
            class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
            onClick={() => props.onToggleSection("skills")}
          >
            <span>Skills</span>
            <ChevronDown
              size={16}
              class={`transition-transform text-gray-10 ${props.expandedSections.skills ? "rotate-180" : ""}`.trim()}
            />
          </button>
          <Show when={props.expandedSections.skills}>
            <div class="px-4 pb-4 pt-1">
              <div class="space-y-2">
                <Show
                  when={props.skills.length}
                  fallback={
                    <div class="text-xs text-gray-9">
                      {props.skillsStatus ?? "No skills loaded."}
                    </div>
                  }
                >
                  <For each={props.skills}>
                    {(skill) => {
                      const label = humanizeSkill(skill.name) || skill.name;
                      const description = skill.description?.trim();
                      return (
                        <div class="flex items-start gap-2 text-xs text-gray-11">
                          <Package size={12} class="text-gray-9 mt-0.5" />
                          <div class="min-w-0">
                            <div class="truncate">{label}</div>
                            <Show when={description}>
                              <div class="text-[11px] text-gray-9 truncate" title={description}>
                                {description}
                              </div>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <div class="rounded-2xl border border-gray-6 bg-gray-2/30">
          <button
            class="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-12 font-medium"
            onClick={() => props.onToggleSection("authorizedFolders")}
          >
            <span>Authorized folders</span>
            <ChevronDown
              size={16}
              class={`transition-transform text-gray-10 ${
                props.expandedSections.authorizedFolders ? "rotate-180" : ""
              }`.trim()}
            />
          </button>
          <Show when={props.expandedSections.authorizedFolders}>
            <div class="px-4 pb-4 pt-1">
              <div class="space-y-2">
                <Show
                  when={props.authorizedDirs.length}
                  fallback={<div class="text-xs text-gray-9">None yet.</div>}
                >
                  <For each={props.authorizedDirs.slice(0, 3)}>
                    {(folder) => (
                      <div class="flex items-center gap-2 text-xs text-gray-11">
                        <Folder size={12} class="text-gray-9" />
                        <span class="truncate" title={folder}>
                          {folder.split(/[/\\]/).pop()}
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
