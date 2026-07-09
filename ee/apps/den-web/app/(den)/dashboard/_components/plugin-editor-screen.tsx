"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Info, Plus, Server, Terminal, Trash2 } from "lucide-react";
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

type GithubMcpImportSkippedReason = "missing_url" | "local_unsupported" | "invalid_url" | "unsupported_auth";

type GithubMcpImportServer = {
  name: string;
  serverKey: string;
  url: string | null;
  supported: boolean;
  skippedReason: GithubMcpImportSkippedReason | null;
};

type GithubSkillImportSkill = {
  description: string | null;
  name: string;
  skillKey: string;
  sourcePath: string;
  supported: boolean;
  skippedReason: "invalid_skill" | null;
};

type GithubMcpImportPreview = {
  repositoryFullName: string;
  rootPath: string;
  servers: GithubMcpImportServer[];
  skills: GithubSkillImportSkill[];
  warnings: string[];
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

function parseSkippedReason(value: unknown): GithubMcpImportSkippedReason | null {
  if (value === "missing_url" || value === "local_unsupported" || value === "invalid_url" || value === "unsupported_auth") {
    return value;
  }
  return null;
}

function parseGithubMcpImportPreview(payload: unknown): GithubMcpImportPreview {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  if (!item) throw new Error("GitHub MCP import preview response was incomplete.");
  return {
    repositoryFullName: typeof item.repositoryFullName === "string" ? item.repositoryFullName : "",
    rootPath: typeof item.rootPath === "string" ? item.rootPath : "",
    servers: Array.isArray(item.servers)
      ? item.servers.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string") return [];
          return [{
            name: entry.name,
            serverKey: typeof entry.serverKey === "string" ? entry.serverKey : `${entry.name}:${typeof entry.url === "string" ? entry.url : ""}`,
            url: typeof entry.url === "string" ? entry.url : null,
            supported: entry.supported === true,
            skippedReason: parseSkippedReason(entry.skippedReason),
          }];
        })
      : [],
    skills: Array.isArray(item.skills)
      ? item.skills.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.skillKey !== "string") return [];
          return [{
            description: typeof entry.description === "string" ? entry.description : null,
            name: entry.name,
            skillKey: entry.skillKey,
            sourcePath: typeof entry.sourcePath === "string" ? entry.sourcePath : "SKILL.md",
            supported: entry.supported === true,
            skippedReason: entry.skippedReason === "invalid_skill" ? "invalid_skill" : null,
          }];
        })
      : [],
    warnings: Array.isArray(item.warnings)
      ? item.warnings.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
  };
}

function statusLabel(server: GithubMcpImportServer) {
  if (server.supported) return "ready";
  if (server.skippedReason === "missing_url") return "missing URL";
  return "unsupported";
}

