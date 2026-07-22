"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FileText, Plus, Server, Terminal, Trash2 } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getImportPluginRoute, getPluginRoute, getPluginsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMarketplaces } from "./marketplace-data";
import { pluginQueryKeys } from "./plugin-data";
import {
  clearPluginImportDraft,
  loadPluginImportDraft,
  pluginImportSourceLabel,
  pluginImportSuggestedName,
  type PluginImportDraft,
} from "./plugin-import-draft";

type ComponentKind = "skill" | "command" | "mcp";

type DraftComponent = {
  key: number;
  kind: ComponentKind;
  name: string;
  description: string;
  /** Markdown body for skills/commands; remote server URL for MCP. */
  content: string;
};

const COMPONENT_META: Record<ComponentKind, { label: string; icon: typeof FileText; hint: string }> = {
  skill: {
    label: "Skill",
    icon: FileText,
    hint: "Step-by-step instructions the agent loads when the task matches. Write it like a great runbook.",
  },
  command: {
    label: "Command",
    icon: Terminal,
    hint: "A reusable slash command. Describe exactly what the agent should do when it runs.",
  },
  mcp: {
    label: "MCP server",
    icon: Server,
    hint: "Connect a remote MCP server by URL. Members get its tools when they install the plugin.",
  },
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "component";
}

function buildSkillMarkdown(component: DraftComponent): string {
  const name = slugify(component.name);
  const description = component.description.trim() || component.name.trim();
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    component.content.trim(),
    "",
  ].join("\n");
}

function buildComponentBody(component: DraftComponent): Record<string, unknown> {
  if (component.kind === "mcp") {
    const serverName = slugify(component.name);
    return {
      type: "mcp",
      input: {
        normalizedPayloadJson: {
          mcpServers: {
            [serverName]: { type: "remote", url: component.content.trim() },
          },
        },
        metadata: {
          name: component.name.trim(),
          description: component.description.trim() || undefined,
        },
      },
    };
  }

  return {
    type: component.kind,
    input: {
      rawSourceText:
        component.kind === "skill" ? buildSkillMarkdown(component) : `${component.content.trim()}\n`,
      metadata: {
        name: component.name.trim(),
        description: component.description.trim() || undefined,
      },
    },
  };
}

