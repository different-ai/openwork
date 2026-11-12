"use client";

import type { ConfigAreaDescriptor, ConfigAreaKey } from "@openwork/types/den/config-blobs";
import { Download, LockKeyhole } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenCheckbox } from "../../../_components/ui/checkbox";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenSwitch } from "../../../_components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../_components/ui/tooltip";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { configBlobPaths, useConfigAreas, useConfigDownload } from "./config-blobs-data";
import { areaLeafLabel, configExportFileName, exportAreasParam, groupConfigAreas, isExportable } from "./config-blobs-model";

const EXPORT_FAILED = "Couldn't prepare the download. Try again.";
const NOTHING_SELECTED = "Select at least one area to download.";

function areaBlockedReason(area: ConfigAreaDescriptor): string | null {
  if (!area.supported) return area.unsupportedReason ?? "Not available on this OpenWork.";
  if (!area.canExport) return "You don't have permission to view this. Ask an organization owner or admin.";
  return null;
}

/** Settings › Config › Export: the whole organization (default) or chosen areas, downloaded after a recent sign-in. */
export function ConfigExportSection() {
  const { orgId, activeOrg } = useOrgDashboard();
  const areasQuery = useConfigAreas(orgId);
  const download = useConfigDownload(orgId);
  const areas = useMemo(() => areasQuery.data?.areas ?? [], [areasQuery.data]);
  const groups = useMemo(() => groupConfigAreas(areas), [areas]);
  const exportable = useMemo(() => areas.filter(isExportable), [areas]);
  const [wholeOrganization, setWholeOrganization] = useState(true);
  const [selected, setSelected] = useState<Set<ConfigAreaKey>>(new Set());
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();

  const selectedAreas = exportable.filter((area) => selected.has(area.key));
  const confidential = selectedAreas.filter((area) => area.containsConfidentialContent);
  const nothingToExport = !areasQuery.isPending && exportable.length === 0;
  const disabledReason = nothingToExport
    ? "You can't export any area. Ask an organization owner or admin."
    : !wholeOrganization && selectedAreas.length === 0 ? NOTHING_SELECTED : null;

  function toggle(keys: ConfigAreaKey[], checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  async function prepareDownload() {
    if (!orgId || disabledReason) return;
    setPreparing(true);
    setError(null);
    try {
      const path = configBlobPaths.export(wholeOrganization ? null : exportAreasParam(areas, selected));
      await download(path, configExportFileName(activeOrg?.slug), EXPORT_FAILED);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : EXPORT_FAILED);
    } finally {
      setPreparing(false);
    }
  }

  const prepareButton = (position: "top" | "bottom") => (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {disabledReason && !areasQuery.isPending ? <p className="text-[12px] text-gray-500" data-testid={`config-export-disabled-reason-${position}`}>{disabledReason}</p> : null}
      <DenButton
        icon={Download}
        size="sm"
        loading={preparing}
        disabled={Boolean(disabledReason) || areasQuery.isPending}
        onClick={() => void prepareDownload()}
        data-testid={position === "top" ? "config-export-download" : "config-export-download-bottom"}
      >
        {preparing ? "Preparing download…" : "Prepare download"}
      </DenButton>
    </div>
  );

  return (
    <section className="flex flex-col gap-6" aria-label="Export" data-testid="config-export">
      <div className="flex min-h-12 items-start justify-between gap-6 border-b border-gray-100 pb-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-gray-900">Whole organization</p>
          <p id={descriptionId} className="mt-0.5 max-w-[620px] text-[12px] leading-5 text-gray-500">
            Exports everything in this organization, so you can back it up or move it to another OpenWork.
            The file is very large and may contain sensitive information such as prompts and skills.
            Credentials are never included.
          </p>
        </div>
        <DenSwitch
          aria-label="Whole organization"
          aria-describedby={descriptionId}
          checked={wholeOrganization}
          disabled={preparing}
          onChange={(next) => {
            setWholeOrganization(next);
            setError(null);
          }}
          testId="config-export-whole"
        />
      </div>

      {areasQuery.isError ? (
        <DenNotice tone="error" message={areasQuery.error.message} action={<DenButton variant="secondary" size="sm" onClick={() => void areasQuery.refetch()}>Try again</DenButton>} />
      ) : wholeOrganization ? (
        prepareButton("top")
      ) : (
        <section className="flex flex-col gap-4" aria-labelledby="config-export-select-title" data-testid="config-export-select">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="config-export-select-title" className="text-[15px] font-semibold tracking-[-0.1px] text-gray-950">Select data to download</h2>
              <p className="text-[12px] text-gray-500" data-testid="config-export-selected-count">
                {selectedAreas.length === 0 ? "Nothing selected" : `${selectedAreas.length} of ${exportable.length} ${exportable.length === 1 ? "area" : "areas"} selected`}
              </p>
            </div>
            {prepareButton("top")}
          </div>

          {areasQuery.isPending ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              {[0, 1, 2, 3].map((index) => <DenSkeleton key={index} className="h-5 w-64" />)}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-gray-100 border-y border-gray-100">
              {groups.map((group) => {
                const groupExportable = group.areas.filter(isExportable);
                const groupSelected = groupExportable.filter((area) => selected.has(area.key));
                const single = group.areas.length === 1 && group.areas[0]?.path.length === 1;
                return (
                  <div key={group.label} className="flex flex-col py-1">
                    <label className="flex min-h-9 items-center gap-3 text-[13px] font-medium text-gray-900">
                      <DenCheckbox
                        checked={groupExportable.length > 0 && groupSelected.length === groupExportable.length}
                        indeterminate={groupSelected.length > 0 && groupSelected.length < groupExportable.length}
                        disabled={groupExportable.length === 0}
                        onCheckedChange={(checked) => toggle(groupExportable.map((area) => area.key), checked)}
                      />
                      {group.label}
                      {single && group.areas[0] ? <AreaMarkers area={group.areas[0]} /> : null}
                    </label>
                    {single ? null : (
                      <div className="flex flex-col pl-7">
                        {group.areas.map((area) => (
                          <label key={area.key} className="flex min-h-8 items-center gap-3 text-[13px] text-gray-700" data-testid={`config-export-area-${area.key}`}>
                            <DenCheckbox
                              checked={selected.has(area.key)}
                              disabled={!isExportable(area)}
                              onCheckedChange={(checked) => toggle([area.key], checked)}
                            />
                            <span className={isExportable(area) ? undefined : "text-gray-400"}>{areaLeafLabel(area)}</span>
                            <AreaMarkers area={area} />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {confidential.length > 0 ? (
            <DenNotice
              tone="warning"
              message={`Includes ${confidential.map((area) => area.label).join(", ")}, which can hold confidential content. Share the file only with people who should see it.`}
            />
          ) : null}
          <p className="text-[12px] text-gray-500">Never exported: credentials and API keys, billing, usage and activity history.</p>
          {prepareButton("bottom")}
        </section>
      )}

      {error ? <DenNotice tone="error" message={error} /> : null}
    </section>
  );
}

function AreaMarkers({ area }: { area: ConfigAreaDescriptor }) {
  const blocked = areaBlockedReason(area);
  if (!blocked) return null;
  return (
    <Tooltip>
      <TooltipTrigger className="inline-flex items-center gap-1 rounded text-[12px] text-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400" aria-label={blocked}>
        <LockKeyhole className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        {area.supported ? "No access" : "Not available"}
      </TooltipTrigger>
      <TooltipContent>{blocked}</TooltipContent>
    </Tooltip>
  );
}
