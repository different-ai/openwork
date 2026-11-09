"use client";

import type { ConfigAreaDescriptor, ConfigAreaKey } from "@openwork/types/den/config-blobs";
import { Download, LockKeyhole } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenCheckbox } from "../../../_components/ui/checkbox";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../_components/ui/tooltip";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { configBlobPaths, downloadConfigFile, useConfigAreas } from "./config-blobs-data";
import { areaLeafLabel, configExportFileName, exportAreasParam, groupConfigAreas, isExportable } from "./config-blobs-model";

function areaBlockedReason(area: ConfigAreaDescriptor): string | null {
  if (!area.supported) return area.unsupportedReason ?? "Not available on this OpenWork.";
  if (!area.canExport) return "You don't have permission to view this. Ask an organization owner or admin.";
  return null;
}

export function ConfigExportSection() {
  const { orgId, activeOrg } = useOrgDashboard();
  const areasQuery = useConfigAreas(orgId);
  const areas = useMemo(() => areasQuery.data?.areas ?? [], [areasQuery.data]);
  const groups = useMemo(() => groupConfigAreas(areas), [areas]);
  const exportable = useMemo(() => areas.filter(isExportable), [areas]);
  const [selected, setSelected] = useState<Set<ConfigAreaKey>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whole organization by default, once the areas arrive.
  useEffect(() => {
    if (initialized || exportable.length === 0) return;
    setSelected(new Set(exportable.map((area) => area.key)));
    setInitialized(true);
  }, [exportable, initialized]);

  const selectedAreas = exportable.filter((area) => selected.has(area.key));
  const allSelected = exportable.length > 0 && selectedAreas.length === exportable.length;
  const confidential = selectedAreas.filter((area) => area.containsConfidentialContent);

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

  async function download() {
    if (!orgId || selectedAreas.length === 0) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadConfigFile(orgId, configBlobPaths.export(exportAreasParam(areas, selected)), configExportFileName(activeOrg?.slug), "Couldn't export the configuration.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't export the configuration.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="config-export-title" data-testid="config-export">
      <div className="flex items-center justify-between gap-4">
        <h2 id="config-export-title" className="text-[15px] font-semibold tracking-[-0.1px] text-gray-950">Export</h2>
        <DenButton
          icon={Download}
          size="sm"
          loading={downloading}
          disabled={selectedAreas.length === 0 || areasQuery.isPending}
          onClick={() => void download()}
          data-testid="config-export-download"
        >
          {allSelected ? "Download whole organization" : `Download ${selectedAreas.length} ${selectedAreas.length === 1 ? "area" : "areas"}`}
        </DenButton>
      </div>

      {areasQuery.isError ? (
        <DenNotice tone="error" message={areasQuery.error.message} action={<DenButton variant="secondary" size="sm" onClick={() => void areasQuery.refetch()}>Try again</DenButton>} />
      ) : areasQuery.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2, 3].map((index) => <DenSkeleton key={index} className="h-5 w-64" />)}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-gray-100 border-y border-gray-100">
          <label className="flex min-h-10 items-center gap-3 py-2 text-[13px] font-medium text-gray-950">
            <DenCheckbox
              checked={allSelected}
              indeterminate={!allSelected && selectedAreas.length > 0}
              disabled={exportable.length === 0}
              onCheckedChange={(checked) => toggle(exportable.map((area) => area.key), checked)}
              data-testid="config-export-all"
            />
            Whole organization
          </label>
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
      <p className="text-[13px] text-gray-500">Never exported: credentials and API keys, billing, usage and activity history.</p>
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
