import { ReleaseFeedLab, createReleaseCatalog } from "../runner/labs/release-feed.mjs";
import { expectDownloadUrl, expectOfferedVersion, releaseLabProductImportPrecondition } from "../runner/journeys/update.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "release-allowlist-targeting";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

export default {
  id: FLOW_ID,
  title: "Hermetic release lab targets the highest admin-allowed desktop version",
  kind: "internal",
  requiresApp: false,
  precondition: releaseLabProductImportPrecondition,
  steps: [
    {
      name: "Frame 1 — allowlist caps below latest",
      run: async (ctx) => {
        const feed = await new ReleaseFeedLab({
          catalog: createReleaseCatalog(["0.17.20", "0.17.30", "0.17.40"], { platforms: ["win-x64"], distribution: "enterprise" }),
        }).start();
        try {
          await ctx.prove("A client allowed through 0.17.30 is offered 0.17.30, never public latest 0.17.40", {
            voiceover: vo[0],
            assert: async () => {
              await expectOfferedVersion(ctx, {
                feed,
                client: { currentVersion: "0.17.20", platform: "win-x64", allowedVersions: ["0.17.30"] },
                expected: "0.17.30",
              });
              await expectDownloadUrl(ctx, {
                feed,
                version: "0.17.30",
                platform: "win-x64",
                expected: `${feed.baseUrl}/different-ai/openwork/releases/download/v0.17.30/openwork-enterprise-win-x64-0.17.30.exe`,
              });
            },
          });
        } finally {
          await feed.stop();
        }
      },
    },
    {
      name: "Frame 2 — allowed release predates installer support",
      run: async (ctx) => {
        const feed = await new ReleaseFeedLab({
          catalog: createReleaseCatalog(["0.17.20", "0.17.40"], {
            platforms: ["win-x64"],
            distribution: "enterprise",
            preInstallerVersions: ["0.17.20"],
          }),
        }).start();
        try {
          await ctx.prove("An approved release without installer-capable assets fails with an actionable error", {
            voiceover: vo[1],
            assert: async () => {
              await expectOfferedVersion(ctx, {
                feed,
                client: { currentVersion: "0.17.10", platform: "win-x64", allowedVersions: ["0.17.20"] },
                expected: "0.17.20",
              });
              await expectDownloadUrl(ctx, {
                feed,
                version: "0.17.20",
                platform: "win-x64",
                expected: { errorCode: "release_asset_not_installer_capable" },
              });
            },
          });
        } finally {
          await feed.stop();
        }
      },
    },
  ],
};
