import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appPresentation, APP_FALLBACK, APP_REPLY, APP_REQUEST, APP_RESOURCE } from "../worlds/app-presentation.ts";

const test = spec.world(appPresentation, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "opencode"] },
});

/** Small-sample nearest-rank statistics, not an estimated population SLA. */
function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return { n: 0, medianMs: null, p95NearestRankMs: null };
  const lower = ordered[Math.floor((ordered.length - 1) / 2)] ?? 0;
  const upper = ordered[Math.floor(ordered.length / 2)] ?? 0;
  return { n: ordered.length, medianMs: (lower + upper) / 2,
    p95NearestRankMs: ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null };
}

type Sample = {
  outcome: "useful" | "censored";
  actionToFallbackMs: number;
  actionToUsefulMs: number | null;
  fallbackToUsefulMs: number | null;
  discoveryQueueMs: number | null;
  discoveryRoundtripMs: number | null;
  bridgeDeliveryMs: number | null;
  providerRoundtripMs: number | null;
  fixtureProviderServiceMs: number | null;
  providerRequests: number;
  keptResultRechecks: number;
  conversationNavigationMs: number | null;
  conversationToUsefulMs: number | null;
};

test("a member can compare five cold-preview, browser-warm and conversation-reopen observations without confusing them with a general latency promise", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the member publishes a checklist whose useful state waits for its declared read", async () => {
    await user.type("composer", APP_REQUEST);
    await user.click("Run task");
    await user.see({ role: "button", label: "Open preview" }, { timeoutMs: 60_000 });
    await world.releaseReply();
    await user.see({ text: APP_REPLY });
    const panes = (await probe.dom("[data-built-app-preview]")).elements.length;
    expect(panes).toBe(0);
    evidence.recordAssertionEvidence("Publication has no preview or provider reads until the member opens it", `panes=${panes}; declared read requests=${world.providerReads().length}; no live providers`, panes === 0 && world.providerReads().length === 0);
    await user.screenshot();
  });

  const close = async () => {
    await user.click("Close panel");
    await user.notSee({ text: "Saved fallback · Not live data" });
  };
  const useful = () => user.see({ role: "heading", text: "Project checklist", mcpApp: { resourceUri: APP_RESOURCE } }, { timeoutMs: 20_000 });
  const measure = async (conversationStart: number | null, conversationNavigationMs: number | null): Promise<Sample> => {
    const previousReads = world.providerReads().length;
    const previousRechecks = world.keptResultChecks().length;
    const before = await world.geometry();
    const start = performance.now();
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ text: APP_FALLBACK });
    await user.see({ text: "Saved fallback · Not live data" });
    const fallbackAt = performance.now();
    const fallbackGeometry = (await world.geometry()).fallback;
    let usefulAt: number | null = null;
    try {
      await useful();
      await user.see({ text: "Connected" });
      usefulAt = performance.now();
      // The measured useful state must actually be interactive, not a heading
      // shown before the read or a bridge-initialization acknowledgement.
      await user.click({ role: "button", text: "Mark reviewed", mcpApp: { resourceUri: APP_RESOURCE } });
    } catch {
      // Failed observations are retained as censored samples, never substituted
      // with a deadline or included in successful-time quantiles.
    }
    const after = await world.geometry();
    expect(after.fallback).toEqual(fallbackGeometry);
    const marks = after.timings.slice(before.timings.length);
    const duration = (name: string) => marks.findLast(mark => mark.name === `openwork.mcp-app.${name}`)?.duration ?? null;
    const reads = world.providerReads().slice(previousReads);
    const rechecks = world.keptResultChecks().slice(previousRechecks);
    if (usefulAt !== null) expect(reads.length + rechecks.length).toBe(1);
    return {
      outcome: usefulAt === null ? "censored" : "useful",
      actionToFallbackMs: Math.round(fallbackAt - start),
      actionToUsefulMs: usefulAt === null ? null : Math.round(usefulAt - start),
      fallbackToUsefulMs: usefulAt === null ? null : Math.round(usefulAt - fallbackAt),
      discoveryQueueMs: duration("chat.discovery-queue"),
      discoveryRoundtripMs: duration("chat.discovery-resolve"),
      bridgeDeliveryMs: duration("result-delivered"),
      providerRoundtripMs: duration("desktop.tool-roundtrip"),
      fixtureProviderServiceMs: reads.at(-1)?.elapsedMs ?? null,
      providerRequests: reads.length,
      keptResultRechecks: rechecks.length,
      conversationNavigationMs,
      conversationToUsefulMs: usefulAt === null || conversationStart === null ? null : Math.round(usefulAt - conversationStart),
    };
  };

  for (const phase of ["cold", "warm", "reopen"] satisfies Array<Parameters<typeof world.scenario>[0]>) {
    await step(`${phase === "cold" ? "five fresh-document previews" : phase === "warm" ? "five browser-warm previews" : "five conversation reopens"} keep fallback, discovery and provider observations separate`, async () => {
      world.scenario(phase);
      if (phase === "warm") {
        await world.warmBrowserCache();
        // One unmeasured priming open makes browser-warm mean a previous
        // successful sandbox navigation. Its shipping no-store policy stays intact;
        // browser-warm is not a claim that the sandbox HTML had an HTTP cache hit.
        await user.click({ role: "button", label: "Open preview" });
        await useful();
        await close();
      }
      const samples: Sample[] = [];
      for (let index = 0; index < 5; index++) {
        let conversationStart: number | null = null;
        let conversationNavigationMs: number | null = null;
        if (phase === "cold") {
          await world.coldBrowserCache();
          await user.reload();
          await user.see({ role: "button", label: "Open preview" });
        } else if (phase === "reopen") {
          await user.click({ role: "button", label: "Reference notes" });
          await probe.eventually(() => probe.hash(), { within: 15_000, label: "the reference conversation", until: route => route.includes(world.neighbor.sessionId) });
          conversationStart = performance.now();
          await user.click({ role: "button", label: "Project checklist" });
          await user.see({ role: "button", label: "Open preview" });
          conversationNavigationMs = Math.round(performance.now() - conversationStart);
        }
        samples.push(await measure(conversationStart, conversationNavigationMs));
        if (index < 4) await close();
      }
      const successful = samples.filter(sample => sample.outcome === "useful");
      const metric = (read: (sample: Sample) => number | null) => distribution(successful.flatMap(sample => {
        const value = read(sample);
        return value === null ? [] : [value];
      }));
      const summary = {
        attempted: samples.length, successful: successful.length, censored: samples.length - successful.length,
        providerRequests: samples.reduce((sum, sample) => sum + sample.providerRequests, 0),
        keptResultRechecks: samples.reduce((sum, sample) => sum + sample.keptResultRechecks, 0),
        actionToFallback: distribution(samples.map(sample => sample.actionToFallbackMs)),
        actionToUseful: metric(sample => sample.actionToUsefulMs),
        fallbackToUseful: metric(sample => sample.fallbackToUsefulMs),
        discoveryQueue: metric(sample => sample.discoveryQueueMs),
        discoveryRoundtrip: metric(sample => sample.discoveryRoundtripMs),
        bridgeDelivery: metric(sample => sample.bridgeDeliveryMs),
        providerRoundtrip: metric(sample => sample.providerRoundtripMs),
        fixtureProviderService: metric(sample => sample.fixtureProviderServiceMs),
        conversationNavigation: metric(sample => sample.conversationNavigationMs),
        conversationToUseful: metric(sample => sample.conversationToUsefulMs),
      };
      const definition = phase === "cold"
        ? "fresh renderer document; HTTP cache cleared and disabled before reload; existing browser/server processes; Open-to-useful excludes reload boot"
        : phase === "warm"
          ? "same document/process; HTTP cache enabled after one successful unmeasured priming open; sandbox no-store policy respected, not a claimed HTTP cache hit; pane closed between samples"
          : "same document/process with HTTP cache enabled and sandbox no-store respected; navigate to another conversation and back through UI; record navigation-to-useful separately from Open-to-useful";
      evidence.recordAssertionEvidence("Five bounded observations report a small-sample median and nearest-rank p95 without a general SLA", `${phase}: ${definition}; signed-out local fixture so account presentation/result stores are inactive, not bypassed; the existing in-memory open-load cache remains active, rechecks current authority and labels reused data Saved result. Deterministic read-only provider service=120ms only when actually called; cache rechecks are not provider calls. Cold discovery=250ms, others=0ms; 1440x900. DOM-visible useful-state observations include CDP overhead, not display-device paint. n=5 is small; nearest-rank p95 is the sample maximum, not population p95. Errors are censored, not successful times. Summary=${JSON.stringify(summary)}; raw=${JSON.stringify(samples)}`, successful.length === 5 && summary.providerRequests + summary.keptResultRechecks === 5 && summary.discoveryRoundtrip.n === 5);
      expect(successful).toHaveLength(5);
      expect(summary.providerRequests + summary.keptResultRechecks).toBe(5);
      expect(summary.providerRoundtrip.n).toBe(summary.providerRequests);
      expect(summary.discoveryRoundtrip.n).toBe(5);
      expect(summary.actionToUseful.p95NearestRankMs).not.toBeNull();
      await user.screenshot();
      await close();
    });
  }
});
