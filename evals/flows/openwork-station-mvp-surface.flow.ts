import { defineFlow } from "../runner/flow.ts";
import { connect, debuggerUrlFor, evaluate, listTargets } from "../runner/cdp.ts";

async function pinFirstStationBubble(cdpBaseUrl: string) {
  const target = (await listTargets(cdpBaseUrl)).find((entry) => (
    entry.type === "page" && entry.url.includes("station.html") && entry.webSocketDebuggerUrl
  ));
  if (!target) throw new Error("OpenWork Station CDP target is unavailable.");
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  try {
    return await evaluate(
      client,
      "(() => { const bubble = document.querySelector('.station-bubbles button'); if (!bubble) return false; bubble.click(); return true; })()",
    );
  } finally {
    client.close();
  }
}

export default defineFlow({
  id: "openwork-station-mvp-surface",
  title: "OpenWork Station deals one contextual card from behind its living rail",
  kind: "internal",
  steps: [
    {
      name: "Deal the selected context from the rail",
      run: async (ctx) => {
        await ctx.control("station.seed_demo", { stage: "living" });
        const state = await ctx.control("station.status");
        ctx.assert(
          typeof state === "object"
            && state !== null
            && Reflect.get(state, "selectedId") === "station-demo-memory",
          "The highest-relevance bubble remains selected while the surface grows",
        );
        ctx.assert(Boolean(ctx.cdpBaseUrl), "The Station surface has a CDP endpoint");
        await pinFirstStationBubble(ctx.cdpBaseUrl!);
        await new Promise((resolve) => setTimeout(resolve, 360));
        await ctx.screenshot("single-card-from-rail", {
          targetUrlIncludes: "station.html",
          pretty: true,
          requireText: [
            "Maya’s launch concern from last week",
            "Why now",
            "Open Slack message",
          ],
          rejectText: [
            "Your passive AI right hand",
            "Ambient agent active",
          ],
        });
      },
    },
  ],
});
