"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FEATURE_CATEGORIES, FEATURE_KEYS, FEATURES, featureDocsUrl, featuresByCategory, mapFeatures, type FeatureKey } from "@openwork/features";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenSwitch } from "../../app/(den)/_components/ui/switch";
import { requestAdmin, sendAdmin } from "./admin-request";
import { describeFeatureChange, parseFeatureChange, type AdminFeatureChange } from "./feature-change";

export type AdminFeatureState = {
  enabled: boolean;
  source: "unavailable" | "killed" | "lock" | "override" | "member" | "everyone";
  everyone: boolean;
  killed: boolean;
  override: boolean | null;
  overrideApplies: boolean;
  /** Latest change that could affect this organization or member; absent from organization lists and older servers. */
  lastChange?: AdminFeatureChange | null;
};
export type AdminOrganizationFeatures = Record<FeatureKey, AdminFeatureState>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const ADMIN_FEATURE_SOURCES = ["unavailable", "killed", "lock", "override", "member", "everyone"] as const;

function parseAdminFeatureSource(value: unknown): AdminFeatureState["source"] {
  return ADMIN_FEATURE_SOURCES.find((source) => source === value) ?? "everyone";
}

/** Server featureStates, falling back to the effective capabilities map from older servers. */
export function parseAdminOrganizationFeatures(featureStates: unknown, capabilities: unknown): AdminOrganizationFeatures {
  const states = isRecord(featureStates) ? featureStates : {};
  const effective = isRecord(capabilities) ? capabilities : {};
  return mapFeatures((key) => {
    const state = states[key];
    if (!isRecord(state)) {
      const enabled = effective[key] === true;
      return { enabled, source: "everyone", everyone: enabled, killed: false, override: null, overrideApplies: true };
    }
    return {
      enabled: state.enabled === true,
      source: parseAdminFeatureSource(state.source),
      everyone: state.everyone === true,
      killed: state.killed === true,
      override: typeof state.override === "boolean" ? state.override : null,
      overrideApplies: state.overrideApplies === true,
      lastChange: parseFeatureChange(state.lastChange),
    };
  });
}