function skillTooltip(skill: GithubSkillImportSkill) {
  return [
    skill.description ? `Description: ${skill.description}` : null,
    `Path: ${skill.sourcePath}`,
    `Status: ${skill.supported ? "ready" : "unsupported"}`,
  ].filter(Boolean).join("\n");
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
  const [githubImportUrl, setGithubImportUrl] = useState("");
  const [githubImportMarketplaceId, setGithubImportMarketplaceId] = useState("");
  const [githubImportAuthType, setGithubImportAuthType] = useState<"oauth" | "none">("oauth");
  const [githubImportCredentialMode, setGithubImportCredentialMode] = useState<"per_member" | "shared">("per_member");
  const [githubImportPreview, setGithubImportPreview] = useState<GithubMcpImportPreview | null>(null);
  const [selectedGithubMcpKeys, setSelectedGithubMcpKeys] = useState<string[]>([]);
  const [selectedGithubSkillKeys, setSelectedGithubSkillKeys] = useState<string[]>([]);
  const [githubImportBusy, setGithubImportBusy] = useState(false);
  const [githubImportError, setGithubImportError] = useState<string | null>(null);

  // Publishing is the happy path for non-technical creators: pre-select the
  // first marketplace once the list loads, unless the user chose otherwise.
  useEffect(() => {
    if (!marketplaceTouched && !marketplaceId && marketplaces.length > 0) {
      setMarketplaceId(marketplaces[0].id);
    }
    if (!githubImportMarketplaceId && marketplaces.length > 0) {
      setGithubImportMarketplaceId(marketplaces[0].id);
    }
  }, [githubImportMarketplaceId, marketplaceId, marketplaceTouched, marketplaces]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const githubImportHasUrl = githubImportUrl.trim().length > 0;
  const primaryBusy = saving || githubImportBusy;
  const primaryButtonLabel = githubImportHasUrl
    ? githubImportBusy
      ? githubImportPreview
        ? "Importing..."
        : "Previewing..."
      : githubImportPreview
        ? "Import selected"
        : "Preview GitHub plugin"
    : saving
      ? "Creating..."
      : "Create plugin";

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

  async function previewGithubMcpImport() {
    if (!githubImportUrl.trim()) {
      setGithubImportError("Paste a GitHub plugin URL.");
      return;
    }

    setGithubImportBusy(true);
    setGithubImportError(null);
    setSaveError(null);
    try {
      let payload: unknown = null;
      await runReauthableAction("preview-github-plugin-mcps", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url/preview",
          { method: "POST", body: JSON.stringify({ githubUrl: githubImportUrl.trim() }) },
          20000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to preview GitHub plugin components.");
        }
        payload = result.payload;
      });
      const preview = parseGithubMcpImportPreview(payload);
      setGithubImportPreview(preview);
      setSelectedGithubMcpKeys(preview.servers.filter((server) => server.supported).map((server) => server.serverKey));
      setSelectedGithubSkillKeys(preview.skills.filter((skill) => skill.supported).map((skill) => skill.skillKey));
    } catch (error) {
      setGithubImportError(error instanceof Error ? error.message : "Failed to preview GitHub plugin components.");
    } finally {
      setGithubImportBusy(false);
    }
  }

  async function importGithubMcpPlugin() {
    if (!githubImportPreview) {
      setGithubImportError("Preview the GitHub plugin first.");
      return;
    }
    if (!githubImportMarketplaceId) {
      setGithubImportError("Choose a marketplace.");
      return;
    }
    if (selectedGithubMcpKeys.length === 0 && selectedGithubSkillKeys.length === 0) {
      setGithubImportError("Select at least one supported MCP or skill.");
      return;
    }

    setGithubImportBusy(true);
    setGithubImportError(null);
    setSaveError(null);
    try {
      let pluginId: string | null = null;
      await runReauthableAction("import-github-plugin-mcps", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url",
          {
            method: "POST",
            body: JSON.stringify({
              access: { orgWide: true, memberIds: [], teamIds: [] },
              authType: githubImportAuthType,
              credentialMode: githubImportCredentialMode,
              githubUrl: githubImportUrl.trim(),
              marketplaceId: githubImportMarketplaceId,
              selectedSkillKeys: selectedGithubSkillKeys,
              selectedServerKeys: selectedGithubMcpKeys,
            }),
          },
          30000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to import GitHub plugin components.");
        }
        const item = isRecord(result.payload) && isRecord(result.payload.item) ? result.payload.item : null;
        const plugin = item && isRecord(item.plugin) ? item.plugin : null;
        pluginId = plugin && typeof plugin.id === "string" ? plugin.id : null;
      });
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.all });
      router.push(pluginId ? getPluginRoute(orgSlug, pluginId) : getPluginsRoute(orgSlug));
      router.refresh();
    } catch (error) {
      setGithubImportError(error instanceof Error ? error.message : "Failed to import GitHub plugin components.");
    } finally {
      setGithubImportBusy(false);
    }
  }

  async function handlePrimarySubmit() {
    if (githubImportHasUrl) {
      if (!githubImportPreview) {
        await previewGithubMcpImport();
        return;
      }
      await importGithubMcpPlugin();
      return;
    }
    await createPlugin();
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

      <div className="mt-8 rounded-[24px] border border-gray-200 bg-white p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-[18px] font-semibold text-gray-900">Import MCPs and skills from GitHub URL</h2>
            <p className="mt-1 text-[13px] leading-5 text-gray-500">
              Paste a public plugin URL like <span className="font-mono text-[12px]">github.com/anthropics/knowledge-work-plugins/tree/main/sales</span>.
            </p>
          </div>
          <DenButton
            variant="secondary"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={githubImportBusy}
            onClick={() => void previewGithubMcpImport()}
          >
            {githubImportBusy && !githubImportPreview ? "Previewing..." : "Preview first"}
          </DenButton>
        </div>

        <div className="mt-4">
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">GitHub plugin URL</label>
          <DenInput
            value={githubImportUrl}
            onChange={(event) => {
              setGithubImportUrl(event.target.value);
              setGithubImportPreview(null);
              setSelectedGithubMcpKeys([]);
              setSelectedGithubSkillKeys([]);
              setGithubImportError(null);
              setSaveError(null);
            }}
            placeholder="https://github.com/anthropics/knowledge-work-plugins/tree/main/sales"
            disabled={githubImportBusy}
          />
        </div>

        {githubImportPreview ? (
          <div className="mt-5 flex flex-col gap-4">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 text-[13px] text-gray-600">
              Found {githubImportPreview.servers.filter((server) => server.supported).length} importable MCPs and {githubImportPreview.skills.filter((skill) => skill.supported).length} importable skills in{" "}
              <span className="font-medium text-gray-900">{githubImportPreview.repositoryFullName}{githubImportPreview.rootPath ? `/${githubImportPreview.rootPath}` : ""}</span>.
            </div>

            <div className="overflow-hidden rounded-2xl border border-gray-100">
              <table className="w-full table-fixed text-left text-[13px]">
                <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.12em] text-gray-400">
                  <tr>
                    <th className="w-12 px-4 py-3">Use</th>
                    <th className="w-[28%] px-4 py-3">Name</th>
                    <th className="px-4 py-3">Server URL</th>
                    <th className="w-24 px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {githubImportPreview.servers.map((server) => (
                    <tr key={server.serverKey}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedGithubMcpKeys.includes(server.serverKey)}
                          disabled={!server.supported || githubImportBusy}
                          onChange={(event) => {
                            setSelectedGithubMcpKeys((current) =>
                              event.target.checked
                                ? [...new Set([...current, server.serverKey])]
                                : current.filter((key) => key !== server.serverKey),
                            );
                          }}
                        />
                      </td>
                      <td className="min-w-0 px-4 py-3">
                        <div className="truncate font-medium text-gray-900" title={server.name}>{server.name}</div>
                      </td>
                      <td className="min-w-0 px-4 py-3">
                        <div className="truncate font-mono text-[12px] text-gray-500" title={server.url ?? "No URL declared"}>
                          {server.url ?? "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        <span className="whitespace-nowrap">{statusLabel(server)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {githubImportPreview.skills.length > 0 ? (
              <div className="overflow-hidden rounded-2xl border border-gray-100">
                <table className="w-full table-fixed text-left text-[13px]">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.12em] text-gray-400">
                    <tr>
                      <th className="w-12 px-4 py-3">Use</th>
                      <th className="px-4 py-3">Skill</th>
                      <th className="w-28 px-4 py-3">Details</th>
                      <th className="w-24 px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {githubImportPreview.skills.map((skill) => (
                      <tr key={skill.skillKey}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedGithubSkillKeys.includes(skill.skillKey)}
                            disabled={!skill.supported || githubImportBusy}
                            onChange={(event) => {
                              setSelectedGithubSkillKeys((current) =>
                                event.target.checked
                                  ? [...new Set([...current, skill.skillKey])]
                                  : current.filter((key) => key !== skill.skillKey),
                              );
                            }}
                          />
                        </td>
                        <td className="min-w-0 px-4 py-3">
                          <div className="truncate font-medium text-gray-900" title={skill.name}>{skill.name}</div>
                          {skill.description ? (
                            <div className="mt-0.5 truncate text-[12px] text-gray-500" title={skill.description}>{skill.description}</div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-medium text-gray-500"
                            title={skillTooltip(skill)}
                          >
                            <Info size={13} aria-hidden />
                            View info
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          <span className="whitespace-nowrap">{skill.supported ? "ready" : "unsupported"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-gray-700">Authentication</span>
                <DenSelect value={githubImportAuthType} onChange={(event) => setGithubImportAuthType(event.target.value === "none" ? "none" : "oauth")} disabled={githubImportBusy}>
                  <option value="oauth">OAuth</option>
                  <option value="none">No auth</option>
                </DenSelect>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-gray-700">Credential mode</span>
                <DenSelect
                  value={githubImportCredentialMode}
                  onChange={(event) => setGithubImportCredentialMode(event.target.value === "shared" ? "shared" : "per_member")}
                  disabled={githubImportBusy || githubImportAuthType === "none"}
                >
                  <option value="per_member">Individual accounts</option>
                  <option value="shared">Org account</option>
                </DenSelect>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-gray-700">Marketplace</span>
                <DenSelect value={githubImportMarketplaceId} onChange={(event) => setGithubImportMarketplaceId(event.target.value)} disabled={githubImportBusy}>
                  {marketplaces.map((marketplace) => (
                    <option key={marketplace.id} value={marketplace.id}>
                      {marketplace.name}
                    </option>
                  ))}
                </DenSelect>
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
              <p className="text-[13px] text-gray-500">Access defaults to everyone in the organization. Row-level overrides can be added later.</p>
              <DenButton disabled={githubImportBusy || (selectedGithubMcpKeys.length === 0 && selectedGithubSkillKeys.length === 0) || !githubImportMarketplaceId} onClick={() => void importGithubMcpPlugin()}>
                {githubImportBusy && githubImportPreview ? "Importing..." : "Import selected"}
              </DenButton>
            </div>
          </div>
        ) : null}

        {githubImportError ? (
          <div className="mt-4 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">
            {githubImportError}
          </div>
        ) : null}
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
        <DenButton onClick={() => void handlePrimarySubmit()} disabled={primaryBusy}>
          {primaryButtonLabel}
        </DenButton>
        <Link href={getPluginsRoute(orgSlug)} className="text-[14px] text-gray-500 hover:text-gray-900">
          Cancel
        </Link>
      </div>
    </div>
  );
}
