"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { requestAdmin, sendAdmin } from "../admin-request";

/**
 * Deployment-wide rollout of every feature in packages/features/src/registry.ts:
 * percentage and kill switch. Per-organization overrides stay on each
 * organization's row in the Overview.
 */

type AdminFeature = {
  key: string;
  label: string;
  description: string;
  subject: "organization" | "person";
  deployments: Array<"cloud" | "self_hosted">;
  start: number;
  available: boolean;
  percent: number;
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
    subject: value.subject === "person" ? "person" : "organization",
    deployments,
    start: typeof value.start === "number" ? value.start : 0,
    available: value.available === true,
    percent: typeof value.percent === "number" ? value.percent : 0,
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

function subjectNoun(subject: AdminFeature["subject"]) {
  return subject === "person" ? "people" : "organizations";
}

/** One state line per feature (DESIGN.md P1). */
function rolloutState(feature: AdminFeature): string {
  if (!feature.available) return "Not part of this deployment";
  if (feature.killed) return "Turned off everywhere";
  if (feature.lock !== null) return feature.lock ? "On for everyone · set by deployment config" : "Off for everyone · set by deployment config";
  if (feature.percent >= 100) return `On for all ${subjectNoun(feature.subject)}`;
  if (feature.percent <= 0) return "Not rolled out · organization overrides only";
  return `On for ${feature.percent}% of ${subjectNoun(feature.subject)}`;
}

function FeatureRow({ feature, onChange }: { feature: AdminFeature; onChange: (next: AdminFeature) => void }) {
  const [draft, setDraft] = useState(String(feature.percent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(String(feature.percent)), [feature.percent]);

  const save = useCallback(async (body: { percent?: number; killed?: boolean }) => {
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

  const parsed = Number(draft);
  const draftValid = draft.trim() !== "" && Number.isInteger(parsed) && parsed >= 0 && parsed <= 100;
  const changed = draftValid && parsed !== feature.percent;
  const controlsDisabled = !feature.available || saving;

  return (
    <li data-testid={`admin-feature-${feature.key}`} className="flex flex-col gap-3 border-t border-gray-100 py-4 first:border-t-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-medium text-gray-900" title={feature.description}>{feature.label}</p>
          <DenBadge tone={feature.subject === "person" ? "info" : "neutral"}>{feature.subject === "person" ? "People" : "Organizations"}</DenBadge>
          {feature.deployments.length === 1 ? <DenBadge>{feature.deployments[0] === "cloud" ? "Cloud only" : "Self-hosted only"}</DenBadge> : null}
        </div>
        <p data-testid={`admin-feature-state-${feature.key}`} className={`mt-1 text-[13px] ${feature.killed ? "text-red-700" : "text-gray-500"}`}>
          {rolloutState(feature)}
        </p>
        {error ? <p className="mt-1 text-[13px] text-red-700">{error}</p> : null}
      </div>
      <form
        className="flex shrink-0 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) void save({ percent: parsed });
        }}
      >
        <div className="w-24">
          <DenInput
            aria-label={`${feature.label} rollout percentage`}
            data-testid={`admin-feature-percent-${feature.key}`}
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={controlsDisabled}
          />
        </div>
        <span className="text-[13px] text-gray-500">%</span>
        <DenButton type="submit" variant="secondary" size="sm" disabled={!changed || controlsDisabled} loading={saving && changed}>
          Set
        </DenButton>
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
              // Turning a feature off for everyone is the one destructive action here (DESIGN.md P8).
              if (window.confirm(`Turn off ${feature.label} for everyone on this deployment? Organization overrides and deployment locks are ignored until you restore it.`)) {
                void save({ killed: true });
              }
            }}
          >
            Turn off everywhere
          </DenButton>
        )}
        </div>
      </form>
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
