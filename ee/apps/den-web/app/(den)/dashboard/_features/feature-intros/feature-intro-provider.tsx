"use client";

import type { FeatureIntroEventType, FeatureIntroState } from "@openwork/types/den/feature-intros";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useFeatureIntroEvent, useFeatureIntroStates } from "./feature-intro-data";
import { FEATURE_INTROS, getFeatureIntro } from "./intros";
import { introStateFor, rootIntroKey, type FeatureIntroKnownSetup } from "./model";
import type { FeatureIntro, FeatureIntroContext, FeatureIntroFacts, FeatureIntroKey } from "./types";

type FeatureIntroRuntime = {
  /** `featureIntros` is on and the organization is loaded. Off: every intro surface renders nothing. */
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
  reportFacts: (key: FeatureIntroKey, facts: FeatureIntroFacts) => void;
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
  reportFacts: () => undefined,
  activeKeys: [],
  registerActive: () => () => undefined,
};

const FeatureIntroRuntimeContext = createContext<FeatureIntroRuntime>(disabledRuntime);

function setupCacheKey(orgId: string): string {
  return `den:feature-intro-setup:${orgId}`;
}

function readSetupCache(orgId: string): Record<string, FeatureIntroKnownSetup> {
  try {
    const raw = window.localStorage.getItem(setupCacheKey(orgId));
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

function writeSetupCache(orgId: string, value: Record<string, FeatureIntroKnownSetup>) {
  try {
    window.localStorage.setItem(setupCacheKey(orgId), JSON.stringify(value));
  } catch {
    // Storage full or blocked: the cache only saves a round trip to the page.
  }
}

function sameFacts(a: FeatureIntroFacts | undefined, b: FeatureIntroFacts): boolean {
  if (!a) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/** Mounted in the dashboard shell. Renders its children unchanged; gated on the `featureIntros` flag. */
export function FeatureIntroProvider({ children }: { children: ReactNode }) {
  const { orgContext, activeOrg } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? null;
  const enabled = Boolean(orgContext && orgId) && orgFeatureEnabled(orgContext, "featureIntros");
  const states = useFeatureIntroStates(orgId, enabled);
  const event = useFeatureIntroEvent(orgId);
  const recordEvent = event.mutate;
  // Facts per section root ("ai-gateway"), merged from every gate on the page.
  const [factsByRoot, setFactsByRoot] = useState<Record<string, FeatureIntroFacts>>({});
  const [setupCache, setSetupCache] = useState<{ orgId: string | null; value: Record<string, FeatureIntroKnownSetup> }>({ orgId: null, value: {} });
  const [activeKeys, setActiveKeys] = useState<FeatureIntroKey[]>([]);

  useEffect(() => {
    if (!enabled || !orgId) return;
    setSetupCache({ orgId, value: readSetupCache(orgId) });
    setFactsByRoot({});
  }, [enabled, orgId]);

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
    const facts = factsByRoot[rootIntroKey(key)];
    if (facts) {
      const ctx = contextFor(key);
      if (ctx) return intro.setupState(ctx);
    }
    return setupCache.orgId === orgId ? setupCache.value[key] ?? "unknown" : "unknown";
  }, [enabled, factsByRoot, contextFor, setupCache, orgId]);

  const reportFacts = useCallback((key: FeatureIntroKey, facts: FeatureIntroFacts) => {
    const root = rootIntroKey(key);
    setFactsByRoot((current) => {
      const merged = { ...current[root], ...facts };
      return sameFacts(current[root], merged) ? current : { ...current, [root]: merged };
    });
  }, []);

  // Remember each section's setup on this browser so sidebar dots stay quiet for set-up features.
  useEffect(() => {
    if (!enabled || !orgId || setupCache.orgId !== orgId) return;
    const next = { ...setupCache.value };
    let changed = false;
    for (const intro of FEATURE_INTROS) {
      if (!factsByRoot[rootIntroKey(intro.key)]) continue;
      const state = setupFor(intro.key);
      if (state !== "unknown" && next[intro.key] !== state) {
        next[intro.key] = state;
        changed = true;
      }
    }
    if (!changed) return;
    writeSetupCache(orgId, next);
    setSetupCache({ orgId, value: next });
  }, [enabled, orgId, factsByRoot, setupCache, setupFor]);

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
