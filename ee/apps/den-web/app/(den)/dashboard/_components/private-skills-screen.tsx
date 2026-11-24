"use client";

import { PERSONAL_SKILLS_MAX_BYTES, personalSkillsBundleSchema, personalSkillsImportResponseSchema } from "@openwork/types/den/personal-skills";
import { useQueryClient } from "@tanstack/react-query";
import { Download, LockKeyhole, Upload } from "lucide-react";
import { useId, useState } from "react";
import { DenActionList, DenActionRow } from "../../_components/ui/action-row";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getLibraryRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useConfigDownload } from "./config-blobs/config-blobs-data";
import { ItemPage } from "./item-header";
import { libraryQueryKeys } from "./library-data";

const base = "/v1/me/personal-skills";
const maxBytes = PERSONAL_SKILLS_MAX_BYTES;

export function PrivateSkillsScreen() {
  const { orgId, orgSlug, orgContext, orgBusy, runReauthableAction } = useOrgDashboard();
  const download = useConfigDownload(orgId);
  const queryClient = useQueryClient();
  const fileId = useId();
  const [file, setFile] = useState<{ name: string; body: string; count: number } | null>(null);
  const [pending, setPending] = useState<"import" | "export" | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const enabled = orgFeatureEnabled(orgContext, "personalSkillPortability");

  async function pick(picked: File | undefined) {
    setFile(null);
    setNotice(null);
    if (!picked) return;
    if (picked.size > maxBytes) {
      setNotice({ tone: "error", message: `Choose a file no larger than ${maxBytes / (1024 * 1024)} MiB.` });
      return;
    }
    try {
      const body = await picked.text();
      const parsed = personalSkillsBundleSchema.safeParse(JSON.parse(body));
      if (!parsed.success || parsed.data.skills.length === 0) throw new Error("Invalid private skills file.");
      setFile({ name: picked.name, body, count: parsed.data.skills.length });
    } catch {
      setNotice({ tone: "error", message: "Choose a private skills JSON file with at least one skill." });
    }
  }

  async function run(action: "import" | "export") {
    if (!orgId || !enabled || pending) return;
    setPending(action);
    setNotice(null);
    try {
      if (action === "export") {
        await download(`${base}/export`, "openwork-private-skills.json", "Couldn't download your private skills.");
      } else if (file) {
        await runReauthableAction("Import private skills", async () => {
          const { response, payload } = await requestJson(`${base}/import`, {
            method: "POST",
            headers: { "content-type": "application/json", [ORG_SCOPE_HEADER]: orgId },
            body: file.body,
          });
          if (!response.ok) throw getRequestError(payload, response, "Couldn't import your private skills.");
          const result = personalSkillsImportResponseSchema.safeParse(payload);
          if (!result.success) throw new Error("Couldn't confirm the import. Check My Library before trying again.");
          const { created } = result.data;
          setFile(null);
          void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
          setNotice({ tone: "success", message: `${created} ${created === 1 ? "skill" : "skills"} imported privately into My Library.` });
        });
      }
    } catch (cause) {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : `Couldn't ${action} your private skills.` });
    } finally {
      setPending(null);
    }
  }

  return (
    <ItemPage testId="private-skills-screen">
      <DenPageHeader title="Move private skills" size="compact" action={<DenButton href={getLibraryRoute(orgSlug)} variant="secondary" size="sm">Back to My Library</DenButton>} />
      {orgBusy || !orgContext ? null : !enabled ? (
        <DenNotice tone="neutral" icon={LockKeyhole} message="Moving private skills isn't enabled in this workspace." />
      ) : (
        <>
          <DenActionList>
            <DenActionRow description="Download your unshared skills as a JSON file. The file contains the full skill text, so keep it private." action={
              <DenButton icon={Download} size="sm" disabled={pending !== null} loading={pending === "export"} onClick={() => void run("export")}>Download private skills</DenButton>
            } />
            <DenActionRow description="Import skills as private copies in this workspace. Existing skills aren't replaced or shared." action={
              <DenButton icon={Upload} variant="secondary" size="sm" disabled={pending !== null} onClick={() => document.getElementById(fileId)?.click()}>Choose file</DenButton>
            } />
          </DenActionList>
          <input id={fileId} type="file" accept=".json,application/json" hidden onChange={(event) => { void pick(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
          {file ? (
            <DenActionRow description={<><span className="break-all font-medium">{file.name}</span> · {file.count} {file.count === 1 ? "skill" : "skills"}</>} action={
              <DenButton size="sm" disabled={pending !== null} loading={pending === "import"} onClick={() => void run("import")}>Import private copies</DenButton>
            } />
          ) : null}
          {notice ? <DenNotice tone={notice.tone} message={notice.message} /> : null}
        </>
      )}
    </ItemPage>
  );
}
