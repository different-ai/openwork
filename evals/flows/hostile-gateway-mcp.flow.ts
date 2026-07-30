import { defineFlow } from "../runner/flow.ts";
import { hostileGatewayBunPrecondition, hostileGatewayFaultCases, probeHostileGatewayFault } from "../runner/journeys/gateway.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "hostile-gateway-mcp";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error("Missing approved voice-over script for hostile-gateway-mcp.");

export default defineFlow({
  id: FLOW_ID,
  title: "Hostile gateway MCP failures stay diagnosable without launching the app",
  kind: "internal",
  requiresApp: false,
  precondition: () => hostileGatewayBunPrecondition(),
  steps: hostileGatewayFaultCases.map((faultCase, index) => ({
    name: faultCase.faultId,
    run: async (ctx) => {
      await ctx.prove(faultCase.claim, {
        voiceover: vo[index] ?? faultCase.claim,
        action: async () => {
          const evidence = await probeHostileGatewayFault(ctx, faultCase);
          ctx.output(`${faultCase.faultId}-summary`, `${evidence.message}\n${evidence.behavior}\n${evidence.actionableImmediately}`);
        },
      });
    },
  })),
});
