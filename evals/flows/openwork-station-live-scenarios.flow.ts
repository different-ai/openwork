import { defineFlow, type FlowContext } from "../runner/flow.ts";

type ScenarioResult = {
  ok?: boolean;
  source?: string | null;
  suggestions?: Array<{
    kind?: string;
    title?: string;
    sources?: Array<{ provider?: string }>;
    action?: { kind?: string };
  }>;
  error?: string | null;
};

function readResult(value: unknown): ScenarioResult {
  return typeof value === "object" && value !== null ? value as ScenarioResult : {};
}

function summarize(result: ScenarioResult) {
  return {
    ok: result.ok,
    source: result.source,
    error: result.error,
    suggestions: result.suggestions?.map((suggestion) => ({
      kind: suggestion.kind,
      title: suggestion.title,
      providers: suggestion.sources?.map((source) => source.provider),
      action: suggestion.action?.kind,
    })),
  };
}

async function scan(
  ctx: FlowContext,
  name: string,
  transcript: string,
) {
  const result = readResult(await ctx.control("station.scan_scenario", { transcript }));
  ctx.output(name, JSON.stringify(summarize(result), null, 2));
  ctx.assert(result.ok === true, `${name} completed without an analysis error`);
  ctx.assert(
    Array.isArray(result.suggestions) && result.suggestions.length > 0,
    `${name} produced at least one contextual suggestion`,
  );
  return result;
}

export default defineFlow({
  id: "openwork-station-live-scenarios",
  title: "OpenWork Station scans realistic conversation scenarios through the live runtime",
  kind: "internal",
  steps: [
    {
      name: "Recall a participant’s earlier concern",
      run: async (ctx) => {
        await scan(
          ctx,
          "Connected recollection scan",
          "I’m speaking with Maya in today’s product call. Maya asks: do you remember the concern I shared last week about retaining customer transcripts? Find the most relevant earlier context and show me where it came from.",
        );
      },
    },
    {
      name: "Prepare a cross-time-zone meeting",
      run: async (ctx) => {
        const result = await scan(
          ctx,
          "Cross-time-zone scheduling scan",
          "Maya and I agreed to meet next Tuesday at 2 PM in Denver for thirty minutes. I am in Berlin. Prepare the meeting details for review, include both local times, and do not create or send an invitation.",
        );
        ctx.assert(
          result.suggestions?.some((suggestion) => suggestion.kind === "calendar") === true,
          "Scheduling produced a calendar suggestion",
        );
      },
    },
    {
      name: "Prepare a promised follow-up",
      run: async (ctx) => {
        const result = await scan(
          ctx,
          "Follow-up commitment scan",
          "I just promised Maya that I would email her after this call with the transcript-retention decision and the date of our next review. Prepare that follow-up for me, but leave sending entirely under my control.",
        );
        ctx.assert(
          result.suggestions?.some((suggestion) => (
            suggestion.kind === "follow_up" && suggestion.action?.kind === "review_draft"
          )) === true,
          "The commitment produced a review-only follow-up draft",
        );
      },
    },
  ],
});
