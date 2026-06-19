"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Plus, Server, Terminal, Trash2 } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getPluginRoute, getPluginsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMarketplaces } from "./marketplace-data";
import { pluginQueryKeys } from "./plugin-data";

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

function buildConfigObjectBody(pluginId: string, component: DraftComponent): Record<string, unknown> {
  if (component.kind === "mcp") {
    const serverName = slugify(component.name);
    return {
      type: "mcp",
      sourceMode: "cloud",
      pluginIds: [pluginId],
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
    sourceMode: "cloud",
    pluginIds: [pluginId],
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

function createdItemId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "item" in payload) {
    const item = (payload as { item?: { id?: unknown } }).item;
    if (item && typeof item.id === "string") return item.id;
  }
  return null;
}

export function PluginEditorScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const { data: marketplaces = [] } = useMarketplaces();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [components, setComponents] = useState<DraftComponent[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [marketplaceId, setMarketplaceId] = useState<string>("");
  const [marketplaceTouched, setMarketplaceTouched] = useState(false);
  const [shareOrgWide, setShareOrgWide] = useState(true);

  // Publishing is the happy path for non-technical creators: pre-select the
  // first marketplace once the list loads, unless the user chose otherwise.
  useEffect(() => {
    if (!marketplaceTouched && !marketplaceId && marketplaces.length > 0) {
      setMarketplaceId(marketplaces[0].id);
    }
  }, [marketplaceId, marketplaceTouched, marketplaces]);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  async function createPlugin() {
    if (!name.trim()) {
      setSaveError("Give your plugin a name.");
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
      setProgress("Creating plugin...");
      let pluginPayload: unknown = null;
      await runReauthableAction("create-plugin", async () => {
        pluginPayload = await postJson(
          "/v1/plugins",
          { name: name.trim(), description: description.trim() || null },
          "Failed to create the plugin",
        );
      });
      const pluginId = createdItemId(pluginPayload);
      if (!pluginId) throw new Error("The plugin was created, but no id was returned.");

      for (const [index, component] of components.entries()) {
        setProgress(`Adding ${COMPONENT_META[component.kind].label.toLowerCase()} ${index + 1} of ${components.length}...`);
        let objectPayload: unknown = null;
        await runReauthableAction("create-plugin-config-object", async () => {
          objectPayload = await postJson(
            "/v1/config-objects",
            buildConfigObjectBody(pluginId, component),
            `Failed to add "${component.name}"`,
          );
        });
        const configObjectId = createdItemId(objectPayload);
        if (shareOrgWide && configObjectId) {
          await runReauthableAction("share-plugin-config-object", async () => {
            await postJson(
              `/v1/config-objects/${encodeURIComponent(configObjectId)}/access`,
              { orgWide: true, role: "viewer" },
              `Failed to share "${component.name}" with the organization`,
            );
          });
        }
      }

      if (shareOrgWide) {
        setProgress("Sharing with your organization...");
        await runReauthableAction("share-plugin", async () => {
          await postJson(
            `/v1/plugins/${encodeURIComponent(pluginId)}/access`,
            { orgWide: true, role: "viewer" },
            "Failed to share the plugin with the organization",
          );
        });
      }

      if (marketplaceId) {
        setProgress("Publishing to the marketplace...");
        await runReauthableAction("publish-plugin", async () => {
          await postJson(
            `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/plugins`,
            { pluginId },
            "Failed to publish to the marketplace",
          );
        });
      }

      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
      router.push(getPluginRoute(orgSlug, pluginId));
      router.refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to create the plugin.");
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href={getPluginsRoute(orgSlug)}
        className="mb-6 inline-flex items-center gap-2 text-[14px] text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft size={15} />
        Back to plugins
      </Link>

      <h1 className="text-[28px] font-semibold text-gray-900">Create a plugin</h1>
      <p className="mt-1 text-[15px] text-gray-500">
        Bundle skills, commands, and MCP servers your team can install in OpenWork with one click.
      </p>

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
          <div className="flex gap-2">
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
          </div>
        </div>

        {components.length === 0 ? (
          <div className="mt-4 rounded-[24px] border border-dashed border-gray-300 bg-gray-50 px-6 py-10 text-center text-[14px] text-gray-500">
            Add a skill, command, or MCP server to get started. A plugin needs at least one component.
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-4">
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
        </div>
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
          {saving ? progress ?? "Creating..." : "Create plugin"}
        </DenButton>
        <Link href={getPluginsRoute(orgSlug)} className="text-[14px] text-gray-500 hover:text-gray-900">
          Cancel
        </Link>
      </div>
    </div>
  );
}
