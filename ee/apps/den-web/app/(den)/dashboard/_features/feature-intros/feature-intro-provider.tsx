"use client";

import type { FeatureIntroEventType, FeatureIntroState } from "@openwork/types/den/feature-intros";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getOrgAccessFlags } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useFeatureIntroEvent, useFeatureIntroStates } from "./feature-intro-data";
import { FEATURE_INTROS, getFeatureIntro } from "./intros";
import { introStateFor, mergeReportedFacts, rootIntroKey, type FeatureIntroFactsReport, type FeatureIntroKnownSetup } from "./model";
import type { FeatureIntro, FeatureIntroContext, FeatureIntroFacts, FeatureIntroKey } from "./types";

type FeatureIntroRuntime = {
  /** The organization is loaded. Until then every intro surface renders nothing. */
  enabled: boolean;
  /** Member state has loaded, so dots and banners can be decided. */
  loaded: boolean;
  intros: readonly FeatureIntro[];
  stateFor: (key: FeatureIntroKey) => FeatureIntroState | null;
  record: (key: FeatureIntroKey, type: FeatureIntroEventType) => void;
  /** Context for an intro with the facts its section has reported so far, merged with `facts`. */
  contextFor: (key: FeatureIntroKey, facts?: FeatureIntroFacts) => FeatureIntroContext | null;
  /** Setup from reported facts, else the last one seen on this browser, else "unknown". */
  setupFor: (key: FeatureIntroKey) => FeatureIntroKnownSetup;
  /**
   * A mounted gate's current facts, under its own `reporter` id. Call the returned
   * function to withdraw them (unmount, or facts back to loading).
   */
  reportFacts: (reporter: string, key: FeatureIntroKey, facts: FeatureIntroFacts) => () => void;
  /** Intros mounted on the current page, so `?` can open the most specific one. */
  activeKeys: readonly FeatureIntroKey[];
  registerActive: (key: FeatureIntroKey) => () => void;
};

const disabledRuntime: FeatureIntroRuntime = {
  enabled: false,
  loaded: false,
  intros: [],
  stateFor: () => null,
  record: () => undefined,
  contextFor: () => null,
  setupFor: () => "unknown",
  reportFacts: () => () => undefined,
  activeKeys: [],
  registerActive: () => () => undefined,
};

const FeatureIntroRuntimeContext = createContext<FeatureIntroRuntime>(disabledRuntime);

/**
 * Per organization and member: what one person can see (and has set up) is not what a teammate
 * signed in on the same browser can. v2 drops v1 caches, which were shared and could hold tab
 * states guessed from other tabs' facts.
 */
function setupCacheKey(scope: string): string {
  return `den:feature-intro-setup:v2:${scope}`;
}

