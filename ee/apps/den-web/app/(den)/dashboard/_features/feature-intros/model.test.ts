import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureIntroState } from "@openwork/types/den/feature-intros";
import { Box } from "lucide-react";
import { getOrgAccessFlags, parseOrgContextPayload } from "../../../_lib/den-org";
import {
  FEATURE_INTRO_QUIET_MS,
  applyIntroEvent,
  introBannerDismissed,
  introDotVisible,
  introStateFor,
  matchFeatureIntro,
  pickIntroCta,
  selectIntroSize,
  shouldRecordSeen,
} from "./model";
import { defineFeatureIntro, type FeatureIntroContext, type FeatureIntroKey } from "./types";

const now = Date.parse("2026-11-03T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

function intro(key: FeatureIntroKey, path: string, tab?: string, tabParam?: "tab" | "view" | "show") {
  return defineFeatureIntro<{ providers?: number }>({
    key,
    version: 1,
    match: { path, tab, tabParam },
    icon: Box,
    title: key,
    summary: "One line.",
    docsUrl: "https://openworklabs.com/docs",
    ctas: [
      { when: (ctx) => ctx.can("canManageSettings"), label: "Add your first AI provider", href: "/dashboard/ai-gateway/providers/new" },
      { when: () => true, label: "Use these models in OpenWork", href: "/dashboard", locked: { reason: "Your admin manages models" } },
    ],
    setupState: (ctx) => ((ctx.facts.providers ?? 0) > 0 ? "done" : "none"),
  });
}

const gateway = intro("ai-gateway", "/dashboard/ai-gateway");
const limits = intro("ai-gateway.limits", "/dashboard/ai-gateway", "limits");
const mcps = intro("plugins.mcps", "/dashboard/plugins", "mcps", "view");
const team = intro("team-detail.role", "/dashboard/members/teams/:teamId");
const intros = [gateway, limits, mcps, team];

function state(partial: Partial<FeatureIntroState>): FeatureIntroState {
  return { introKey: "ai-gateway", introVersion: 1, firstSeenAt: null, lastSeenAt: null, dismissedAt: null, ctaClickedAt: null, ...partial };
}

test("matches path + tab before path alone, with each page's tab param", () => {
  assert.equal(matchFeatureIntro(intros, "/dashboard/ai-gateway", new URLSearchParams("tab=limits"))?.key, "ai-gateway.limits");
  assert.equal(matchFeatureIntro(intros, "/dashboard/ai-gateway/", new URLSearchParams("tab=overview"))?.key, "ai-gateway");
  assert.equal(matchFeatureIntro(intros, "/dashboard/ai-gateway", null)?.key, "ai-gateway");
  assert.equal(matchFeatureIntro(intros, "/dashboard/plugins", new URLSearchParams("tab=mcps")), null);
  assert.equal(matchFeatureIntro(intros, "/dashboard/plugins", new URLSearchParams("view=mcps"))?.key, "plugins.mcps");
  assert.equal(matchFeatureIntro(intros, "/dashboard/members/teams/team_123", null)?.key, "team-detail.role");
  assert.equal(matchFeatureIntro(intros, "/dashboard/ai-gateway/providers/new", null), null);
});

test("a literal path beats a :param path on the same route", () => {
  const detail = intro("connectors.access", "/dashboard/mcp-connections/:connectorId");
  const add = intro("connectors.add", "/dashboard/mcp-connections/new");
  for (const intros of [[detail, add], [add, detail]]) {
    assert.equal(matchFeatureIntro(intros, "/dashboard/mcp-connections/new", null)?.key, "connectors.add");
    assert.equal(matchFeatureIntro(intros, "/dashboard/mcp-connections/emc_123", null)?.key, "connectors.access");
  }
  assert.equal(matchFeatureIntro([detail], "/dashboard/mcp-connections/new", null)?.key, "connectors.access");
});

test("dot shows while not set up and unseen for 30 days, never once set up", () => {
  assert.equal(introDotVisible("none", null, now), true);
  assert.equal(introDotVisible("partial", state({ lastSeenAt: daysAgo(2) }), now), false);
  assert.equal(introDotVisible("none", state({ lastSeenAt: daysAgo(31) }), now), true);
  assert.equal(introDotVisible("done", null, now), false);
  assert.equal(introDotVisible("unknown", null, now), true);
  assert.equal(introDotVisible("unknown", state({ lastSeenAt: daysAgo(40) }), now), false);
});

test("a dismissed banner stays hidden for 30 days", () => {
  assert.equal(introBannerDismissed(state({ dismissedAt: daysAgo(29) }), now), true);
  assert.equal(introBannerDismissed(state({ dismissedAt: new Date(now - FEATURE_INTRO_QUIET_MS - 1).toISOString() }), now), false);
  assert.equal(introBannerDismissed(null, now), false);
});

test("size follows setup state", () => {
  assert.deepEqual(selectIntroSize({ state: "none", parentState: null }), { size: "fullscreen", target: "self" });
  assert.deepEqual(selectIntroSize({ state: "none", parentState: "none" }), { size: "fullscreen", target: "parent" });
  assert.deepEqual(selectIntroSize({ state: "done", parentState: "none" }), { size: "fullscreen", target: "parent" });
  assert.deepEqual(selectIntroSize({ state: "none", parentState: "partial" }), { size: "box", target: "self" });
  assert.deepEqual(selectIntroSize({ state: "partial", parentState: "done" }), { size: "banner", target: "self" });
  assert.deepEqual(selectIntroSize({ state: "partial", parentState: null }), { size: "banner", target: "self" });
  assert.equal(selectIntroSize({ state: "done", parentState: "partial" }), null);
});

test("an older registry version counts as never seen", () => {
  const rows = [state({ introVersion: 1, lastSeenAt: daysAgo(1) })];
  assert.equal(introStateFor(rows, "ai-gateway", 2), null);
  assert.equal(introStateFor(rows, "ai-gateway", 1)?.lastSeenAt, daysAgo(1));
});

test("seen is recorded at most hourly and events apply optimistically", () => {
  assert.equal(shouldRecordSeen(state({ lastSeenAt: new Date(now - 5 * 60_000).toISOString() }), now), false);
  assert.equal(shouldRecordSeen(state({ lastSeenAt: daysAgo(1) }), now), true);
  const seen = applyIntroEvent([], { introKey: "ai-gateway", introVersion: 1, type: "seen" }, daysAgo(0));
  assert.equal(seen[0].firstSeenAt, daysAgo(0));
  const dismissed = applyIntroEvent(seen, { introKey: "ai-gateway", introVersion: 1, type: "dismissed" }, daysAgo(0));
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].dismissedAt, daysAgo(0));
  assert.equal(dismissed[0].firstSeenAt, daysAgo(0));
});

test("the first matching action wins; members get the locked one", () => {
  const orgContext = parseOrgContextPayload({
    organization: { id: "org_1", name: "Acme", slug: "acme" },
    currentMember: { id: "member_1", userId: "user_1", role: "admin" },
  });
  assert.ok(orgContext);
  const ctx = (canManage: boolean): FeatureIntroContext => ({
    orgId: "org_1",
    orgSlug: "acme",
    orgContext,
    access: getOrgAccessFlags(canManage ? "admin" : "member", false),
    isAdmin: canManage,
    can: () => canManage,
    memberName: () => null,
    facts: {},
  });
  assert.equal(pickIntroCta(gateway, ctx(true))?.label, "Add your first AI provider");
  assert.equal(pickIntroCta(gateway, ctx(false))?.locked?.reason, "Your admin manages models");
});