/** "2026-10-23" → "23 Oct 2026", read as a calendar day (no time zone shift). */
function formatAddedDay(added: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${added}T00:00:00Z`));
}

function describeSource(state: AdminFeatureState): string {
  switch (state.source) {
    case "everyone": return state.everyone ? "On for everyone" : "Off for everyone";
    case "member": return "Set for this member";
    case "override": return "Set for this organization";
    case "lock": return "Set by deployment config";
    case "killed": return "Turned off everywhere";
    case "unavailable": return "Not part of this deployment";
  }
}

/** Features this deployment has, in registry order. */
function visibleKeys(features: AdminOrganizationFeatures): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => features[key].source !== "unavailable");
}

export type AdminFeatureAccessFailure = { access: "signed-out" | "forbidden"; message: string };

function parseFeatures(payload: unknown): AdminOrganizationFeatures | null {
  if (!isRecord(payload) || !isRecord(payload.featureStates)) return null;
  return parseAdminOrganizationFeatures(payload.featureStates, payload.capabilities);
}

export function AdminOrganizationFeatureControls({ organizationId, memberId, refreshKey, onAccessFailure }: {
  organizationId: string;
  memberId?: string;
  refreshKey: number;
  onAccessFailure: (failure: AdminFeatureAccessFailure) => void;
}) {
  const [features, setFeatures] = useState<AdminOrganizationFeatures | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}${memberId ? `/members/${encodeURIComponent(memberId)}` : ""}/capabilities`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void requestAdmin(path, parseFeatures, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setFeatures(result.data);
      else if (result.access === "signed-out" || result.access === "forbidden") onAccessFailure({ access: result.access, message: result.message });
      else setLoadError(result.message);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load features.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, refreshKey, attempt, onAccessFailure]);

  async function save(key: FeatureKey, value: boolean | null) {
    if (!features || loading || savingRef.current) return;
    const previous = features;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setFeatures({ ...previous, [key]: { ...previous[key], enabled: value ?? previous[key].everyone, override: value, source: value === null ? "everyone" : memberId ? "member" : "override" } });
    try {
      const result = await sendAdmin(path, "PUT", { capabilities: { [key]: value } });
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          onAccessFailure({ access: result.status === 401 ? "signed-out" : "forbidden", message: result.message });
          return;
        }
        throw new Error(result.message);
      }
      const next = parseFeatures(result.payload);
      if (!next) throw new Error("The server returned incomplete feature data. Refresh to verify the saved setting.");
      setFeatures(next);
    } catch (error: unknown) {
      setFeatures(previous);
      setSaveError(error instanceof Error ? error.message : "Could not save this feature.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="min-w-0 py-5" aria-label={memberId ? "Member features" : "Organization features"} aria-busy={loading || saving} data-testid="admin-organization-features">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900">Features</h2>
        <Link href="/admin/features" prefetch={false} className="text-xs font-medium text-slate-500 underline-offset-2 hover:underline">Feature rollouts</Link>
      </div>
      {loadError ? <div className="mt-3 text-sm text-red-700" role="alert">
        <p>{loadError}</p>
        <DenButton variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry features</DenButton>
      </div> : null}
      {loading && !features ? <div className="mt-3 grid gap-2" role="status" aria-label="Loading organization features" data-testid="admin-features-loading">
        {[0, 1, 2].map((row) => <div key={row} className="h-16 rounded-lg bg-gray-100" aria-hidden="true" />)}
      </div> : null}
      {saveError ? <p data-testid="admin-capability-error" role="alert" className="mt-3 text-sm text-red-700">Could not confirm the save. Showing the previous setting. {saveError}</p> : null}
      {features ? featuresByCategory(visibleKeys(features)).map(({ category, keys }) => <section key={category} className="mt-4 min-w-0" aria-labelledby={`admin-feature-group-${category}`} data-testid={`admin-feature-group-${category}`}>
        <h3 id={`admin-feature-group-${category}`} className="text-xs font-semibold uppercase tracking-wide text-slate-500">{FEATURE_CATEGORIES[category].label}</h3>
        <ul className="mt-1 min-w-0 divide-y divide-slate-200">
        {keys.map((key) => {
          const state = features[key];
          const definition = FEATURES[key];
          return (
            <li key={key} data-testid={`admin-feature-row-${key}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
              <label className="flex min-w-0 items-start gap-3">
                <span className="shrink-0 pt-0.5"><DenSwitch testId={`admin-capability-${key}`} aria-label={definition.label} checked={state.enabled} size="sm"
                  aria-describedby={`admin-feature-source-${key}`} disabled={!state.overrideApplies || loading || saving} onChange={(enabled) => void save(key, enabled)} /></span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block text-sm font-medium text-slate-700">{definition.label}</span>
                  <span id={`admin-feature-source-${key}`} className="mt-1 block text-xs text-slate-500" data-testid={`admin-capability-source-${key}`}>{memberId && state.source === "everyone" ? `Organization setting: ${state.enabled ? "on" : "off"}` : describeSource(state)}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">{definition.description}</span>
                  {state.lastChange ? <span className="mt-1 block text-xs text-slate-500" data-testid={`admin-capability-last-change-${key}`}>Last change: {describeFeatureChange(state.lastChange, { showScope: true })}</span> : null}
                  <span className="mt-1 block text-xs text-slate-500">
                    Added {formatAddedDay(definition.added)} · Author @{definition.author}
                    {featureDocsUrl(key) ? <> · <a href={featureDocsUrl(key) ?? undefined} target="_blank" rel="noreferrer" className="font-medium text-slate-700 underline-offset-2 hover:underline">Internal docs</a></> : null}
                  </span>
                </span>
              </label>
              {state.override !== null && state.overrideApplies ? <DenButton variant="ghost" size="inline" type="button"
                data-testid={`admin-capability-reset-${key}`} disabled={loading || saving} onClick={() => void save(key, null)}
                className="max-w-full justify-self-start whitespace-normal text-left sm:self-start">
                {memberId ? "Use organization setting" : "Use everyone’s setting"}
              </DenButton> : null}
            </li>
          );
        })}
        </ul>
      </section>) : null}
    </section>
  );
}
