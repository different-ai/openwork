import { ReleaseFeedLab, createReleaseCatalog } from "../runner/labs/release-feed.mjs";
import { expectActionableFeedError, releaseLabProductImportPrecondition } from "../runner/journeys/update.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "release-feed-degraded";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

export default {
  id: FLOW_ID,
  title: "Release feed degradation produces named actionable errors",
  kind: "internal",
  requiresApp: false,
  precondition: releaseLabProductImportPrecondition,
  steps: [
    {
      name: "Frame 1 — artifact propagation 504",
      run: async (ctx) => {
        const feed = await new ReleaseFeedLab({
          catalog: [{
            version: "0.17.40",
            assets: [{
              platform: "win-x64",
              distribution: "enterprise",
              fault: { kind: "status", status: 504, message: "release propagation lag" },
            }],
          }],
          actionableProbe: { kind: "asset", version: "0.17.40", platform: "win-x64" },
        }).start();
        try {
          await ctx.prove("A 504 from the artifact route surfaces as release_asset_propagation_lag", {
            voiceover: vo[0],
            assert: async () => {
              const error = await expectActionableFeedError(ctx, { feed });
              ctx.assert(error.code === "release_asset_propagation_lag", `Expected release_asset_propagation_lag, got ${error.code}`);
            },
          });
        } finally {
          await feed.stop();
        }
      },
    },
    {
      name: "Frame 2 — stale version cache",
      run: async (ctx) => {
        const feed = new ReleaseFeedLab({
          initialCatalog: createReleaseCatalog(["0.17.20"], { platforms: ["win-x64"], distribution: "enterprise" }),
          catalog: createReleaseCatalog(["0.17.20", "0.17.40"], { platforms: ["win-x64"], distribution: "enterprise" }),
          staleUntil: Date.now() + 60_000,
          actionableProbe: { kind: "cache", expectedVersion: "0.17.40" },
        });
        await ctx.prove("A stale release metadata cache surfaces as release_feed_cache_stale", {
          voiceover: vo[1],
          assert: async () => {
            const error = await expectActionableFeedError(ctx, { feed });
            ctx.assert(error.code === "release_feed_cache_stale", `Expected release_feed_cache_stale, got ${error.code}`);
          },
        });
      },
    },
    {
      name: "Frame 3 — denied release host",
      run: async (ctx) => {
        const feed = new ReleaseFeedLab({
          catalog: createReleaseCatalog(["0.17.40"], { platforms: ["win-x64"], distribution: "enterprise" }),
          actionableProbe: {
            kind: "host",
            url: "https://github.com/different-ai/openwork/releases/download/v0.17.40/openwork-enterprise-win-x64-0.17.40.exe",
            allowedHosts: ["app.openworklabs.com", "api.openworklabs.com"],
          },
        });
        await ctx.prove("A corporate policy that denies GitHub surfaces as release_host_denied", {
          voiceover: vo[2],
          assert: async () => {
            const error = await expectActionableFeedError(ctx, { feed });
            ctx.assert(error.code === "release_host_denied", `Expected release_host_denied, got ${error.code}`);
          },
        });
      },
    },
  ],
};
