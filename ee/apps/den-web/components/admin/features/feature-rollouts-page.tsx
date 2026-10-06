"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { requestAdmin, sendAdmin } from "../admin-request";

/**
 * Deployment-wide state of every feature in packages/features/src/registry.ts:
 * on or off for everyone, and the kill switch. Per-organization overrides stay
 * on each organization's row in the Overview.
 */

type AdminFeature = {
  key: string;
  label: string;
  description: string;
  deployments: Array<"cloud" | "self_hosted">;
  available: boolean;
  enabled: boolean;
  killed: boolean;
  lock: boolean | null;
};

type FeaturesReport = { deployment: "cloud" | "self_hosted"; features: AdminFeature[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFeature(value: unknown): AdminFeature | null {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.label !== "string") return null;
  const deployments = Array.isArray(value.deployments)
    ? value.deployments.filter((entry): entry is "cloud" | "self_hosted" => entry === "cloud" || entry === "self_hosted")
    : [];
  return {
    key: value.key,
    label: value.label,
    description: typeof value.description === "string" ? value.description : "",
    deployments,
    available: value.available === true,
    enabled: value.enabled === true,
    killed: value.killed === true,
    lock: typeof value.lock === "boolean" ? value.lock : null,
  };
}

function parseReport(payload: unknown): FeaturesReport | null {
  if (!isRecord(payload) || !Array.isArray(payload.features)) return null;
  return {
    deployment: payload.deployment === "cloud" ? "cloud" : "self_hosted",
    features: payload.features.map(parseFeature).filter((feature): feature is AdminFeature => feature !== null),
  };
}

/** One state line per feature (DESIGN.md P1). */
function rolloutState(feature: AdminFeature): string {
  if (!feature.available) return "Not part of this deployment";
  if (feature.killed) return "Turned off everywhere";
  if (feature.lock !== null) return feature.lock ? "On for everyone · set by deployment config" : "Off for everyone · set by deployment config";
  return feature.enabled ? "On for everyone · organization overrides apply" : "Off · organization overrides only";
}

const ON_OFF = [{ value: "on", label: "On" }, { value: "off", label: "Off" }] as const;

function FeatureRow({ feature, onChange }: { feature: AdminFeature; onChange: (next: AdminFeature) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async (body: { enabled?: boolean; killed?: boolean }) => {
    setSaving(true);
    setError(null);
    const result = await sendAdmin(`/v1/admin/features/${encodeURIComponent(feature.key)}`, "PUT", body);
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const next = isRecord(result.payload) ? parseFeature(result.payload.feature) : null;
    if (next) onChange(next);
  }, [feature.key, onChange]);

  const controlsDisabled = !feature.available || saving;

  return (
    <li data-testid={`admin-feature-${feature.key}`} className="flex flex-col gap-3 border-t border-gray-100 py-4 first:border-t-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-medium text-gray-900" title={feature.description}>{feature.label}</p>
          {feature.deployments.length === 1 ? <DenBadge>{feature.deployments[0] === "cloud" ? "Cloud only" : "Self-hosted only"}</DenBadge> : null}
        </div>
        <p data-testid={`admin-feature-state-${feature.key}`} className={`mt-1 text-[13px] ${feature.killed ? "text-red-700" : "text-gray-500"}`}>
          {rolloutState(feature)}
        </p>
        {error ? <p className="mt-1 text-[13px] text-red-700">{error}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <DenSegmented
          aria-label={`${feature.label} for everyone`}
          options={ON_OFF.map((option) => ({ ...option, disabled: controlsDisabled }))}
          value={feature.enabled ? "on" : "off"}
          onChange={(value) => {
            const enabled = value === "on";
            if (enabled !== feature.enabled) void save({ enabled });
          }}
        />
        {/* Fixed-width slot so rows stay aligned whichever button shows. */}
        <div className="flex w-40 justify-end">
          {feature.killed ? (
            <DenButton type="button" variant="secondary" size="sm" data-testid={`admin-feature-restore-${feature.key}`} disabled={controlsDisabled} onClick={() => void save({ killed: false })}>
              Restore
            </DenButton>
          ) : (
            <DenButton
              type="button"
              variant="destructive"
              size="sm"
              data-testid={`admin-feature-kill-${feature.key}`}
              disabled={controlsDisabled}
              onClick={() => {
                // Turning a feature off for everyone, overrides included, is the one destructive action here (DESIGN.md P8).
                if (window.confirm(`Turn off ${feature.label} for everyone on this deployment? Organization overrides and deployment locks are ignored until you restore it.`)) {
                  void save({ killed: true });
                }
              }}
            >
              Turn off everywhere
            </DenButton>
          )}
        </div>
      </div>
    </li>
  );
}

export function FeatureRolloutsPage() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; report: FeaturesReport }
    | { status: "signed-out" | "forbidden" | "error"; message: string }
  >({ status: "loading" });

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await requestAdmin("/v1/admin/features", parseReport, signal);
    setState(result.access === "ready" ? { status: "ready", report: result.data } : { status: result.access, message: result.message });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  const replaceFeature = useCallback((next: AdminFeature) => {
    setState((current) => current.status === "ready"
      ? { status: "ready", report: { ...current.report, features: current.report.features.map((feature) => feature.key === next.key ? next : feature) } }
      : current);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <DenPageHeader
        title="Features"
        caption={state.status === "ready" ? (state.report.deployment === "cloud" ? "OpenWork Cloud" : "Self-hosted") : undefined}
        action={<DenButton variant="secondary" size="sm" icon={RefreshCw} onClick={() => void load()}>Refresh</DenButton>}
      />
      {state.status === "signed-out" || state.status === "forbidden" ? <DenNotice tone="warning" message={state.message} /> : null}
      {state.status === "error" ? <DenNotice message={state.message} /> : null}
      {state.status === "ready" ? (
        <DenCard className="!py-1">
          <ul>
            {state.report.features.map((feature) => (
              <FeatureRow key={feature.key} feature={feature} onChange={replaceFeature} />
            ))}
          </ul>
        </DenCard>
      ) : null}
    </div>
  );
}
