import { expectBootstrapPrecedenceSurvives, releaseLabProductImportPrecondition } from "../runner/journeys/update.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "release-bootstrap-precedence";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const ORG_URL = "http://openwork.example-manufacturing.internal:48765";
const HOSTED_URL = "https://app.openworklabs.com";

export default {
  id: FLOW_ID,
  title: "Update-like bootstrap re-resolution preserves the configured organization server URL",
  kind: "internal",
  requiresApp: false,
  precondition: releaseLabProductImportPrecondition,
  steps: [
    {
      name: "Frame 1 — organization bootstrap outranks hosted update bundle",
      run: async (ctx) => {
        await ctx.prove("The real desktop bootstrap precedence keeps the organization server URL across canonical and legacy update paths", {
          voiceover: vo[0],
          assert: async () => {
            await expectBootstrapPrecedenceSurvives(ctx, {
              before: {
                serverUrl: ORG_URL,
                bundleServerUrl: HOSTED_URL,
                installedPath: "canonical",
              },
              after: { serverUrl: ORG_URL },
            });
            await expectBootstrapPrecedenceSurvives(ctx, {
              before: {
                serverUrl: ORG_URL,
                bundleServerUrl: HOSTED_URL,
                installedPath: "legacy",
              },
              after: { serverUrl: ORG_URL },
            });
          },
        });
      },
    },
  ],
};
