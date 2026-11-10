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
import { checkImportFile, type ImportFileCheck } from "./config-blobs-model";

type PickedFile = { name: string; check: ImportFileCheck };

export function ConfigImportSection() {
  const router = useRouter();
  const { orgId, activeOrg } = useOrgDashboard();
  const create = useCreateConfigChangeRequest(orgId);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<ConfigImportMode>("merge");
  const [title, setTitle] = useState("");

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
    if (!file?.check.ok) return;
    const trimmed = title.trim();
    create.mutate(
      { blob: file.check.blob, mode, ...(trimmed ? { title: trimmed } : {}) },
      { onSuccess: (result) => router.push(getConfigChangeRequestRoute(activeOrg?.slug, result.changeRequest.id)) },
    );
  }

  const check = file?.check ?? null;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="config-import-title" data-testid="config-import">
      <h2 id="config-import-title" className="text-[15px] font-semibold tracking-[-0.1px] text-gray-950">Import</h2>

      {file ? (
        <div className="flex min-h-12 items-center gap-3 border-y border-gray-100 py-2" data-testid="config-import-file">
          <FileJson className="size-4 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[13px] text-gray-900">{file.name}</p>
            {check?.ok ? (
              <p className="truncate text-[12px] text-gray-500">
                {check.areaCount} {check.areaCount === 1 ? "area" : "areas"}{check.sourceName ? `, from ${check.sourceName}` : ""}
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

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-gray-900">Items not in the file</legend>
        <DenOptionCard
          type="radio"
          name="config-import-mode"
          checked={mode === "merge"}
          onChange={() => setMode("merge")}
          title="Merge"
          description="Keep them. Only items in the file are added or changed."
          testId="config-import-mode-merge"
        />
        <DenOptionCard
          type="radio"
          name="config-import-mode"
          checked={mode === "mirror"}
          onChange={() => setMode("mirror")}
          title="Mirror"
          description="Offer to remove them from the areas in the file. You tick each removal before anything is applied."
          testId="config-import-mode-mirror"
        />
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={titleId} className="text-[13px] font-medium text-gray-900">Title (optional)</label>
        <DenInput id={titleId} value={title} maxLength={200} placeholder="e.g. Copy AI providers from staging" onChange={(event) => setTitle(event.target.value)} />
      </div>

      {create.isError ? <DenNotice tone="error" message={create.error.message} /> : null}

      <div className="flex justify-end">
        <DenButton icon={Upload} loading={create.isPending} disabled={!check?.ok} onClick={upload} data-testid="config-import-upload">
          Upload for review
        </DenButton>
      </div>
    </section>
  );
}
