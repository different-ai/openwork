import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayProviderRemovalUsageLimit, GatewayUsageLimitPolicy } from "@openwork/types/den/gateway-usage-limits";
import { GatewayLimitRow } from "./gateway-usage-limits-section";
import { ProviderRemovalUsageLimits, providerMoveTargets, providerUsageLimits } from "./provider-removal-usage-limits";

const removedProvider = "ip_removed";
const monthly: GatewayProviderRemovalUsageLimit = { id: "policy-1", name: "Acme research cap", revision: 2, hardLimit: true, limits: [{ timeframe: "month", costLimitMicroUsd: 4_000_000_000 }] };

function policy(overrides: Partial<GatewayUsageLimitPolicy>): GatewayUsageLimitPolicy {
  return { id: "policy-1", name: "Acme research cap", hardLimit: true, allowRequestReset: true, revision: 2, providerId: removedProvider, providerStatus: "available", limits: monthly.limits, assignments: [], archivedAt: null, ...overrides };
}

test("only active limits scoped to the removed provider are affected", () => {
  const limits = providerUsageLimits([
    policy({}),
    policy({ id: "archived", archivedAt: "2026-10-01T00:00:00.000Z" }),
    policy({ id: "other-provider", providerId: "ip_other" }),
    policy({ id: "default", providerId: null, providerStatus: null }),
  ], removedProvider);
  assert.deepEqual(limits, [monthly]);
});

test("limits can move only to another active provider", () => {
  const targets = providerMoveTargets([
    { id: removedProvider, name: "Acme OpenRouter old", status: "active" },
    { id: "ip_new", name: "Acme OpenRouter", status: "active" },
    { id: "ip_off", name: "Acme Anthropic", status: "disabled" },
  ], removedProvider);
  assert.deepEqual(targets.map((target) => target.id), ["ip_new"]);
});

test("the dialog names each limit and offers to move them or delete them too", () => {
  const html = renderToStaticMarkup(<ProviderRemovalUsageLimits providerName="Acme OpenRouter old" usageLimits={[monthly]}
    targets={[{ id: "ip_new", name: "Acme OpenRouter", status: "active" }]} choice={{ action: "move", providerId: "ip_new" }} onChange={() => undefined} />);
  assert.match(html, /1 spend limit uses Acme OpenRouter old/);
  assert.match(html, /Acme research cap/);
  assert.match(html, /\$4,000\.00 a month/);
  assert.match(html, /Move the limit to Acme OpenRouter/);
  assert.match(html, /Delete the limit too/);
  assert.match(html, /data-testid="gateway-provider-remove-limits-move"[^>]*checked=""/);
});

test("without another provider the only choice is deleting the limits", () => {
  const html = renderToStaticMarkup(<ProviderRemovalUsageLimits providerName="Acme OpenRouter" usageLimits={[monthly, { ...monthly, id: "policy-2", name: "Acme sales cap" }]}
    targets={[]} choice={{ action: "archive" }} onChange={() => undefined} />);
  assert.doesNotMatch(html, /Move (the limit|limits) to/);
  assert.match(html, /2 spend limits use/);
  assert.match(html, /Delete the limits too/);
});

test("a provider without limits adds nothing to the dialog", () => {
  assert.equal(renderToStaticMarkup(<ProviderRemovalUsageLimits providerName="Acme" usageLimits={[]} targets={[]} choice={{ action: "archive" }} onChange={() => undefined} />), "");
});

test("a limit whose provider was removed says it is not applied and offers to choose a provider", () => {
  const html = renderToStaticMarkup(<ul><GatewayLimitRow policy={policy({ providerStatus: "removed" })} orgSlug="acme" teams={[]} members={[]} providers={[]} /></ul>);
  assert.match(html, /Provider removed/);
  assert.match(html, /Not applied/);
  assert.match(html, /Choose provider/);
  assert.doesNotMatch(html, />Edit</);
  const live = renderToStaticMarkup(<ul><GatewayLimitRow policy={policy({})} orgSlug="acme" teams={[]} members={[]} providers={[{ id: removedProvider, name: "Acme OpenRouter" }]} /></ul>);
  assert.doesNotMatch(live, /Provider removed/);
  assert.match(live, />Edit</);
});
