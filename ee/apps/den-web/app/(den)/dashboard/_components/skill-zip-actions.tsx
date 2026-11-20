"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { getRequestError, requestJson, requestResponse } from "../../_lib/den-flow";
import { getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** Archives up to 40 MB can take a while to upload and unpack. */
const SKILL_ZIP_TIMEOUT_MS = 120_000;

/**
 * Imports a skill folder zipped the way Claude and Anthropic's Agent Skills
 * keep it (SKILL.md at the top or in one folder named after the skill) as a
 * new private plugin, then opens it.
 */
export function SkillZipUploadButton() {
  const router = useRouter();
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const created: { pluginId: string | null } = { pluginId: null };
      await runReauthableAction("import-skill-zip", async () => {
        const result = await requestJson("/v1/plugins/skill-zip", { method: "POST", body: form }, SKILL_ZIP_TIMEOUT_MS);
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "That archive could not be imported.");
        const item = (result.payload as { item?: { id?: unknown } } | null)?.item;
        created.pluginId = typeof item?.id === "string" ? item.id : null;
      });
      if (created.pluginId) router.push(getPluginRoute(orgSlug, created.pluginId));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "That archive could not be imported.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
      >
        <Upload size={14} />
        {busy ? "Uploading..." : "Upload skill .zip"}
      </button>
      {error ? <p role="alert" className="max-w-[320px] text-right text-[12px] text-red-700">{error}</p> : null}
    </div>
  );
}

/** Saves a skill as `<name>.zip`, in the folder layout Claude uploads. */
export async function downloadSkillZip(configObjectId: string): Promise<void> {
  const response = await requestResponse(
    `/v1/config-objects/${encodeURIComponent(configObjectId)}/skill-zip`,
    { headers: { Accept: "application/zip" } },
    SKILL_ZIP_TIMEOUT_MS,
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw getRequestError(payload, response, "The skill could not be downloaded.");
  }
  const fileName = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "skill.zip";
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    // Revoke after the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
