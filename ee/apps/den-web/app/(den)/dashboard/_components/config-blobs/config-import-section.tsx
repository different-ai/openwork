"use client";

import type { ConfigImportMode } from "@openwork/types/den/config-blobs";
import { FileJson, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type DragEvent } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenInput } from "../../../_components/ui/input";
import { DenNotice } from "../../../_components/ui/notice";
import { DenOptionCard } from "../../../_components/ui/option-card";
import { getConfigChangeRequestRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useCreateConfigChangeRequest } from "./config-blobs-data";
import { checkImportFile, importFileSummary, type ImportFileCheck } from "./config-blobs-model";

type PickedFile = { name: string; check: ImportFileCheck };

export function ConfigImportSection() {
  const router = useRouter();
  const { orgId, activeOrg } = useOrgDashboard();
  const create = useCreateConfigChangeRequest(orgId);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const titleErrorId = useId();
  const uploadReasonId = useId();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<ConfigImportMode>("merge");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);

  async function pick(picked: File | null | undefined) {
    if (!picked) return;
    create.reset();
    const text = await picked.text();
    setFile({ name: picked.name, check: checkImportFile(text, picked.size) });
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void pick(event.dataTransfer.files.item(0));
  }

  function clear() {
    setFile(null);
    create.reset();
    if (inputRef.current) inputRef.current.value = "";
  }

  function upload() {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleTouched(true);
      return;
    }
    if (!file?.check.ok) return;
    create.mutate(
      { blob: file.check.blob, mode, title: trimmed },
      { onSuccess: (result) => router.push(getConfigChangeRequestRoute(activeOrg?.slug, result.changeRequest.id)) },
    );
  }

  const check = file?.check ?? null;
  const titleMissing = title.trim() === "";
  const showTitleError = titleTouched && titleMissing;
  // The title's own message says what's missing once the field was left empty; the button doesn't repeat it.
  const uploadBlockedReason = !file ? "Choose a config file to upload." : !check?.ok || showTitleError ? null : titleMissing ? "Enter a title to upload." : null;

  return (
    <section className="flex flex-col gap-6" aria-label="Import" data-testid="config-import">

      {file ? (
        <div className="flex min-h-12 items-center gap-3 border-y border-gray-100 py-2" data-testid="config-import-file">
          <FileJson className="size-4 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[13px] text-gray-900">{file.name}</p>
            {check?.ok ? (
              <p className="text-[12px] text-gray-500" data-testid="config-import-file-summary">
                {importFileSummary(check, orgId)}
              </p>
            ) : null}
          </div>
          <DenButton variant="ghost" size="sm" icon={X} onClick={clear} aria-label="Remove file">Remove</DenButton>
        </div>
      ) : (
        <label
          className={`flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius)] border border-dashed px-4 py-6 text-center text-[13px] transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gray-400 ${dragging ? "border-gray-400 bg-gray-50" : "border-gray-200 hover:bg-gray-50"}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="config-import-drop"
        >
          <Upload className="size-4 text-gray-500" strokeWidth={1.5} aria-hidden="true" />
          <span className="font-medium text-gray-900">Drop a config file or choose one</span>
          <span className="text-gray-500">.json exported from OpenWork</span>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void pick(event.target.files?.item(0))}
            data-testid="config-import-input"
          />
        </label>
      )}

      {check && !check.ok ? <DenNotice tone="error" message={check.message} /> : null}

      <fieldset className="flex flex-col gap-2" aria-describedby="config-import-missing-description">
        <legend className="text-[13px] font-medium text-gray-900">Missing items</legend>
        <p id="config-import-missing-description" className="mb-1 text-[12px] text-gray-500">
          How would you like to handle items that already exist in your organization and are missing from the imported config file?
        </p>
        <DenOptionCard
          type="radio"
          name="config-import-mode"
          checked={mode === "merge"}
          onChange={() => setMode("merge")}
          title="Keep existing"
          description="Keep all existing items and only import new items from the config file."
          testId="config-import-mode-merge"
        />
        <DenOptionCard
          type="radio"
          name="config-import-mode"
          checked={mode === "mirror"}
          onChange={() => setMode("mirror")}
          title="Review manually"
          description="Review each item manually and decide to delete or keep them."
          testId="config-import-mode-mirror"
        />
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={titleId} className="text-[13px] font-medium text-gray-900">Enter a title for this import</label>
        <DenInput
          id={titleId}
          value={title}
          required
          maxLength={200}
          placeholder="e.g. Copy AI providers from staging"
          aria-invalid={showTitleError ? true : undefined}
          aria-describedby={showTitleError ? titleErrorId : undefined}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setTitleTouched(true)}
          data-testid="config-import-title"
        />
        {showTitleError ? (
          <p id={titleErrorId} className="text-[12px] text-red-700" data-testid="config-import-title-error">Enter a title so reviewers know what this import is for.</p>
        ) : null}
      </div>

      {create.isError ? <DenNotice tone="error" message={create.error.message} /> : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {uploadBlockedReason ? <p id={uploadReasonId} className="text-[12px] text-gray-500" data-testid="config-import-upload-reason">{uploadBlockedReason}</p> : null}
        <DenButton
          icon={Upload}
          loading={create.isPending}
          disabled={!check?.ok || titleMissing}
          aria-describedby={uploadBlockedReason ? uploadReasonId : undefined}
          onClick={upload}
          data-testid="config-import-upload"
        >
          Upload for review
        </DenButton>
      </div>
    </section>
  );
}