async function postJson(path: string, body: unknown, failureLabel: string): Promise<unknown> {
  const { response, payload } = await requestJson(
    path,
    { method: "POST", body: JSON.stringify(body) },
    20000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `${failureLabel} (${response.status}).`);
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createdItemId(payload: unknown): string | null {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  return typeof item?.id === "string" ? item.id : null;
}

export function PluginEditorScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { orgContext, orgSlug, runReauthableAction } = useOrgDashboard();
  const { data: marketplaces = [] } = useMarketplaces();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [components, setComponents] = useState<DraftComponent[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [marketplaceId, setMarketplaceId] = useState<string>("");
  const [marketplaceTouched, setMarketplaceTouched] = useState(false);
  const [shareOrgWide, setShareOrgWide] = useState(true);
  const [importDraft, setImportDraft] = useState<PluginImportDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Publishing is the happy path for non-technical creators: pre-select the
  // requested marketplace, or the first marketplace when opened elsewhere.
  useEffect(() => {
    if (marketplaceTouched || marketplaceId || marketplaces.length === 0) return;
    const requestedMarketplaceId = searchParams.get("marketplaceId");
    const requestedMarketplace = marketplaces.find((marketplace) => marketplace.id === requestedMarketplaceId);
    setMarketplaceId(requestedMarketplace?.id ?? marketplaces[0].id);
  }, [marketplaceId, marketplaceTouched, marketplaces, searchParams]);

  useEffect(() => {
    const draft = loadPluginImportDraft();
    if (!draft) return;
    setImportDraft(draft);
    setName((current) => current || pluginImportSuggestedName(draft.preview));
  }, []);

  const addComponent = (kind: ComponentKind) => {
    setComponents((current) => [
      ...current,
      { key: nextKey, kind, name: "", description: "", content: "" },
    ]);
    setNextKey((value) => value + 1);
  };

  const updateComponent = (key: number, patch: Partial<DraftComponent>) => {
    setComponents((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  };

  const removeComponent = (key: number) => {
    setComponents((current) => current.filter((entry) => entry.key !== key));
  };

  async function createImportedPlugin(draft: PluginImportDraft) {
    if (!shareOrgWide && !orgContext) {
      setSaveError("Your organization membership is still loading. Try again in a moment.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      let pluginId: string | null = null;
      await runReauthableAction("create-imported-plugin", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url",
          {
            method: "POST",
            body: JSON.stringify({
              access: {
                orgWide: shareOrgWide,
                memberIds: shareOrgWide || !orgContext ? [] : [orgContext.currentMember.id],
                teamIds: [],
              },
              authType: draft.authType,
              credentialMode: draft.credentialMode,
              description: description.trim() || null,
              githubUrl: draft.githubUrl,
              marketplaceId: marketplaceId || undefined,
              name: name.trim(),
              selectedSkillKeys: draft.selectedSkillKeys,
              selectedServerKeys: draft.selectedServerKeys,
            }),
          },
          30000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to create the imported plugin.");
        }
        const item = isRecord(result.payload) && isRecord(result.payload.item) ? result.payload.item : null;
        const plugin = item && isRecord(item.plugin) ? item.plugin : null;
        pluginId = plugin && typeof plugin.id === "string" ? plugin.id : null;
      });
      if (!pluginId) throw new Error("The plugin was created, but no id was returned.");

      clearPluginImportDraft();
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
      router.push(getPluginRoute(orgSlug, pluginId));
      router.refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to create the imported plugin.");
    } finally {
      setSaving(false);
    }
  }

  async function createPlugin() {
    if (!name.trim()) {
      setSaveError("Give your plugin a name.");
      return;
    }
    if (importDraft) {
      await createImportedPlugin(importDraft);
      return;
    }
    if (components.length === 0) {
      setSaveError("Add at least one skill, command, or MCP server.");
      return;
    }
    for (const component of components) {
      if (!component.name.trim()) {
        setSaveError(`Every ${COMPONENT_META[component.kind].label.toLowerCase()} needs a name.`);
        return;
      }
      if (!component.content.trim()) {
        setSaveError(
          component.kind === "mcp"
            ? `Enter the server URL for "${component.name || "your MCP server"}".`
            : `Write the instructions for "${component.name || "your component"}".`,
        );
        return;
      }
    }

    setSaving(true);
    setSaveError(null);
    try {
      let pluginPayload: unknown = null;
      await runReauthableAction("create-plugin", async () => {
        pluginPayload = await postJson(
          "/v1/plugins",
          {
            name: name.trim(),
            description: description.trim() || null,
            components: components.map(buildComponentBody),
            orgWide: shareOrgWide,
            marketplaceId: marketplaceId || undefined,
          },
          "Failed to create the plugin",
        );
      });
      const pluginId = createdItemId(pluginPayload);
      if (!pluginId) throw new Error("The plugin was created, but no id was returned.");

      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
      router.push(getPluginRoute(orgSlug, pluginId));
      router.refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to create the plugin.");
    } finally {
      setSaving(false);
    }
  }

  const importedSkills = importDraft
    ? importDraft.preview.skills.filter((skill) => importDraft.selectedSkillKeys.includes(skill.skillKey))
    : [];
  const importedServers = importDraft
    ? importDraft.preview.servers.filter((server) => importDraft.selectedServerKeys.includes(server.serverKey))
    : [];

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href={getPluginsRoute(orgSlug)}
        className="mb-6 inline-flex items-center gap-2 text-[14px] text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft size={15} />
        Back to plugins
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">Create a plugin</h1>
          <p className="mt-1 text-[15px] text-gray-500">
            Bundle skills, commands, and MCP servers your team can install in OpenWork with one click.
          </p>
        </div>
        <Link
          href={getImportPluginRoute(orgSlug)}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition hover:bg-gray-50"
        >
          <Download size={14} />
          {importDraft ? "Change import" : "Import from GitHub"}
        </Link>
      </div>

      <div className="mt-8 flex flex-col gap-5 rounded-[24px] border border-gray-200 bg-white p-6">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Plugin name</label>
          <DenInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Sales call prep"
            disabled={saving}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Description</label>
          <DenTextarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What does this plugin help people do?"
            rows={2}
            disabled={saving}
          />
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-[18px] font-semibold text-gray-900">What&apos;s inside</h2>
          {!importDraft ? <div className="flex gap-2">
            {(Object.keys(COMPONENT_META) as ComponentKind[]).map((kind) => {
              const meta = COMPONENT_META[kind];
              return (
                <DenButton
                  key={kind}
                  variant="secondary"
                  size="sm"
                  onClick={() => addComponent(kind)}
                  disabled={saving}
                >
                  <Plus size={14} />
                  {meta.label}
                </DenButton>
              );
            })}
          </div> : null}
        </div>

        {importDraft ? (
          <div className="mt-4 overflow-hidden rounded-[24px] border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-5 py-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Imported from GitHub</p>
                <p className="mt-1 truncate text-[14px] font-medium text-gray-900">{pluginImportSourceLabel(importDraft.preview)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[13px] font-medium">
                <button
                  type="button"
                  className="text-gray-500 hover:text-gray-900"
                  onClick={() => {
                    clearPluginImportDraft();
                    setImportDraft(null);
                  }}
                >
                  Discard
                </button>
                <Link href={getImportPluginRoute(orgSlug)} className="text-gray-600 hover:text-gray-900">
                  Change import
                </Link>
              </div>
            </div>
            {[...importedSkills.map((skill) => ({ key: `skill:${skill.skillKey}`, label: "Skill", name: skill.name, Icon: FileText })),
              ...importedServers.map((server) => ({ key: `mcp:${server.serverKey}`, label: "MCP server", name: server.name, Icon: Server }))]
              .map((item) => (
                <div key={item.key} className="flex items-center gap-3 border-b border-gray-100 px-5 py-3 last:border-b-0">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 text-gray-500">
                    <item.Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-gray-900">{item.name}</span>
                    <span className="block text-[12px] text-gray-500">{item.label}</span>
                  </span>
                </div>
              ))}
          </div>
        ) : components.length === 0 ? (
          <div className="mt-4 rounded-[24px] border border-dashed border-gray-300 bg-gray-50 px-6 py-10 text-center text-[14px] text-gray-500">
            Add a skill, command, or MCP server to get started. A plugin needs at least one component.
          </div>
        ) : null}

        {!importDraft ? <div className="mt-4 flex flex-col gap-4">
          {components.map((component) => {
            const meta = COMPONENT_META[component.kind];
            const Icon = meta.icon;
            return (
              <div key={component.key} className="rounded-[24px] border border-gray-200 bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[14px] font-medium text-gray-900">
                    <Icon size={16} className="text-gray-500" />
                    {meta.label}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeComponent(component.key)}
                    disabled={saving}
                    className="text-gray-400 hover:text-red-600"
                    aria-label={`Remove ${meta.label.toLowerCase()}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <p className="mb-4 text-[13px] text-gray-500">{meta.hint}</p>
                <div className="flex flex-col gap-3">
                  <DenInput
                    value={component.name}
                    onChange={(event) => updateComponent(component.key, { name: event.target.value })}
                    placeholder={component.kind === "mcp" ? "Server name (e.g. Linear)" : "Name (e.g. Prep a sales call)"}
                    disabled={saving}
                  />
                  {component.kind !== "mcp" ? (
                    <DenInput
                      value={component.description}
                      onChange={(event) => updateComponent(component.key, { description: event.target.value })}
                      placeholder="One-line description — when should the agent use this?"
                      disabled={saving}
                    />
                  ) : null}
                  {component.kind === "mcp" ? (
                    <DenInput
                      value={component.content}
                      onChange={(event) => updateComponent(component.key, { content: event.target.value })}
                      placeholder="https://mcp.example.com/mcp"
                      disabled={saving}
                    />
                  ) : (
                    <DenTextarea
                      value={component.content}
                      onChange={(event) => updateComponent(component.key, { content: event.target.value })}
                      placeholder={
                        component.kind === "skill"
                          ? "Write the instructions the agent should follow, in plain markdown..."
                          : "Write what this command should do when someone runs it..."
                      }
                      rows={8}
                      disabled={saving}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div> : null}
      </div>

      <div className="mt-6 flex flex-col gap-4 rounded-[24px] border border-gray-200 bg-white p-6">
        <h2 className="text-[18px] font-semibold text-gray-900">Share</h2>
        <label className="flex items-start gap-3 text-[14px] text-gray-700">
          <input
            type="checkbox"
            checked={shareOrgWide}
            onChange={(event) => setShareOrgWide(event.target.checked)}
            disabled={saving}
            className="mt-0.5"
          />
          <span>
            Share with everyone in the organization
            <span className="block text-[13px] text-gray-500">
              Members can see and install this plugin. Uncheck to keep it private to you while you iterate.
            </span>
          </span>
        </label>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Marketplace</label>
          <DenSelect
            value={marketplaceId}
            onChange={(event) => {
              setMarketplaceTouched(true);
              setMarketplaceId(event.target.value);
            }}
            disabled={saving}
          >
            <option value="">Don&apos;t publish yet</option>
            {marketplaces.map((marketplace) => (
              <option key={marketplace.id} value={marketplace.id}>
                {marketplace.name}
              </option>
            ))}
          </DenSelect>
          <p className="mt-1.5 text-[13px] text-gray-500">
            Publishing puts the plugin in the marketplace so members find it in the OpenWork app.
          </p>
        </div>
      </div>

      {saveError ? (
        <div className="mt-4 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">
          {saveError}
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-3">
        <DenButton onClick={() => void createPlugin()} disabled={saving}>
          {saving ? "Creating..." : "Create plugin"}
        </DenButton>
        <Link
          href={getPluginsRoute(orgSlug)}
          onClick={() => clearPluginImportDraft()}
          className="text-[14px] text-gray-500 hover:text-gray-900"
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}
