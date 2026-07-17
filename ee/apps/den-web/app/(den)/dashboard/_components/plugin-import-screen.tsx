"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, Github, Server } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getNewPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  loadPluginImportDraft,
  parsePluginImportPreview,
  pluginImportSourceLabel,
  savePluginImportDraft,
  type PluginImportAuthType,
  type PluginImportCredentialMode,
  type PluginImportPreview,
} from "./plugin-import-draft";

type PreviewItem = {
  detail: string;
  key: string;
  kind: "skill" | "mcp";
  name: string;
  status: string;
  supported: boolean;
};

function serverStatus(preview: PluginImportPreview["servers"][number]): string {
  if (preview.supported) return "Ready";
  if (preview.skippedReason === "local_unsupported") return "Desktop-only servers cannot be imported";
  if (preview.skippedReason === "missing_url") return "No remote URL found";
  return "Unsupported";
}

export function PluginImportScreen() {
  const router = useRouter();
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const [githubUrl, setGithubUrl] = useState("");
  const [preview, setPreview] = useState<PluginImportPreview | null>(null);
  const [selectedServerKeys, setSelectedServerKeys] = useState<string[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [authType, setAuthType] = useState<PluginImportAuthType>("oauth");
  const [credentialMode, setCredentialMode] = useState<PluginImportCredentialMode>("per_member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const draft = loadPluginImportDraft();
    if (!draft) return;
    setGithubUrl(draft.githubUrl);
    setPreview(draft.preview);
    setSelectedServerKeys(draft.selectedServerKeys);
    setSelectedSkillKeys(draft.selectedSkillKeys);
    setAuthType(draft.authType);
    setCredentialMode(draft.credentialMode);
  }, []);

  async function previewImport() {
    if (!githubUrl.trim()) {
      setError("Paste a GitHub plugin URL.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let payload: unknown = null;
      await runReauthableAction("preview-github-plugin-components", async () => {
        const result = await requestJson(
          "/v1/plugins/import-mcps-from-github-url/preview",
          { method: "POST", body: JSON.stringify({ githubUrl: githubUrl.trim() }) },
          20000,
        );
        if (!result.response.ok) {
          throw getRequestError(result.payload, result.response, "Failed to preview GitHub plugin components.");
        }
        payload = result.payload;
      });
      const nextPreview = parsePluginImportPreview(payload);
      setPreview(nextPreview);
      setSelectedServerKeys(nextPreview.servers.filter((server) => server.supported).map((server) => server.serverKey));
      setSelectedSkillKeys(nextPreview.skills.filter((skill) => skill.supported).map((skill) => skill.skillKey));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Failed to preview GitHub plugin components.");
    } finally {
      setBusy(false);
    }
  }

  function continueToCreate() {
    if (!preview || (selectedServerKeys.length === 0 && selectedSkillKeys.length === 0)) {
      setError("Select at least one supported MCP server or skill.");
      return;
    }
    savePluginImportDraft({
      version: 1,
      authType,
      credentialMode,
      githubUrl: githubUrl.trim(),
      preview,
      selectedServerKeys,
      selectedSkillKeys,
    });
    router.push(getNewPluginRoute(orgSlug));
  }

  const selectedMcpCount = selectedServerKeys.length;
  const selectedCount = selectedMcpCount + selectedSkillKeys.length;
  const previewItems: PreviewItem[] = preview
    ? [
        ...preview.skills.map((skill): PreviewItem => ({
          key: skill.skillKey,
          kind: "skill",
          name: skill.name,
          detail: skill.description ?? skill.sourcePath,
          supported: skill.supported,
          status: skill.supported ? "Ready" : "Unsupported skill",
        })),
        ...preview.servers.map((server): PreviewItem => ({
          key: server.serverKey,
          kind: "mcp",
          name: server.name,
          detail: server.url ?? "No remote URL",
          supported: server.supported,
          status: serverStatus(server),
        })),
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href={getNewPluginRoute(orgSlug)}
        className="mb-6 inline-flex items-center gap-2 text-[14px] text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft size={15} />
        Back to create
      </Link>

      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gray-900 text-white">
          <Github size={20} />
        </div>
        <div>
          <h1 className="text-[28px] font-semibold text-gray-900">Import from GitHub</h1>
          <p className="mt-1 text-[15px] text-gray-500">
            Preview a public plugin, choose what to bring in, then finish creating it in OpenWork.
          </p>
        </div>
      </div>

      <div className="mt-8 rounded-[24px] border border-gray-200 bg-white p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[13px] font-medium text-gray-700">GitHub plugin URL</span>
            <DenInput
              value={githubUrl}
              onChange={(event) => {
                setGithubUrl(event.target.value);
                setPreview(null);
                setSelectedServerKeys([]);
                setSelectedSkillKeys([]);
                setError(null);
              }}
              placeholder="https://github.com/anthropics/knowledge-work-plugins/tree/main/sales"
              disabled={busy}
            />
          </label>
          <DenButton onClick={() => void previewImport()} disabled={busy || !githubUrl.trim()}>
            {busy ? "Previewing..." : "Preview"}
          </DenButton>
        </div>
        <p className="mt-2 text-[12px] text-gray-500">Only public GitHub repositories are supported.</p>
      </div>

      {preview ? (
        <div className="mt-6 rounded-[24px] border border-gray-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">Preview</p>
              <h2 className="mt-1 text-[18px] font-semibold text-gray-900">{pluginImportSourceLabel(preview)}</h2>
              <p className="mt-1 text-[13px] text-gray-500">Choose the components to include in your plugin.</p>
            </div>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">
              {selectedCount} selected
            </span>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-gray-100">
            {previewItems.map((item) => {
              const selected = item.kind === "mcp"
                ? selectedServerKeys.includes(item.key)
                : selectedSkillKeys.includes(item.key);
              const Icon = item.kind === "mcp" ? Server : FileText;
              return (
                <label key={`${item.kind}:${item.key}`} className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!item.supported || busy}
                    onChange={(event) => {
                      const setter = item.kind === "mcp" ? setSelectedServerKeys : setSelectedSkillKeys;
                      setter((current) => event.target.checked
                        ? [...new Set([...current, item.key])]
                        : current.filter((key) => key !== item.key));
                    }}
                  />
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 text-gray-500">
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-gray-900">{item.name}</span>
                    <span className="block truncate text-[12px] text-gray-500" title={item.detail}>{item.detail}</span>
                  </span>
                  <span className={`shrink-0 text-[12px] ${item.supported ? "text-emerald-600" : "text-amber-700"}`}>
                    {item.status}
                  </span>
                </label>
              );
            })}
          </div>

          {selectedMcpCount > 0 ? (
            <div className="mt-5 grid gap-3 rounded-2xl bg-gray-50 p-4 sm:grid-cols-2">
              <label>
                <span className="mb-1.5 block text-[13px] font-medium text-gray-700">MCP authentication</span>
                <DenSelect value={authType} onChange={(event) => setAuthType(event.target.value === "none" ? "none" : "oauth")}>
                  <option value="oauth">OAuth</option>
                  <option value="none">No authentication</option>
                </DenSelect>
              </label>
              <label>
                <span className="mb-1.5 block text-[13px] font-medium text-gray-700">Account type</span>
                <DenSelect
                  value={credentialMode}
                  disabled={authType === "none"}
                  onChange={(event) => setCredentialMode(event.target.value === "shared" ? "shared" : "per_member")}
                >
                  <option value="per_member">Individual accounts</option>
                  <option value="shared">One organization account</option>
                </DenSelect>
              </label>
            </div>
          ) : null}

          {preview.warnings.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
              {preview.warnings.join(" ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">
          {error}
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-end gap-3">
        <Link href={getNewPluginRoute(orgSlug)} className="text-[14px] text-gray-500 hover:text-gray-900">
          Cancel
        </Link>
        <DenButton onClick={continueToCreate} disabled={!preview || selectedCount === 0 || busy}>
          Continue to create
          <ArrowRight size={15} />
        </DenButton>
      </div>
    </div>
  );
}
