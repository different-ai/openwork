import { defineFlow, type FlowContext } from "../runner/flow.ts";

type LifecycleObservation = {
  name?: string;
  model?: string;
  tool?: string;
  resultCategory?: string;
};

type StationScenarioStatus = {
  scenario?: {
    id?: string;
    status?: string;
    mode?: string;
    simulator?: string | null;
    observedEvents?: LifecycleObservation[];
    error?: string | null;
  } | null;
  runtime?: { phase?: string };
  listening?: boolean;
  audioEnergy?: number;
  source?: string | null;
  suggestionCount?: number;
  suggestionKinds?: string[];
  sourceProviders?: string[];
  reviewOnly?: boolean;
  transcript?: {
    completedCharacters?: number;
    partialCharacters?: number;
  };
  error?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readStatus(value: unknown): StationScenarioStatus {
  return typeof value === "object" && value !== null ? value as StationScenarioStatus : {};
}

async function waitForScenario(
  ctx: FlowContext,
  scenarioId: string,
  terminalStatuses: string[],
  timeoutMs = 90_000,
) {
  const startedAt = Date.now();
  let latest: StationScenarioStatus = {};
  while (Date.now() - startedAt < timeoutMs) {
    latest = readStatus(await ctx.control("station.scenario.status"));
    if (latest.scenario?.id === scenarioId && terminalStatuses.includes(latest.scenario.status ?? "")) {
      return latest;
    }
    await sleep(750);
  }
  throw new Error(
    `Timed out waiting for Station scenario ${scenarioId}: ${JSON.stringify(latest)}`,
  );
}

export default defineFlow({
  id: "openwork-station-realtime-audio",
  title: "OpenWork Station hears real audio and surfaces connected context without taking action",
  kind: "user-facing",
  steps: [
    {
      name: "Run the real Realtime audio path",
      run: async (ctx) => {
        if (await ctx.hasText("Back to app")) {
          await ctx.clickText("Back to app");
          await sleep(750);
        }
        const started = readStatus(await ctx.control("station.scenario.run", {
          scenarioId: "maya-memory",
          playbackSpeed: 1,
          realInference: true,
          resetBeforeRun: true,
          stopAfterRun: false,
        }));
        ctx.output("Scenario start", JSON.stringify(started, null, 2));
        const status = await waitForScenario(ctx, "maya-memory", ["completed", "failed"]);
        ctx.output("Sanitized final lifecycle", JSON.stringify(status, null, 2));
        ctx.assert(status.scenario?.status === "completed", status.scenario?.error
          ? `The real-audio scenario completed: ${status.scenario.error}`
          : "The real-audio scenario completed");
        ctx.assert(status.scenario?.mode === "real-inference", "The scenario used real inference");
        ctx.assert(
          status.scenario?.simulator === "development-mcp",
          "Connected records came from the clearly labeled development MCP simulator",
        );
        ctx.assert(status.source === "development-mcp", "Suggestions report their development MCP source");
        ctx.assert(status.reviewOnly === true, "Every surfaced action remains review-only");
        ctx.assert((status.suggestionCount ?? 0) > 0, "Station surfaced useful context");
        ctx.assert(
          status.suggestionKinds?.includes("memory") === true,
          "The recalled context is represented as memory",
        );
        ctx.assert(
          status.sourceProviders?.includes("Development Slack") === true,
          "The memory cites its connected Development Slack record",
        );
        ctx.assert(
          (status.transcript?.completedCharacters ?? 0) > 0,
          "Realtime produced a genuine transcription",
        );

        const events = status.scenario?.observedEvents ?? [];
        const names = events.map((event) => event.name);
        for (const required of [
          "station.realtime.secret_requested",
          "station.realtime.connected",
          "station.realtime.speech_started",
          "station.realtime.transcript_completed",
          "station.realtime.response_started",
          "station.realtime.tool_requested",
          "station.realtime.tool_started",
          "station.mcp.discovery_started",
          "station.mcp.discovery_completed",
          "station.suggestions_published",
          "station.realtime.tool_completed",
        ]) {
          ctx.assert(names.includes(required), `Observed ${required}`);
        }
        ctx.assert(
          events.some((event) => (
            event.name === "station.realtime.connected" && typeof event.model === "string"
          )),
          "The lifecycle records the selected Realtime model",
        );
        ctx.assert(
          events.some((event) => (
            event.name === "station.realtime.tool_started"
            && event.tool === "research_current_context"
          )),
          "The Realtime model requested the local research handler",
        );
      },
    },
    {
      name: "Reveal one discreet sourced card",
      run: async (ctx) => {
        ctx.assert(Boolean(ctx.cdpBaseUrl), "The native Station surface exposes a CDP target");
        await ctx.control("station.mode.set", { active: true });
        await sleep(280);
        await ctx.screenshot("realtime-connected-context", {
          targetUrlIncludes: "station.html",
          pretty: true,
          claim: "Active mode slides one sourced suggestion from behind the compact Station pill.",
          voiceover: "Station stayed quiet while the meeting unfolded. Command Shift Space reveals the highest-priority cited card and its keyboard handoff without sending or changing anything.",
          requireText: ["Development Slack", "Not now", "Start thread"],
          rejectText: [
            "Why now",
            "OPENAI_API_KEY",
            "Your passive AI right hand",
            "Ambient agent active",
          ],
        });
      },
    },
    {
      name: "Stop immediately and keep the result reviewable",
      run: async (ctx) => {
        await ctx.control("station.stop");
        const status = readStatus(await ctx.control("station.scenario.status"));
        ctx.output("Stopped state", JSON.stringify(status, null, 2));
        ctx.assert(status.listening === false, "Station stops listening immediately");
        ctx.assert(status.audioEnergy === 0, "The media energy meter returns to zero");
        ctx.assert(status.runtime?.phase === "stopped", "Late async work cannot reopen the stopped run");
        ctx.assert((status.suggestionCount ?? 0) > 0, "The useful result remains available for review");
        ctx.assert(
          status.scenario?.observedEvents?.some((event) => (
            event.name === "station.realtime.stopped"
          )) === true,
          "The sanitized lifecycle records session closure",
        );
        await ctx.control("station.mode.set", { active: false });
      },
    },
  ],
});