function readSetupCache(scope: string): Record<string, FeatureIntroKnownSetup> {
  try {
    const raw = window.localStorage.getItem(setupCacheKey(scope));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, FeatureIntroKnownSetup> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "none" || value === "partial" || value === "done") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeSetupCache(scope: string, value: Record<string, FeatureIntroKnownSetup>) {
  try {
    window.localStorage.setItem(setupCacheKey(scope), JSON.stringify(value));
  } catch {
    // Storage full or blocked: the cache only saves a round trip to the page.
  }
}

/** Mounted in the dashboard shell. Renders its children unchanged; intros start once the organization is loaded. */
export function FeatureIntroProvider({ children }: { children: ReactNode }) {
  const { orgContext, activeOrg } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? null;
  const memberId = orgContext?.currentMember.id ?? null;
  const cacheScope = orgId && memberId ? `${orgId}:${memberId}` : null;
  const enabled = Boolean(orgContext && orgId);
  const states = useFeatureIntroStates(orgId, enabled);
  const event = useFeatureIntroEvent(orgId);
  const recordEvent = event.mutate;
  // Facts from the gates mounted now, by gate. Only these count: facts from a page left
  // earlier (e.g. AI Gateway before its first provider) would otherwise outlive setup.
  const [reports, setReports] = useState<ReadonlyMap<string, FeatureIntroFactsReport>>(() => new Map());
  const [setupCache, setSetupCache] = useState<{ scope: string | null; value: Record<string, FeatureIntroKnownSetup> }>({ scope: null, value: {} });
  const [activeKeys, setActiveKeys] = useState<FeatureIntroKey[]>([]);

  useEffect(() => {
    if (!enabled || !cacheScope) return;
    setSetupCache({ scope: cacheScope, value: readSetupCache(cacheScope) });
  }, [enabled, cacheScope]);

  // Facts per section root ("ai-gateway"), merged from the gates mounted for this organization.
  const factsByRoot = useMemo(() => {
    const roots = new Set([...reports.values()].map((report) => rootIntroKey(report.key)));
    const result: Record<string, FeatureIntroFacts> = {};
    for (const root of roots) {
      const merged = mergeReportedFacts(reports.values(), root, orgId);
      if (merged) result[root] = merged;
    }
    return result;
  }, [reports, orgId]);

  // Intros whose own gate is mounted now: only their setup can be read from facts. A tab's state
  // from facts other gates reported (e.g. Limits while only Overview is on screen) would be a guess.
  const reportedKeys = useMemo(
    () => new Set([...reports.values()].filter((report) => report.orgId === orgId).map((report) => report.key)),
    [reports, orgId],
  );

  const access = useMemo(
    () => getOrgAccessFlags(
      orgContext?.currentMember.role ?? "member",
      orgContext?.currentMember.isOwner ?? false,
      orgContext?.currentMember.permissions,
    ),
    [orgContext],
  );

  const contextFor = useCallback((key: FeatureIntroKey, facts?: FeatureIntroFacts): FeatureIntroContext | null => {
    if (!enabled || !orgContext || !orgId) return null;
    const members = orgContext.members;
    return {
      orgId,
      orgSlug: activeOrg?.slug ?? orgContext.organization.slug,
      orgContext,
      access,
      isAdmin: access.isAdmin,
      can: (permission) => access[permission],
      memberName: (memberId) => {
        if (!memberId) return null;
        const member = members.find((entry) => entry.id === memberId || entry.userId === memberId);
        return member?.user.name?.trim() || member?.user.email || null;
      },
      facts: { ...factsByRoot[rootIntroKey(key)], ...facts },
    };
  }, [enabled, orgContext, orgId, activeOrg?.slug, access, factsByRoot]);

  const setupFor = useCallback((key: FeatureIntroKey): FeatureIntroKnownSetup => {
    const intro = getFeatureIntro(key);
    if (!intro || !enabled) return "unknown";
    if (intro.helpOnly) return "done";
    if (reportedKeys.has(key)) {
      const ctx = contextFor(key);
      if (ctx) return intro.setupState(ctx);
    }
    return setupCache.scope === cacheScope ? setupCache.value[key] ?? "unknown" : "unknown";
  }, [enabled, reportedKeys, contextFor, setupCache, cacheScope]);

  const reportFacts = useCallback((reporter: string, key: FeatureIntroKey, facts: FeatureIntroFacts) => {
    if (!orgId) return () => undefined;
    const report: FeatureIntroFactsReport = { orgId, key, facts };
    setReports((current) => new Map(current).set(reporter, report));
    return () => setReports((current) => {
      if (current.get(reporter) !== report) return current;
      const next = new Map(current);
      next.delete(reporter);
      return next;
    });
  }, [orgId]);

  // Remember each page's setup on this browser for this member, so dots stay quiet for set-up features.
  useEffect(() => {
    if (!enabled || !cacheScope || setupCache.scope !== cacheScope) return;
    const next = { ...setupCache.value };
    let changed = false;
    for (const intro of FEATURE_INTROS) {
      if (!reportedKeys.has(intro.key)) continue;
      const state = setupFor(intro.key);
      if (state !== "unknown" && next[intro.key] !== state) {
        next[intro.key] = state;
        changed = true;
      }
    }
    if (!changed) return;
    writeSetupCache(cacheScope, next);
    setSetupCache({ scope: cacheScope, value: next });
  }, [enabled, cacheScope, reportedKeys, setupCache, setupFor]);

  const stateList = states.data;
  const stateFor = useCallback((key: FeatureIntroKey) => {
    const intro = getFeatureIntro(key);
    return intro && stateList ? introStateFor(stateList, key, intro.version) : null;
  }, [stateList]);

  const record = useCallback((key: FeatureIntroKey, type: FeatureIntroEventType) => {
    const intro = getFeatureIntro(key);
    if (!enabled || !intro) return;
    recordEvent({ introKey: key, introVersion: intro.version, type });
  }, [enabled, recordEvent]);

  const registerActive = useCallback((key: FeatureIntroKey) => {
    setActiveKeys((current) => [...current, key]);
    return () => setActiveKeys((current) => {
      const index = current.indexOf(key);
      return index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
    });
  }, []);

  const value = useMemo<FeatureIntroRuntime>(() => enabled
    ? {
        enabled,
        loaded: states.isSuccess,
        intros: FEATURE_INTROS,
        stateFor,
        record,
        contextFor,
        setupFor,
        reportFacts,
        activeKeys,
        registerActive,
      }
    : disabledRuntime,
  [enabled, states.isSuccess, stateFor, record, contextFor, setupFor, reportFacts, activeKeys, registerActive]);

  return <FeatureIntroRuntimeContext.Provider value={value}>{children}</FeatureIntroRuntimeContext.Provider>;
}

export function useFeatureIntroRuntime(): FeatureIntroRuntime {
  return useContext(FeatureIntroRuntimeContext);
}
